use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const MIB: u64 = 1024 * 1024;
pub const GIB: u64 = 1024 * MIB;

pub const RUN_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
pub const RUN_SOFT_BUDGET: u64 = 2 * GIB;
pub const ELECTRON_CACHE_SOFT_BUDGET: u64 = 512 * MIB;
pub const REBUILDABLE_BACKEND_CACHE_SOFT_BUDGET: u64 = 256 * MIB;
pub const LOG_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);

pub fn reserve_bytes(volume_bytes: u64) -> u64 {
    (volume_bytes / 20).clamp(GIB, 5 * GIB)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VolumeStats {
    pub capacity_bytes: u64,
    pub available_bytes: u64,
}

pub trait VolumeStatsProvider: Send + Sync {
    fn stats_for(&self, storage_root: &Path) -> io::Result<VolumeStats>;
}

#[derive(Debug, Clone, Copy, Default)]
struct Fs2VolumeStatsProvider;

impl VolumeStatsProvider for Fs2VolumeStatsProvider {
    fn stats_for(&self, storage_root: &Path) -> io::Result<VolumeStats> {
        let probe = existing_ancestor(storage_root)?;
        Ok(VolumeStats {
            capacity_bytes: fs2::total_space(probe)?,
            available_bytes: fs2::available_space(probe)?,
        })
    }
}

fn existing_ancestor(path: &Path) -> io::Result<&Path> {
    let mut candidate = Some(path);
    while let Some(path) = candidate {
        if path.try_exists()? {
            return Ok(path);
        }
        candidate = path.parent();
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "storage root has no existing ancestor",
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageWriteDecision {
    Allowed,
    CleanupRequired {
        reclaimable_bytes: u64,
    },
    Blocked {
        required_bytes: u64,
        available_bytes: u64,
        reserve_bytes: u64,
        reclaimable_bytes: u64,
    },
}

pub struct StorageWriteGuard {
    storage_root: PathBuf,
    provider: Arc<dyn VolumeStatsProvider>,
    reclaimable_bytes: u64,
}

impl StorageWriteGuard {
    pub fn new(storage_root: impl Into<PathBuf>) -> Self {
        Self::with_provider(storage_root, Arc::new(Fs2VolumeStatsProvider))
    }

    pub fn with_provider(
        storage_root: impl Into<PathBuf>,
        provider: Arc<dyn VolumeStatsProvider>,
    ) -> Self {
        Self {
            storage_root: storage_root.into(),
            provider,
            reclaimable_bytes: 0,
        }
    }

    pub fn with_reclaimable_bytes(mut self, reclaimable_bytes: u64) -> Self {
        self.reclaimable_bytes = reclaimable_bytes;
        self
    }

    pub fn check(&self, expected_bytes: u64) -> io::Result<StorageWriteDecision> {
        if expected_bytes == 0 {
            return Ok(StorageWriteDecision::Allowed);
        }

        let stats = self.provider.stats_for(&self.storage_root)?;
        let reserve_bytes = reserve_bytes(stats.capacity_bytes);
        let required_with_reserve = u128::from(expected_bytes) + u128::from(reserve_bytes);
        let available_bytes = u128::from(stats.available_bytes);

        if available_bytes >= required_with_reserve {
            return Ok(StorageWriteDecision::Allowed);
        }

        if self.reclaimable_bytes > 0
            && available_bytes + u128::from(self.reclaimable_bytes) >= required_with_reserve
        {
            return Ok(StorageWriteDecision::CleanupRequired {
                reclaimable_bytes: self.reclaimable_bytes,
            });
        }

        Ok(StorageWriteDecision::Blocked {
            required_bytes: expected_bytes,
            available_bytes: stats.available_bytes,
            reserve_bytes,
            reclaimable_bytes: self.reclaimable_bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_calculation_cannot_overflow() {
        assert_eq!(reserve_bytes(u64::MAX), 5 * GIB);
    }
}
