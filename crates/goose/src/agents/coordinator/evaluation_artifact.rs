use super::{
    CoordinatorEvaluationObservation, CoordinatorEvaluationReport, CoordinatorEvaluationSuite,
    CoordinatorQualificationEvaluator, QualificationKey, QualificationRecord,
    QualificationRegistryDocument, QualificationRegistryError, QualificationStatus,
    QualifiedCoordinatorMode,
};
use crate::utils::bytes_to_hex;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const QUALIFICATION_EVIDENCE_SCHEMA_VERSION: u16 = 1;
pub const OBSERVATION_FILE_SCHEMA_VERSION: u16 = 1;
const MAX_OBSERVATION_BYTES: usize = 8 * 1024 * 1024;
const MAX_VALIDITY_DAYS: i64 = 31;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationSource {
    Live,
    Synthetic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorObservationFile {
    pub schema_version: u16,
    pub source: ObservationSource,
    pub observations: Vec<CoordinatorEvaluationObservation>,
}

impl CoordinatorObservationFile {
    pub fn from_slice(bytes: &[u8]) -> Result<Self, QualificationArtifactError> {
        if bytes.len() > MAX_OBSERVATION_BYTES {
            return Err(QualificationArtifactError::ObservationsTooLarge);
        }
        let file: Self = serde_json::from_slice(bytes)?;
        if file.schema_version != OBSERVATION_FILE_SCHEMA_VERSION {
            return Err(QualificationArtifactError::UnsupportedObservationSchema(
                file.schema_version,
            ));
        }
        Ok(file)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationEvidenceArtifact {
    pub schema_version: u16,
    pub key: QualificationKey,
    pub evaluated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub source: ObservationSource,
    pub suite_sha256: String,
    pub observations_sha256: String,
    pub report: CoordinatorEvaluationReport,
    pub maximum_mode: QualifiedCoordinatorMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledQualificationEvidence {
    pub artifact: QualificationEvidenceArtifact,
    pub artifact_bytes: Vec<u8>,
    pub artifact_sha256: String,
    pub record: QualificationRecord,
    pub registry: QualificationRegistryDocument,
}

pub struct QualificationEvidenceCompiler;

impl QualificationEvidenceCompiler {
    pub fn compile(
        suite_bytes: &[u8],
        observation_bytes: &[u8],
        key: QualificationKey,
        evaluated_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> Result<CompiledQualificationEvidence, QualificationArtifactError> {
        let suite = CoordinatorEvaluationSuite::from_slice(suite_bytes)?;
        let observations = CoordinatorObservationFile::from_slice(observation_bytes)?;
        validate_identity(&suite, &key, evaluated_at, expires_at)?;
        let report =
            CoordinatorQualificationEvaluator::evaluate(&suite, &observations.observations)?;
        let maximum_mode = match observations.source {
            ObservationSource::Live => report.maximum_mode,
            ObservationSource::Synthetic => QualifiedCoordinatorMode::Shadow,
        };
        let artifact = QualificationEvidenceArtifact {
            schema_version: QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
            key: key.clone(),
            evaluated_at,
            expires_at,
            source: observations.source,
            suite_sha256: sha256(suite_bytes),
            observations_sha256: sha256(observation_bytes),
            report,
            maximum_mode,
        };
        let mut artifact_bytes = serde_json::to_vec_pretty(&artifact)?;
        artifact_bytes.push(b'\n');
        let artifact_sha256 = sha256(&artifact_bytes);
        let status = match maximum_mode {
            QualifiedCoordinatorMode::Authoritative => QualificationStatus::Passed,
            QualifiedCoordinatorMode::Advisory => QualificationStatus::Advisory,
            QualifiedCoordinatorMode::Shadow => QualificationStatus::Failed,
        };
        let record = QualificationRecord {
            key,
            status,
            evaluated_at,
            expires_at,
            evidence_sha256: artifact_sha256.clone(),
        };
        let registry = QualificationRegistryDocument::new(vec![record.clone()])?;
        Ok(CompiledQualificationEvidence {
            artifact,
            artifact_bytes,
            artifact_sha256,
            record,
            registry,
        })
    }
}

fn validate_identity(
    suite: &CoordinatorEvaluationSuite,
    key: &QualificationKey,
    evaluated_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> Result<(), QualificationArtifactError> {
    key.validate()?;
    if key.protocol_version != suite.protocol_version
        || key.prompt_version != suite.prompt_version
        || key.evaluator_version != suite.evaluator_version
    {
        return Err(QualificationArtifactError::IdentityMismatch);
    }
    if expires_at <= evaluated_at || expires_at > evaluated_at + Duration::days(MAX_VALIDITY_DAYS) {
        return Err(QualificationArtifactError::InvalidValidity);
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    bytes_to_hex(Sha256::digest(bytes))
}

#[derive(Debug, thiserror::Error)]
pub enum QualificationArtifactError {
    #[error("qualification input JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("qualification suite is invalid: {0}")]
    Suite(#[from] super::EvaluationSuiteError),
    #[error("qualification observations are invalid: {0}")]
    Evaluation(#[from] super::CoordinatorEvaluationError),
    #[error("qualification registry record is invalid: {0}")]
    Registry(#[from] QualificationRegistryError),
    #[error("qualification observations exceed the size limit")]
    ObservationsTooLarge,
    #[error("unsupported qualification observation schema: {0}")]
    UnsupportedObservationSchema(u16),
    #[error("qualification key does not match suite protocol/prompt/evaluator identity")]
    IdentityMismatch,
    #[error("qualification validity window is invalid or exceeds 31 days")]
    InvalidValidity,
}
