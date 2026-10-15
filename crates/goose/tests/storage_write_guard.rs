use goose::storage::{
    StorageWriteDecision, StorageWriteGuard, VolumeStats, VolumeStatsProvider, GIB, MIB,
};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeVolumeStats {
    stats: VolumeStats,
    observed_roots: Arc<Mutex<Vec<PathBuf>>>,
}

impl FakeVolumeStats {
    fn new(capacity_bytes: u64, available_bytes: u64) -> Self {
        Self {
            stats: VolumeStats {
                capacity_bytes,
                available_bytes,
            },
            observed_roots: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl VolumeStatsProvider for FakeVolumeStats {
    fn stats_for(&self, storage_root: &Path) -> io::Result<VolumeStats> {
        self.observed_roots
            .lock()
            .unwrap()
            .push(storage_root.to_path_buf());
        Ok(self.stats)
    }
}

#[test]
fn blocks_when_write_would_cross_reserved_space() {
    let root = PathBuf::from("D:/isolated-codebuddy-home");
    let provider = FakeVolumeStats::new(100 * GIB, 4 * GIB);
    let observed = Arc::clone(&provider.observed_roots);
    let guard = StorageWriteGuard::with_provider(root.clone(), Arc::new(provider));

    assert_eq!(
        guard.check(512 * MIB).unwrap(),
        StorageWriteDecision::Blocked {
            required_bytes: 512 * MIB,
            available_bytes: 4 * GIB,
            reserve_bytes: 5 * GIB,
            reclaimable_bytes: 0,
        }
    );
    assert_eq!(*observed.lock().unwrap(), vec![root]);
}

#[test]
fn allows_a_write_that_leaves_exactly_the_reserve() {
    let guard = StorageWriteGuard::with_provider(
        PathBuf::from("D:/isolated-codebuddy-home"),
        Arc::new(FakeVolumeStats::new(100 * GIB, 6 * GIB)),
    );

    assert_eq!(guard.check(GIB).unwrap(), StorageWriteDecision::Allowed);
}

#[test]
fn asks_for_cleanup_only_when_policy_safe_reclaimable_bytes_would_make_room() {
    let guard = StorageWriteGuard::with_provider(
        PathBuf::from("D:/isolated-codebuddy-home"),
        Arc::new(FakeVolumeStats::new(100 * GIB, 5 * GIB)),
    )
    .with_reclaimable_bytes(2 * GIB);

    assert_eq!(
        guard.check(GIB).unwrap(),
        StorageWriteDecision::CleanupRequired {
            reclaimable_bytes: 2 * GIB,
        }
    );
}

#[test]
fn reports_blocked_when_cleanup_still_cannot_preserve_the_reserve() {
    let guard = StorageWriteGuard::with_provider(
        PathBuf::from("D:/isolated-codebuddy-home"),
        Arc::new(FakeVolumeStats::new(100 * GIB, 4 * GIB)),
    )
    .with_reclaimable_bytes(512 * MIB);

    assert_eq!(
        guard.check(GIB).unwrap(),
        StorageWriteDecision::Blocked {
            required_bytes: GIB,
            available_bytes: 4 * GIB,
            reserve_bytes: 5 * GIB,
            reclaimable_bytes: 512 * MIB,
        }
    );
}

#[test]
fn zero_byte_checks_do_not_block_non_writes() {
    let guard = StorageWriteGuard::with_provider(
        PathBuf::from("D:/isolated-codebuddy-home"),
        Arc::new(FakeVolumeStats::new(100 * GIB, 0)),
    );

    assert_eq!(guard.check(0).unwrap(), StorageWriteDecision::Allowed);
}
