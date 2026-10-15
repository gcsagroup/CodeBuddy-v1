use crate::agents::protocol::{CoordinatorMode, CoordinatorQualificationResult, ProtocolVersion};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const QUALIFICATION_REGISTRY_SCHEMA_VERSION: u16 = 2;
const MAX_REGISTRY_BYTES: u64 = 1_048_576;
const MAX_RECORDS: usize = 512;
const MAX_KEY_COMPONENT_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationKey {
    pub provider: String,
    pub model: String,
    pub reasoning_level: String,
    pub protocol_version: ProtocolVersion,
    pub prompt_version: String,
    pub evaluator_version: String,
}

impl QualificationKey {
    pub fn validate(&self) -> Result<(), QualificationRegistryError> {
        for (field, value) in [
            ("provider", &self.provider),
            ("model", &self.model),
            ("reasoning_level", &self.reasoning_level),
            ("prompt_version", &self.prompt_version),
            ("evaluator_version", &self.evaluator_version),
        ] {
            if value.trim().is_empty() || value.len() > MAX_KEY_COMPONENT_BYTES {
                return Err(QualificationRegistryError::InvalidKey(field));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationStatus {
    Passed,
    Advisory,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationRecord {
    pub key: QualificationKey,
    pub status: QualificationStatus,
    pub evaluated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub evidence_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QualificationAssessment {
    pub result: CoordinatorQualificationResult,
    pub maximum_mode: CoordinatorMode,
}

pub trait QualificationRegistry: Send + Sync {
    fn assess(&self, key: &QualificationKey, now: DateTime<Utc>) -> QualificationAssessment;

    fn evaluate(
        &self,
        key: &QualificationKey,
        now: DateTime<Utc>,
    ) -> CoordinatorQualificationResult {
        self.assess(key, now).result
    }
}

#[derive(Debug, Clone, Default)]
pub struct InMemoryQualificationRegistry {
    records: Vec<QualificationRecord>,
}

impl InMemoryQualificationRegistry {
    pub fn new(records: Vec<QualificationRecord>) -> Result<Self, QualificationRegistryError> {
        validate_records(&records)?;
        Ok(Self { records })
    }
}

impl QualificationRegistry for InMemoryQualificationRegistry {
    fn assess(&self, key: &QualificationKey, now: DateTime<Utc>) -> QualificationAssessment {
        evaluate_records(&self.records, key, now)
    }
}

#[derive(Debug, Clone)]
pub struct FileQualificationRegistry {
    path: PathBuf,
    records: Vec<QualificationRecord>,
}

impl FileQualificationRegistry {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, QualificationRegistryError> {
        let path = path.as_ref().to_path_buf();
        let metadata =
            std::fs::metadata(&path).map_err(|source| QualificationRegistryError::Io {
                path: path.clone(),
                source,
            })?;
        if metadata.len() > MAX_REGISTRY_BYTES {
            return Err(QualificationRegistryError::TooLarge {
                actual: metadata.len(),
                maximum: MAX_REGISTRY_BYTES,
            });
        }
        let bytes = std::fs::read(&path).map_err(|source| QualificationRegistryError::Io {
            path: path.clone(),
            source,
        })?;
        let file: QualificationRegistryDocument = serde_json::from_slice(&bytes)?;
        if file.schema_version != QUALIFICATION_REGISTRY_SCHEMA_VERSION {
            return Err(QualificationRegistryError::UnsupportedSchema(
                file.schema_version,
            ));
        }
        validate_records(&file.records)?;
        Ok(Self {
            path,
            records: file.records,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl QualificationRegistry for FileQualificationRegistry {
    fn assess(&self, key: &QualificationKey, now: DateTime<Utc>) -> QualificationAssessment {
        evaluate_records(&self.records, key, now)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationRegistryDocument {
    pub schema_version: u16,
    pub records: Vec<QualificationRecord>,
}

impl QualificationRegistryDocument {
    pub fn new(records: Vec<QualificationRecord>) -> Result<Self, QualificationRegistryError> {
        validate_records(&records)?;
        Ok(Self {
            schema_version: QUALIFICATION_REGISTRY_SCHEMA_VERSION,
            records,
        })
    }
}

fn validate_records(records: &[QualificationRecord]) -> Result<(), QualificationRegistryError> {
    if records.len() > MAX_RECORDS {
        return Err(QualificationRegistryError::TooManyRecords {
            actual: records.len(),
            maximum: MAX_RECORDS,
        });
    }
    let mut keys = BTreeSet::new();
    for record in records {
        record.key.validate()?;
        if record.expires_at <= record.evaluated_at {
            return Err(QualificationRegistryError::InvalidExpiry);
        }
        if record.evidence_sha256.len() != 64
            || !record
                .evidence_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(QualificationRegistryError::InvalidEvidenceDigest);
        }
        if !keys.insert(record.key.clone()) {
            return Err(QualificationRegistryError::DuplicateKey);
        }
    }
    Ok(())
}

fn evaluate_records(
    records: &[QualificationRecord],
    key: &QualificationKey,
    now: DateTime<Utc>,
) -> QualificationAssessment {
    let Some(record) = records.iter().find(|record| &record.key == key) else {
        return QualificationAssessment {
            result: CoordinatorQualificationResult::Missing,
            maximum_mode: CoordinatorMode::Shadow,
        };
    };
    if record.expires_at <= now {
        QualificationAssessment {
            result: CoordinatorQualificationResult::Expired,
            maximum_mode: CoordinatorMode::Shadow,
        }
    } else {
        match record.status {
            QualificationStatus::Passed => QualificationAssessment {
                result: CoordinatorQualificationResult::Qualified,
                maximum_mode: CoordinatorMode::Authoritative,
            },
            QualificationStatus::Advisory => QualificationAssessment {
                result: CoordinatorQualificationResult::Failed,
                maximum_mode: CoordinatorMode::Advisory,
            },
            QualificationStatus::Failed => QualificationAssessment {
                result: CoordinatorQualificationResult::Failed,
                maximum_mode: CoordinatorMode::Shadow,
            },
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum QualificationRegistryError {
    #[error("qualification registry I/O failed at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("qualification registry JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported qualification registry schema: {0}")]
    UnsupportedSchema(u16),
    #[error("qualification registry exceeds size limit: {actual} > {maximum}")]
    TooLarge { actual: u64, maximum: u64 },
    #[error("qualification registry exceeds record limit: {actual} > {maximum}")]
    TooManyRecords { actual: usize, maximum: usize },
    #[error("qualification key contains invalid {0}")]
    InvalidKey(&'static str),
    #[error("qualification record expiry must be after evaluation time")]
    InvalidExpiry,
    #[error("qualification record evidence digest must be lowercase SHA-256")]
    InvalidEvidenceDigest,
    #[error("qualification registry contains a duplicate exact key")]
    DuplicateKey,
}
