use crate::agents::protocol::{FailureClass, TaskFailure};

pub const MAX_TRANSIENT_RETRIES: u32 = 2;
pub const BASE_TRANSIENT_RETRY_DELAY_MS: u64 = 250;
pub const MAX_TRANSIENT_RETRY_DELAY_MS: u64 = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureDisposition {
    Retry { attempt: u32, delay_ms: u64 },
    Coordinator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FailurePolicy {
    max_transient_retries: u32,
    base_delay_ms: u64,
    max_delay_ms: u64,
}

impl Default for FailurePolicy {
    fn default() -> Self {
        Self {
            max_transient_retries: MAX_TRANSIENT_RETRIES,
            base_delay_ms: BASE_TRANSIENT_RETRY_DELAY_MS,
            max_delay_ms: MAX_TRANSIENT_RETRY_DELAY_MS,
        }
    }
}

impl FailurePolicy {
    pub fn classify(&self, failure: &TaskFailure, completed_retries: u32) -> FailureDisposition {
        if failure.class != FailureClass::TransientInfrastructure
            || completed_retries >= self.max_transient_retries
        {
            return FailureDisposition::Coordinator;
        }

        let attempt = completed_retries + 1;
        let exponent = completed_retries.min(63);
        let multiplier = 1_u64.checked_shl(exponent).unwrap_or(u64::MAX);
        let delay_ms = self
            .base_delay_ms
            .saturating_mul(multiplier)
            .min(self.max_delay_ms);
        FailureDisposition::Retry { attempt, delay_ms }
    }
}
