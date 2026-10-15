use super::{QualificationAssessment, QualificationKey, QualificationRegistry};
use crate::agents::protocol::{CoordinatorMode, CoordinatorQualificationResult};
use chrono::{DateTime, Utc};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct CoordinatorRunPolicy {
    inner: Arc<RunPolicyState>,
}

#[derive(Debug)]
struct RunPolicyState {
    requested_mode: CoordinatorMode,
    qualification: CoordinatorQualificationResult,
    qualification_key: Option<QualificationKey>,
    effective_mode: AtomicU8,
    generation: AtomicU64,
}

impl CoordinatorRunPolicy {
    pub fn snapshot<R: QualificationRegistry>(
        requested_mode: CoordinatorMode,
        qualification_key: Option<QualificationKey>,
        registry: &R,
        now: DateTime<Utc>,
    ) -> Self {
        let assessment = if matches!(
            requested_mode,
            CoordinatorMode::Advisory | CoordinatorMode::Authoritative
        ) {
            qualification_key.as_ref().map_or(
                QualificationAssessment {
                    result: CoordinatorQualificationResult::Missing,
                    maximum_mode: CoordinatorMode::Shadow,
                },
                |key| registry.assess(key, now),
            )
        } else {
            QualificationAssessment {
                result: CoordinatorQualificationResult::NotRequired,
                maximum_mode: requested_mode,
            }
        };
        let qualification = assessment.result;
        let effective_mode =
            mode_from_rank(mode_rank(requested_mode).min(mode_rank(assessment.maximum_mode)));
        Self {
            inner: Arc::new(RunPolicyState {
                requested_mode,
                qualification,
                qualification_key,
                effective_mode: AtomicU8::new(mode_rank(effective_mode)),
                generation: AtomicU64::new(0),
            }),
        }
    }

    pub fn requested_mode(&self) -> CoordinatorMode {
        self.inner.requested_mode
    }

    pub fn effective_mode(&self) -> CoordinatorMode {
        mode_from_rank(self.inner.effective_mode.load(Ordering::Acquire))
    }

    pub fn qualification(&self) -> CoordinatorQualificationResult {
        self.inner.qualification
    }

    pub fn qualification_key(&self) -> Option<&QualificationKey> {
        self.inner.qualification_key.as_ref()
    }

    pub fn rollback_to(&self, target: CoordinatorMode) -> Result<(), RollbackError> {
        if !matches!(target, CoordinatorMode::Off | CoordinatorMode::Shadow) {
            return Err(RollbackError::InvalidTarget(target));
        }
        let target_rank = mode_rank(target);
        loop {
            let current = self.inner.effective_mode.load(Ordering::Acquire);
            if target_rank > current {
                return Err(RollbackError::CannotRaise {
                    current: mode_from_rank(current),
                    requested: target,
                });
            }
            if target_rank == current {
                return Ok(());
            }
            if self
                .inner
                .effective_mode
                .compare_exchange(current, target_rank, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                self.inner.generation.fetch_add(1, Ordering::AcqRel);
                return Ok(());
            }
        }
    }

    pub fn authorization_stamp(&self) -> Option<AuthoritativeAuthorizationStamp> {
        (self.effective_mode() == CoordinatorMode::Authoritative).then(|| {
            AuthoritativeAuthorizationStamp {
                generation: self.inner.generation.load(Ordering::Acquire),
            }
        })
    }

    pub fn is_authorized(&self, stamp: AuthoritativeAuthorizationStamp) -> bool {
        self.effective_mode() == CoordinatorMode::Authoritative
            && self.inner.generation.load(Ordering::Acquire) == stamp.generation
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthoritativeAuthorizationStamp {
    generation: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RollbackError {
    #[error("rollback target must be off or shadow, got {0:?}")]
    InvalidTarget(CoordinatorMode),
    #[error("coordinator mode cannot be raised from {current:?} to {requested:?} during a run")]
    CannotRaise {
        current: CoordinatorMode,
        requested: CoordinatorMode,
    },
}

const fn mode_rank(mode: CoordinatorMode) -> u8 {
    match mode {
        CoordinatorMode::Off => 0,
        CoordinatorMode::Shadow => 1,
        CoordinatorMode::Advisory => 2,
        CoordinatorMode::Authoritative => 3,
    }
}

const fn mode_from_rank(rank: u8) -> CoordinatorMode {
    match rank {
        0 => CoordinatorMode::Off,
        1 => CoordinatorMode::Shadow,
        2 => CoordinatorMode::Advisory,
        3 => CoordinatorMode::Authoritative,
        _ => CoordinatorMode::Off,
    }
}
