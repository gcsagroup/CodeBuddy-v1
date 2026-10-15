use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use goose::agents::coordinator::{
    CoordinatorEvaluationSuite, QualificationEvidenceCompiler, QualificationKey,
};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

fn main() -> Result<()> {
    let arguments = parse_arguments()?;
    let suite_path = required_path(&arguments, "suite")?;
    let observations_path = required_path(&arguments, "observations")?;
    let artifact_path = required_path(&arguments, "artifact-out")?;
    let registry_path = required_path(&arguments, "registry-out")?;
    let suite_bytes = std::fs::read(&suite_path)
        .with_context(|| format!("failed to read suite {}", suite_path.display()))?;
    let observation_bytes = std::fs::read(&observations_path).with_context(|| {
        format!(
            "failed to read observations {}",
            observations_path.display()
        )
    })?;
    let suite = CoordinatorEvaluationSuite::from_slice(&suite_bytes)?;
    let key = QualificationKey {
        provider: required(&arguments, "provider")?.to_string(),
        model: required(&arguments, "model")?.to_string(),
        reasoning_level: required(&arguments, "reasoning")?.to_string(),
        protocol_version: suite.protocol_version,
        prompt_version: suite.prompt_version.clone(),
        evaluator_version: suite.evaluator_version.clone(),
    };
    let evaluated_at = parse_timestamp(required(&arguments, "evaluated-at")?)?;
    let expires_at = parse_timestamp(required(&arguments, "expires-at")?)?;
    let compiled = QualificationEvidenceCompiler::compile(
        &suite_bytes,
        &observation_bytes,
        key,
        evaluated_at,
        expires_at,
    )?;
    let mut registry_bytes = serde_json::to_vec_pretty(&compiled.registry)?;
    registry_bytes.push(b'\n');
    write_new(&artifact_path, &compiled.artifact_bytes)?;
    if let Err(error) = write_new(&registry_path, &registry_bytes) {
        let _ = std::fs::remove_file(&artifact_path);
        return Err(error);
    }
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "artifact": artifact_path,
            "registry": registry_path,
            "evidence_sha256": compiled.artifact_sha256,
            "maximum_mode": compiled.artifact.maximum_mode,
        }))?
    );
    Ok(())
}

fn parse_arguments() -> Result<BTreeMap<String, String>> {
    let values = std::env::args().skip(1).collect::<Vec<_>>();
    if values.len() % 2 != 0 {
        bail!("arguments must be supplied as --name value pairs");
    }
    let mut parsed = BTreeMap::new();
    for pair in values.chunks_exact(2) {
        let Some(name) = pair[0].strip_prefix("--") else {
            bail!("unexpected positional argument")
        };
        if name.is_empty() || parsed.insert(name.to_string(), pair[1].clone()).is_some() {
            bail!("invalid or duplicate argument")
        }
    }
    Ok(parsed)
}

fn required<'a>(arguments: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str> {
    arguments
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("missing required argument --{name}"))
}

fn required_path(arguments: &BTreeMap<String, String>, name: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(required(arguments, name)?))
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>> {
    value
        .parse::<DateTime<Utc>>()
        .with_context(|| "timestamp must be RFC3339 UTC")
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() {
        bail!("refusing to write an empty qualification artifact")
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .with_context(|| format!("refusing to overwrite or create {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("failed to write {}", path.display()))?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}
