#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RevisionError {
    #[error("initial plan revision must be 1, actual {0}")]
    InvalidInitial(u32),
    #[error("plan revision must advance from {current} to {expected}, actual {actual}")]
    InvalidNext {
        current: u32,
        expected: u32,
        actual: u32,
    },
    #[error("plan revision overflowed")]
    Overflow,
}

pub fn validate_plan_revision(current: Option<u32>, candidate: u32) -> Result<(), RevisionError> {
    let Some(current) = current else {
        return if candidate == 1 {
            Ok(())
        } else {
            Err(RevisionError::InvalidInitial(candidate))
        };
    };
    let expected = current.checked_add(1).ok_or(RevisionError::Overflow)?;
    if candidate == expected {
        Ok(())
    } else {
        Err(RevisionError::InvalidNext {
            current,
            expected,
            actual: candidate,
        })
    }
}
