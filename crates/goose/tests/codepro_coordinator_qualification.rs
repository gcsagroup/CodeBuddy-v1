use chrono::{DateTime, Duration, Utc};
use goose::agents::coordinator::{
    CoordinatorRunPolicy, FileQualificationRegistry, InMemoryQualificationRegistry,
    QualificationKey, QualificationRecord, QualificationRegistry, QualificationRegistryError,
    QualificationStatus, RollbackError, QUALIFICATION_REGISTRY_SCHEMA_VERSION,
};
use goose::agents::protocol::{CoordinatorMode, CoordinatorQualificationResult, ProtocolVersion};

fn now() -> DateTime<Utc> {
    "2026-08-05T12:00:00Z".parse().unwrap()
}

fn key() -> QualificationKey {
    QualificationKey {
        provider: "openai".into(),
        model: "gpt-codepro".into(),
        reasoning_level: "high".into(),
        protocol_version: ProtocolVersion::CURRENT,
        prompt_version: "codepro-coordinator-v1".into(),
        evaluator_version: "eval-2026-08-05".into(),
    }
}

fn record(status: QualificationStatus, expires_at: DateTime<Utc>) -> QualificationRecord {
    QualificationRecord {
        key: key(),
        status,
        evaluated_at: now() - Duration::days(1),
        expires_at,
        evidence_sha256: "a".repeat(64),
    }
}

#[test]
fn qualification_requires_an_exact_six_part_key() {
    let registry = InMemoryQualificationRegistry::new(vec![record(
        QualificationStatus::Passed,
        now() + Duration::days(30),
    )])
    .unwrap();
    assert_eq!(
        registry.evaluate(&key(), now()),
        CoordinatorQualificationResult::Qualified
    );

    let mut variants = Vec::new();
    let mut provider = key();
    provider.provider = "azure".into();
    variants.push(provider);
    let mut model = key();
    model.model = "other-model".into();
    variants.push(model);
    let mut reasoning = key();
    reasoning.reasoning_level = "medium".into();
    variants.push(reasoning);
    let mut protocol = key();
    protocol.protocol_version = ProtocolVersion::V1;
    variants.push(protocol);
    let mut prompt = key();
    prompt.prompt_version = "older-prompt".into();
    variants.push(prompt);
    let mut evaluator = key();
    evaluator.evaluator_version = "older-eval".into();
    variants.push(evaluator);

    for variant in variants {
        assert_eq!(
            registry.evaluate(&variant, now()),
            CoordinatorQualificationResult::Missing
        );
    }
}

#[test]
fn failed_and_expired_qualifications_never_authorize() {
    let failed = InMemoryQualificationRegistry::new(vec![record(
        QualificationStatus::Failed,
        now() + Duration::days(1),
    )])
    .unwrap();
    assert_eq!(
        failed.evaluate(&key(), now()),
        CoordinatorQualificationResult::Failed
    );

    let expired =
        InMemoryQualificationRegistry::new(vec![record(QualificationStatus::Passed, now())])
            .unwrap();
    assert_eq!(
        expired.evaluate(&key(), now()),
        CoordinatorQualificationResult::Expired
    );
}

#[test]
fn authoritative_policy_falls_back_to_shadow_without_exact_qualification() {
    let registry = InMemoryQualificationRegistry::default();
    let missing = CoordinatorRunPolicy::snapshot(
        CoordinatorMode::Authoritative,
        Some(key()),
        &registry,
        now(),
    );
    assert_eq!(missing.requested_mode(), CoordinatorMode::Authoritative);
    assert_eq!(missing.effective_mode(), CoordinatorMode::Shadow);
    assert_eq!(
        missing.qualification(),
        CoordinatorQualificationResult::Missing
    );
    assert!(missing.authorization_stamp().is_none());
}

#[test]
fn advisory_evidence_caps_authoritative_request_at_advisory() {
    let registry = InMemoryQualificationRegistry::new(vec![record(
        QualificationStatus::Advisory,
        now() + Duration::days(30),
    )])
    .unwrap();
    let policy = CoordinatorRunPolicy::snapshot(
        CoordinatorMode::Authoritative,
        Some(key()),
        &registry,
        now(),
    );

    assert_eq!(policy.effective_mode(), CoordinatorMode::Advisory);
    assert_eq!(
        policy.qualification(),
        CoordinatorQualificationResult::Failed
    );
    assert!(policy.authorization_stamp().is_none());
}

#[test]
fn advisory_request_without_exact_evidence_is_capped_at_shadow() {
    let policy = CoordinatorRunPolicy::snapshot(
        CoordinatorMode::Advisory,
        Some(key()),
        &InMemoryQualificationRegistry::default(),
        now(),
    );
    assert_eq!(policy.effective_mode(), CoordinatorMode::Shadow);
    assert_eq!(
        policy.qualification(),
        CoordinatorQualificationResult::Missing
    );
}

#[test]
fn run_policy_can_only_roll_back_and_invalidates_authorization_stamps() {
    let registry = InMemoryQualificationRegistry::new(vec![record(
        QualificationStatus::Passed,
        now() + Duration::days(30),
    )])
    .unwrap();
    let policy = CoordinatorRunPolicy::snapshot(
        CoordinatorMode::Authoritative,
        Some(key()),
        &registry,
        now(),
    );
    let stamp = policy.authorization_stamp().unwrap();
    assert!(policy.is_authorized(stamp));

    policy.rollback_to(CoordinatorMode::Shadow).unwrap();
    assert_eq!(policy.effective_mode(), CoordinatorMode::Shadow);
    assert!(!policy.is_authorized(stamp));
    assert!(matches!(
        policy.rollback_to(CoordinatorMode::Advisory),
        Err(RollbackError::InvalidTarget(CoordinatorMode::Advisory))
    ));
    policy.rollback_to(CoordinatorMode::Off).unwrap();
    assert!(matches!(
        policy.rollback_to(CoordinatorMode::Shadow),
        Err(RollbackError::CannotRaise { .. })
    ));
}

#[test]
fn file_registry_is_strict_read_only_and_rejects_duplicate_keys() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("qualifications.json");
    let record = serde_json::to_value(record(
        QualificationStatus::Passed,
        now() + Duration::days(30),
    ))
    .unwrap();
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": QUALIFICATION_REGISTRY_SCHEMA_VERSION,
            "records": [record.clone()]
        }))
        .unwrap(),
    )
    .unwrap();
    let registry = FileQualificationRegistry::load(&path).unwrap();
    assert_eq!(registry.path(), path);
    assert_eq!(
        registry.evaluate(&key(), now()),
        CoordinatorQualificationResult::Qualified
    );

    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": QUALIFICATION_REGISTRY_SCHEMA_VERSION,
            "records": [record.clone(), record]
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        FileQualificationRegistry::load(&path),
        Err(QualificationRegistryError::DuplicateKey)
    ));
}
