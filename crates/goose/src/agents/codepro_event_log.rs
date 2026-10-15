use crate::agents::agent_role::{CodeProRiskReason, CodeProRiskTier};
use crate::agents::codepro_routing_evidence::CodeProRoutingEvidence;
use crate::agents::protocol::EvidenceRef;
use crate::agents::{
    ActivityEvent, ActivityEventKind, ActivityEventStatus, AgentRole, ACTIVITY_EVENT_SCHEMA_VERSION,
};
use crate::permission::failure_semantics::CodeProFailureKind;
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const REDACTED_VALUE: &str = "[REDACTED]";
const DEFAULT_MAX_ARTIFACT_BYTES: usize = 1024 * 1024;
const ARTIFACT_TRUNCATION_MARKER: &str = "\n[TRUNCATED]\n";

pub(crate) fn redact_persisted_text(value: String) -> String {
    static BEARER_PATTERN: OnceLock<Regex> = OnceLock::new();
    static ASSIGNMENT_PATTERN: OnceLock<Regex> = OnceLock::new();
    static CLI_FLAG_PATTERN: OnceLock<Regex> = OnceLock::new();

    let bearer_pattern = BEARER_PATTERN.get_or_init(|| {
        Regex::new(r#"(?i)(\bbearer\s+)[^\s"',;]+"#)
            .expect("the CodePro bearer-token redaction regex is valid")
    });
    let assignment_pattern = ASSIGNMENT_PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)"#,
        )
        .expect("the CodePro secret-assignment redaction regex is valid")
    });
    let cli_flag_pattern = CLI_FLAG_PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(--(?:[a-z0-9]+-)*(?:api-?key|secret-access-key|access-key(?:-id)?|private-key|access-token|refresh-token|token|secret|password|passwd|authorization)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)"#,
        )
        .expect("the CodePro secret-flag redaction regex is valid")
    });

    let value = bearer_pattern
        .replace_all(&value, format!("${{1}}{REDACTED_VALUE}"))
        .into_owned();
    let value = assignment_pattern
        .replace_all(&value, format!("${{1}}{REDACTED_VALUE}"))
        .into_owned();
    cli_flag_pattern
        .replace_all(&value, format!("${{1}}{REDACTED_VALUE}"))
        .into_owned()
}

fn redact_optional_persisted_text(value: Option<String>) -> Option<String> {
    value.map(redact_persisted_text)
}

#[derive(Debug, Clone)]
pub struct CodeProArtifactStore {
    run_dir: PathBuf,
    max_artifact_bytes: usize,
}

impl CodeProArtifactStore {
    pub fn new(run_dir: impl Into<PathBuf>) -> Self {
        Self::with_max_bytes(run_dir, DEFAULT_MAX_ARTIFACT_BYTES)
    }

    pub fn with_max_bytes(run_dir: impl Into<PathBuf>, max_artifact_bytes: usize) -> Self {
        Self {
            run_dir: run_dir.into(),
            max_artifact_bytes,
        }
    }

    pub fn write_text(
        &self,
        event_id: &str,
        kind: &str,
        content: impl AsRef<str>,
    ) -> Result<PathBuf> {
        if self.max_artifact_bytes == 0 {
            bail!("CodePro artifact size limit must be greater than zero");
        }
        let event_id = sanitize_artifact_name(event_id);
        let kind = sanitize_artifact_name(kind);
        let artifacts_dir = self.run_dir.join("artifacts");
        std::fs::create_dir_all(&artifacts_dir)
            .with_context(|| format!("无法创建 CodePro 制品目录 {}", artifacts_dir.display()))?;
        let file_name = format!("{event_id}.{kind}.txt");
        let relative_path = PathBuf::from("artifacts").join(&file_name);
        let destination = self.run_dir.join(&relative_path);
        if destination.exists() {
            return Ok(relative_path);
        }

        let redacted = redact_persisted_text(content.as_ref().to_string());
        let bounded = bound_artifact_text(redacted, self.max_artifact_bytes);
        let temporary = artifacts_dir.join(format!(".{file_name}.tmp-{}", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("无法创建 CodePro 临时制品 {}", temporary.display()))?;
        file.write_all(bounded.as_bytes())
            .with_context(|| format!("无法写入 CodePro 制品 {}", temporary.display()))?;
        file.sync_all()
            .with_context(|| format!("无法持久化 CodePro 制品 {}", temporary.display()))?;
        drop(file);
        std::fs::rename(&temporary, &destination).with_context(|| {
            format!(
                "无法发布 CodePro 制品 {} -> {}",
                temporary.display(),
                destination.display()
            )
        })?;
        Ok(relative_path)
    }
}

fn sanitize_artifact_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(128)
        .collect::<String>();
    if sanitized.is_empty() {
        "artifact".to_string()
    } else {
        sanitized
    }
}

fn bound_artifact_text(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let marker = ARTIFACT_TRUNCATION_MARKER;
    let content_budget = max_bytes.saturating_sub(marker.len());
    let mut boundary = content_budget.min(value.len());
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    if marker.len() <= max_bytes {
        value.push_str(marker);
    }
    value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProEventRecord {
    pub schema_version: u8,
    pub event_id: String,
    pub sequence: u64,
    pub session_id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub agent_role: Option<AgentRole>,
    pub effective_model: Option<String>,
    pub event_type: ActivityEventKind,
    pub status: ActivityEventStatus,
    pub title: String,
    pub detail_summary: Option<String>,
    pub path: Option<PathBuf>,
    pub command_summary: Option<String>,
    pub exit_code: Option<i32>,
    pub diff_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) failure_kind: Option<CodeProFailureKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_tier: Option<CodeProRiskTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_risk_tier: Option<CodeProRiskTier>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub risk_reasons: Vec<CodeProRiskReason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_roles: Vec<AgentRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_evidence: Option<CodeProRoutingEvidence>,
    pub artifact_ref: Option<PathBuf>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub include_in_model_context: bool,
    pub retryable: bool,
    pub retry_from_event_id: Option<String>,
}

impl CodeProEventRecord {
    pub fn from_activity_event(
        sequence: u64,
        event: ActivityEvent,
        artifact_ref: Option<PathBuf>,
    ) -> Self {
        Self {
            schema_version: event.schema_version,
            event_id: event.event_id,
            sequence,
            session_id: event.session_id,
            run_id: event.run_id,
            task_id: event.task_id,
            parent_task_id: event.parent_task_id,
            agent_role: event.agent_role,
            effective_model: event.effective_model,
            event_type: event.event_type,
            status: event.status,
            title: redact_persisted_text(event.title),
            detail_summary: redact_optional_persisted_text(event.technical_details),
            path: event.path,
            command_summary: redact_optional_persisted_text(event.command_summary),
            exit_code: event.exit_code,
            diff_summary: redact_optional_persisted_text(event.diff_summary),
            failure_kind: event.failure_kind,
            risk_tier: event.risk_tier,
            previous_risk_tier: event.previous_risk_tier,
            risk_reasons: event.risk_reasons,
            selected_roles: event.selected_roles,
            review_required: event.review_required,
            routing_evidence: event.routing_evidence,
            artifact_ref,
            started_at: event.started_at,
            finished_at: event.finished_at,
            include_in_model_context: event.include_in_model_context,
            retryable: event.retryable,
            retry_from_event_id: event.retry_from_event_id,
        }
    }

    pub fn to_activity_event(&self) -> ActivityEvent {
        ActivityEvent {
            schema_version: self.schema_version,
            event_id: self.event_id.clone(),
            event_type: self.event_type,
            session_id: self.session_id.clone(),
            run_id: self.run_id.clone(),
            task_id: self.task_id.clone(),
            parent_task_id: self.parent_task_id.clone(),
            agent_role: self.agent_role,
            effective_model: self.effective_model.clone(),
            status: self.status,
            started_at: self.started_at,
            finished_at: self.finished_at,
            title: self.title.clone(),
            technical_details: self.detail_summary.clone(),
            path: self.path.clone(),
            command_summary: self.command_summary.clone(),
            exit_code: self.exit_code,
            diff_summary: self.diff_summary.clone(),
            failure_kind: self.failure_kind,
            risk_tier: self.risk_tier,
            previous_risk_tier: self.previous_risk_tier,
            risk_reasons: self.risk_reasons.clone(),
            selected_roles: self.selected_roles.clone(),
            review_required: self.review_required,
            routing_evidence: self.routing_evidence.clone(),
            include_in_model_context: self.include_in_model_context,
            retryable: self.retryable,
            retry_from_event_id: self.retry_from_event_id.clone(),
        }
    }
}

#[derive(Debug)]
pub struct CodeProEventLog {
    path: PathBuf,
    file: File,
    records: Vec<CodeProEventRecord>,
    artifact_store: CodeProArtifactStore,
}

impl CodeProEventLog {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("无法创建事件日志目录 {}", parent.display()))?;
        }

        let records = recover_records(&path)?;
        let run_dir = path
            .parent()
            .context("CodePro event log path must have a run directory")?
            .to_path_buf();
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("无法打开事件日志 {}", path.display()))?;

        Ok(Self {
            path,
            file,
            records,
            artifact_store: CodeProArtifactStore::new(run_dir),
        })
    }

    pub fn records(&self) -> &[CodeProEventRecord] {
        &self.records
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(
        &mut self,
        event: &ActivityEvent,
        artifact_ref: Option<PathBuf>,
    ) -> Result<CodeProEventRecord> {
        if event.schema_version != ACTIVITY_EVENT_SCHEMA_VERSION {
            bail!(
                "不支持 ActivityEvent schema_version {}，当前仅支持 {}",
                event.schema_version,
                ACTIVITY_EVENT_SCHEMA_VERSION
            );
        }

        let sequence = self
            .records
            .last()
            .map_or(Some(1), |record| record.sequence.checked_add(1))
            .context("事件序号已达到 u64 上限")?;
        let record = CodeProEventRecord::from_activity_event(sequence, event.clone(), artifact_ref);
        let mut encoded = serde_json::to_vec(&record).context("无法序列化程序化事件")?;
        encoded.push(b'\n');

        self.file
            .write_all(&encoded)
            .with_context(|| format!("无法追加事件日志 {}", self.path.display()))?;
        self.file
            .flush()
            .with_context(|| format!("无法刷新事件日志 {}", self.path.display()))?;
        self.file
            .sync_data()
            .with_context(|| format!("无法持久化事件日志 {}", self.path.display()))?;
        self.records.push(record.clone());
        Ok(record)
    }

    pub fn append_with_text_artifact(
        &mut self,
        event: &ActivityEvent,
        artifact_kind: &str,
        content: impl AsRef<str>,
    ) -> Result<CodeProEventRecord> {
        let artifact_ref =
            self.artifact_store
                .write_text(&event.event_id, artifact_kind, content)?;
        self.append(event, Some(artifact_ref))
    }

    pub fn write_text_artifact(
        &self,
        event_id: &str,
        artifact_kind: &str,
        content: impl AsRef<str>,
    ) -> Result<PathBuf> {
        self.artifact_store
            .write_text(event_id, artifact_kind, content)
    }

    pub fn verify_task_evidence(&self, evidence: &EvidenceRef, task_id: &str) -> Result<()> {
        verify_task_evidence_records(
            &self.records,
            &self.artifact_store.run_dir,
            evidence,
            task_id,
        )
        .map(|_| ())
    }
}

/// Validate a read-only snapshot with the same owner rules as the live writer.
/// Reading evidence must not recover/truncate a journal another worker writes.
pub(crate) fn verify_task_evidence_records<'a>(
    records: &'a [CodeProEventRecord],
    run_dir: &Path,
    evidence: &EvidenceRef,
    task_id: &str,
) -> Result<&'a CodeProEventRecord> {
    let record = records
        .iter()
        .find(|record| record.event_id == evidence.event_id().as_str())
        .context("evidence event is not present in the CodePro event log")?;
    if record.run_id != evidence.run_id().as_str()
        || record.task_id.as_deref() != Some(task_id)
        || record.event_type != ActivityEventKind::EvidenceCommitted
        || record.artifact_ref.as_deref() != Some(evidence.artifact_ref())
    {
        bail!("evidence does not belong to the current run and task");
    }
    let artifact_path = run_dir.join(evidence.artifact_ref());
    if !artifact_path.is_file() {
        bail!("evidence artifact does not exist");
    }
    Ok(record)
}

pub fn read_codepro_event_records(path: impl AsRef<Path>) -> Result<Vec<CodeProEventRecord>> {
    let path = path.as_ref();
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("无法读取事件日志 {}", path.display()));
        }
    };

    let mut records = Vec::new();
    let mut line_start = 0;
    let mut line_number = 1;
    for newline_index in bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index))
    {
        let line = trim_carriage_return(&bytes[line_start..newline_index]);
        let record = parse_record(line, line_number, path)?;
        validate_record(&record, records.last(), line_number, path)?;
        records.push(record);
        line_start = newline_index + 1;
        line_number += 1;
    }

    let trailing = trim_carriage_return(&bytes[line_start..]);
    if !trailing.is_empty() {
        if let Ok(record) = serde_json::from_slice::<CodeProEventRecord>(trailing) {
            validate_record(&record, records.last(), line_number, path)?;
            records.push(record);
        }
    }
    Ok(records)
}

fn recover_records(path: &Path) -> Result<Vec<CodeProEventRecord>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("无法读取事件日志 {}", path.display()));
        }
    };

    let mut records = Vec::new();
    let mut line_start = 0;
    let mut line_number = 1;

    for newline_index in bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index))
    {
        let line = trim_carriage_return(&bytes[line_start..newline_index]);
        let record = parse_record(line, line_number, path)?;
        validate_record(&record, records.last(), line_number, path)?;
        records.push(record);
        line_start = newline_index + 1;
        line_number += 1;
    }

    let trailing = &bytes[line_start..];
    if !trailing.is_empty() {
        match serde_json::from_slice::<CodeProEventRecord>(trim_carriage_return(trailing)) {
            Ok(record) => {
                validate_record(&record, records.last(), line_number, path)?;
                records.push(record);
                let mut file = OpenOptions::new()
                    .append(true)
                    .open(path)
                    .with_context(|| format!("无法修复事件日志 {}", path.display()))?;
                file.write_all(b"\n")
                    .with_context(|| format!("无法补全事件日志尾行 {}", path.display()))?;
                file.sync_data()
                    .with_context(|| format!("无法持久化修复后的事件日志 {}", path.display()))?;
            }
            Err(_) => {
                let file = OpenOptions::new()
                    .write(true)
                    .open(path)
                    .with_context(|| format!("无法恢复事件日志 {}", path.display()))?;
                file.set_len(line_start as u64)
                    .with_context(|| format!("无法截断事件日志损坏尾行 {}", path.display()))?;
                file.sync_data()
                    .with_context(|| format!("无法持久化事件日志恢复结果 {}", path.display()))?;
            }
        }
    }

    Ok(records)
}

fn parse_record(line: &[u8], line_number: usize, path: &Path) -> Result<CodeProEventRecord> {
    if line.is_empty() {
        bail!("事件日志 {} 第 {} 行为空", path.display(), line_number);
    }
    serde_json::from_slice(line).with_context(|| {
        format!(
            "事件日志 {} 第 {} 行不是有效记录",
            path.display(),
            line_number
        )
    })
}

fn validate_record(
    record: &CodeProEventRecord,
    previous: Option<&CodeProEventRecord>,
    line_number: usize,
    path: &Path,
) -> Result<()> {
    if record.schema_version != ACTIVITY_EVENT_SCHEMA_VERSION {
        bail!(
            "事件日志 {} 第 {} 行 schema_version {} 不受支持",
            path.display(),
            line_number,
            record.schema_version
        );
    }

    let expected = previous.map_or(Some(1), |record| record.sequence.checked_add(1));
    if expected != Some(record.sequence) {
        bail!(
            "事件日志 {} 第 {} 行序号不连续：期望 {:?}，实际 {}",
            path.display(),
            line_number,
            expected,
            record.sequence
        );
    }
    Ok(())
}

fn trim_carriage_return(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}
