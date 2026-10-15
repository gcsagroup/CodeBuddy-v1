use goose::agents::coordinator::{
    AggregateMeasurement, CoordinatorEvaluationError, CoordinatorEvaluationObservation,
    CoordinatorEvaluationSuite, CoordinatorObservationFile, CoordinatorQualificationEvaluator,
    CriticalViolation, EvaluationAction, EvaluationCategory, EvaluationSuiteError,
    FileQualificationRegistry, ObservationSource, QualificationArtifactError,
    QualificationEvidenceCompiler, QualificationKey, QualificationRegistry, QualificationStatus,
    QualifiedCoordinatorMode, MIN_COORDINATOR_SCENARIOS, MIN_SAFETY_ATTEMPTS,
    OBSERVATION_FILE_SCHEMA_VERSION,
};
use goose::agents::protocol::ProtocolVersion;
use std::collections::BTreeSet;

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/coordinator/v1/suite.json")
}

#[test]
fn versioned_suite_meets_frozen_coverage_and_repetition_contract() {
    let suite = CoordinatorEvaluationSuite::load(fixture_path()).unwrap();
    assert_eq!(suite.protocol_version, ProtocolVersion::CURRENT);
    assert_eq!(suite.cases.len(), MIN_COORDINATOR_SCENARIOS);
    assert!(suite.safety_attempts() >= MIN_SAFETY_ATTEMPTS);
    assert!(suite.cases.iter().all(|case| case.repetitions >= 3));
    assert_eq!(
        suite
            .cases
            .iter()
            .map(|case| case.category)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            EvaluationCategory::Schema,
            EvaluationCategory::Planning,
            EvaluationCategory::FailureRecovery,
            EvaluationCategory::Permission,
            EvaluationCategory::Evidence,
            EvaluationCategory::Convergence,
            EvaluationCategory::Adversarial,
        ])
    );
}

#[test]
fn suite_thresholds_cannot_be_relaxed_by_editing_the_fixture() {
    let bytes = std::fs::read(fixture_path()).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["thresholds"]["schema_after_repair_basis_points"] = 9_800.into();
    assert!(matches!(
        CoordinatorEvaluationSuite::from_slice(&serde_json::to_vec(&value).unwrap()),
        Err(EvaluationSuiteError::ThresholdMismatch(_))
    ));
}

#[test]
fn duplicate_case_ids_and_insufficient_safety_attempts_fail_closed() {
    let bytes = std::fs::read(fixture_path()).unwrap();
    let mut duplicate: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    duplicate["cases"][1]["id"] = duplicate["cases"][0]["id"].clone();
    assert!(matches!(
        CoordinatorEvaluationSuite::from_slice(&serde_json::to_vec(&duplicate).unwrap()),
        Err(EvaluationSuiteError::DuplicateCase(_))
    ));

    let mut insufficient: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    for case in insufficient["cases"].as_array_mut().unwrap() {
        if case["safety_critical"] == true {
            case["repetitions"] = 3.into();
        }
    }
    assert!(matches!(
        CoordinatorEvaluationSuite::from_slice(&serde_json::to_vec(&insufficient).unwrap()),
        Err(EvaluationSuiteError::InsufficientSafetyAttempts { .. })
    ));
}

fn passing_observations(
    suite: &CoordinatorEvaluationSuite,
) -> Vec<CoordinatorEvaluationObservation> {
    let mut observations = Vec::new();
    for case in &suite.cases {
        for repetition in 1..=case.repetitions {
            observations.push(CoordinatorEvaluationObservation {
                case_id: case.id.clone(),
                repetition,
                schema_valid_initially: true,
                schema_valid_after_repair: true,
                selected_action: Some(case.expected_actions[0]),
                evidence_valid: true,
                false_completion: false,
                critical_violation: None,
                legacy_success: true,
                first_token_latency_ms: Some(100),
                total_latency_ms: Some(500),
                input_tokens: Some(200),
                output_tokens: Some(50),
                cost_micros: Some(25),
            });
        }
    }
    observations
}

#[test]
fn complete_safe_observations_qualify_authoritative_and_record_metrics() {
    let suite = CoordinatorEvaluationSuite::load(fixture_path()).unwrap();
    let report =
        CoordinatorQualificationEvaluator::evaluate(&suite, &passing_observations(&suite)).unwrap();

    assert_eq!(report.maximum_mode, QualifiedCoordinatorMode::Authoritative);
    assert!(report.blockers.is_empty());
    assert_eq!(report.schema_after_repair_basis_points, 10_000);
    assert_eq!(report.success_delta_lower_bound_basis_points, 0);
    assert_eq!(
        report.total_latency_p95_ms,
        AggregateMeasurement::Measured(500)
    );
    assert_eq!(
        report.total_tokens,
        AggregateMeasurement::Measured((200 + 50) * report.total_attempts as u64)
    );
}

#[test]
fn schema_or_comparative_regression_caps_result_at_advisory() {
    let suite = CoordinatorEvaluationSuite::load(fixture_path()).unwrap();
    let mut schema_failures = passing_observations(&suite);
    for observation in schema_failures.iter_mut().take(3) {
        observation.schema_valid_after_repair = false;
        observation.selected_action = None;
    }
    let schema_report =
        CoordinatorQualificationEvaluator::evaluate(&suite, &schema_failures).unwrap();
    assert_eq!(
        schema_report.maximum_mode,
        QualifiedCoordinatorMode::Advisory
    );
    assert!(schema_report
        .blockers
        .contains(&"schema_after_repair_below_authoritative_threshold".to_string()));

    let mut regression = passing_observations(&suite);
    for observation in regression.iter_mut().take(30) {
        observation.selected_action = Some(EvaluationAction::FailRun);
    }
    let regression_report =
        CoordinatorQualificationEvaluator::evaluate(&suite, &regression).unwrap();
    assert_eq!(
        regression_report.maximum_mode,
        QualifiedCoordinatorMode::Advisory
    );
    assert!(regression_report
        .blockers
        .contains(&"success_regression_confidence_bound".to_string()));
}

#[test]
fn one_critical_violation_forces_shadow_and_missing_metrics_stay_explicit() {
    let suite = CoordinatorEvaluationSuite::load(fixture_path()).unwrap();
    let mut observations = passing_observations(&suite);
    observations[0].critical_violation = Some(CriticalViolation::UnauthorizedAction);
    for observation in &mut observations {
        observation.first_token_latency_ms = None;
        observation.total_latency_ms = None;
        observation.input_tokens = None;
        observation.output_tokens = None;
        observation.cost_micros = None;
    }
    let report = CoordinatorQualificationEvaluator::evaluate(&suite, &observations).unwrap();
    assert_eq!(report.maximum_mode, QualifiedCoordinatorMode::Shadow);
    assert_eq!(report.critical_violations, 1);
    assert_eq!(
        report.first_token_latency_p95_ms,
        AggregateMeasurement::NotMeasured
    );
    assert_eq!(report.total_cost_micros, AggregateMeasurement::NotMeasured);
}

#[test]
fn incomplete_or_duplicate_observations_are_not_scored() {
    let suite = CoordinatorEvaluationSuite::load(fixture_path()).unwrap();
    let mut observations = passing_observations(&suite);
    observations.pop();
    assert!(matches!(
        CoordinatorQualificationEvaluator::evaluate(&suite, &observations),
        Err(CoordinatorEvaluationError::ObservationCount { .. })
    ));

    let mut duplicate = passing_observations(&suite);
    duplicate[1].case_id = duplicate[0].case_id.clone();
    duplicate[1].repetition = duplicate[0].repetition;
    assert!(matches!(
        CoordinatorQualificationEvaluator::evaluate(&suite, &duplicate),
        Err(CoordinatorEvaluationError::DuplicateObservation(_))
    ));
}

fn qualification_key(suite: &CoordinatorEvaluationSuite) -> QualificationKey {
    QualificationKey {
        provider: "ollama_cloud".to_string(),
        model: "candidate-model".to_string(),
        reasoning_level: "high".to_string(),
        protocol_version: suite.protocol_version,
        prompt_version: suite.prompt_version.clone(),
        evaluator_version: suite.evaluator_version.clone(),
    }
}

#[test]
fn compiler_binds_live_report_to_registry_digest_and_exact_key() {
    let suite_bytes = std::fs::read(fixture_path()).unwrap();
    let suite = CoordinatorEvaluationSuite::from_slice(&suite_bytes).unwrap();
    let observations = CoordinatorObservationFile {
        schema_version: OBSERVATION_FILE_SCHEMA_VERSION,
        source: ObservationSource::Live,
        observations: passing_observations(&suite),
    };
    let observation_bytes = serde_json::to_vec_pretty(&observations).unwrap();
    let evaluated_at = "2026-08-06T12:00:00Z".parse().unwrap();
    let expires_at = "2026-09-05T12:00:00Z".parse().unwrap();
    let compiled = QualificationEvidenceCompiler::compile(
        &suite_bytes,
        &observation_bytes,
        qualification_key(&suite),
        evaluated_at,
        expires_at,
    )
    .unwrap();

    assert_eq!(compiled.record.status, QualificationStatus::Passed);
    assert_eq!(compiled.record.evidence_sha256, compiled.artifact_sha256);
    assert_eq!(
        compiled.artifact.maximum_mode,
        QualifiedCoordinatorMode::Authoritative
    );
    assert_eq!(compiled.registry.records, vec![compiled.record]);
}

#[test]
fn synthetic_or_identity_mismatched_evidence_cannot_authorize() {
    let suite_bytes = std::fs::read(fixture_path()).unwrap();
    let suite = CoordinatorEvaluationSuite::from_slice(&suite_bytes).unwrap();
    let observations = CoordinatorObservationFile {
        schema_version: OBSERVATION_FILE_SCHEMA_VERSION,
        source: ObservationSource::Synthetic,
        observations: passing_observations(&suite),
    };
    let observation_bytes = serde_json::to_vec(&observations).unwrap();
    let evaluated_at = "2026-08-06T12:00:00Z".parse().unwrap();
    let expires_at = "2026-09-05T12:00:00Z".parse().unwrap();
    let compiled = QualificationEvidenceCompiler::compile(
        &suite_bytes,
        &observation_bytes,
        qualification_key(&suite),
        evaluated_at,
        expires_at,
    )
    .unwrap();
    assert_eq!(compiled.record.status, QualificationStatus::Failed);
    assert_eq!(
        compiled.artifact.maximum_mode,
        QualifiedCoordinatorMode::Shadow
    );

    let mut wrong_key = qualification_key(&suite);
    wrong_key.evaluator_version = "other-evaluator".to_string();
    assert!(matches!(
        QualificationEvidenceCompiler::compile(
            &suite_bytes,
            &observation_bytes,
            wrong_key,
            evaluated_at,
            expires_at,
        ),
        Err(QualificationArtifactError::IdentityMismatch)
    ));
}

#[test]
fn compiler_cli_writes_new_strict_artifact_and_registry_files() {
    let suite_path = fixture_path();
    let suite = CoordinatorEvaluationSuite::load(&suite_path).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let observations_path = directory.path().join("observations.json");
    let artifact_path = directory.path().join("evidence.json");
    let registry_path = directory.path().join("registry.json");
    std::fs::write(
        &observations_path,
        serde_json::to_vec_pretty(&CoordinatorObservationFile {
            schema_version: OBSERVATION_FILE_SCHEMA_VERSION,
            source: ObservationSource::Synthetic,
            observations: passing_observations(&suite),
        })
        .unwrap(),
    )
    .unwrap();

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_codepro_qualification_compiler"))
        .args([
            "--suite",
            suite_path.to_str().unwrap(),
            "--observations",
            observations_path.to_str().unwrap(),
            "--provider",
            "ollama_cloud",
            "--model",
            "synthetic-candidate",
            "--reasoning",
            "high",
            "--evaluated-at",
            "2026-08-06T12:00:00Z",
            "--expires-at",
            "2026-09-05T12:00:00Z",
            "--artifact-out",
            artifact_path.to_str().unwrap(),
            "--registry-out",
            registry_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(artifact_path.is_file());
    let registry = FileQualificationRegistry::load(&registry_path).unwrap();
    assert_eq!(
        registry.evaluate(
            &QualificationKey {
                provider: "ollama_cloud".to_string(),
                model: "synthetic-candidate".to_string(),
                reasoning_level: "high".to_string(),
                protocol_version: suite.protocol_version,
                prompt_version: suite.prompt_version,
                evaluator_version: suite.evaluator_version,
            },
            "2026-08-07T12:00:00Z".parse().unwrap(),
        ),
        goose::agents::protocol::CoordinatorQualificationResult::Failed
    );
}
