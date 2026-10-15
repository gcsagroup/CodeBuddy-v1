use crate::agents::extension::{ExtensionConfig, PlatformExtensionContext};
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::tool_execution::ToolCallContext;
use crate::agents::{read_codepro_event_records, CodeProEventRecord, CodeProStateStore};
use anyhow::{bail, Result};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use rmcp::model::{
    CallToolResult, Content, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, Tool, ToolAnnotations,
};
use schemars::{schema_for, JsonSchema};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub static EXTENSION_NAME: &str = "codepromemory";
pub const MEMORY_SEARCH_TOOL_NAME: &str = "memory_search";
pub const MEMORY_READ_TOOL_NAME: &str = "memory_read";
pub const MEMORY_STATS_TOOL_NAME: &str = "memory_stats";
pub const NO_PROGRESS_SIGNAL: &str = "NO_PROGRESS";
const DEFAULT_SEARCH_LIMIT: usize = 20;
const MAX_SEARCH_LIMIT: usize = 100;
const MAX_MEMORY_TOOL_RESPONSE_BYTES: usize = 32 * 1024;
const MAX_MEMORY_IDENTIFIER_CHARS: usize = 128;
const MAX_MEMORY_MODEL_CHARS: usize = 256;
const MAX_MEMORY_TEXT_CHARS: usize = 512;
const MAX_MEMORY_PATH_CHARS: usize = 512;

pub fn extension_config() -> ExtensionConfig {
    ExtensionConfig::Platform {
        name: EXTENSION_NAME.to_string(),
        description: "Read bounded CodePro activity history for the current session".to_string(),
        display_name: Some("CodePro Memory".to_string()),
        bundled: Some(true),
        available_tools: Vec::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
struct MemorySearchParams {
    run_id: String,
    task_id: Option<String>,
    agent_role: Option<String>,
    path: Option<String>,
    command: Option<String>,
    status: Option<String>,
    query: Option<String>,
    started_from: Option<String>,
    started_to: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MemoryReadParams {
    run_id: String,
    sequence: Option<u64>,
    event_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MemoryStatsParams {
    run_id: String,
}

#[derive(Debug, Serialize)]
struct MemorySearchResult {
    matched_count: usize,
    returned_count: usize,
    truncated: bool,
    records: Vec<CodeProEventRecord>,
}

#[derive(Debug, Serialize)]
struct MemoryReadResult {
    record: CodeProEventRecord,
}

#[derive(Debug, Serialize)]
struct MemoryStatsResult {
    run_id: String,
    total_records: usize,
    first_sequence: Option<u64>,
    last_sequence: Option<u64>,
    by_status: BTreeMap<String, usize>,
    by_event_type: BTreeMap<String, usize>,
}

#[derive(Debug, Default)]
struct MemorySearchProgress {
    session_id: Option<String>,
    params: Option<MemorySearchParams>,
    last_sequence: Option<u64>,
}

pub struct CodeProMemoryClient {
    info: InitializeResult,
    root: PathBuf,
    caller_session_id: Option<String>,
    event_session_id: Option<String>,
    search_progress: Mutex<MemorySearchProgress>,
}

impl CodeProMemoryClient {
    pub fn new(context: PlatformExtensionContext) -> Result<Self> {
        Self::new_with_root(context, CodeProStateStore::default_location()?)
    }

    pub fn new_with_root(
        context: PlatformExtensionContext,
        root: impl Into<PathBuf>,
    ) -> Result<Self> {
        let caller_session_id = context.session.as_ref().map(|session| session.id.clone());
        let event_session_id = context.session.as_ref().map(|session| {
            session
                .parent_session_id
                .clone()
                .unwrap_or_else(|| session.id.clone())
        });
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(EXTENSION_NAME.to_string(), "1.0.0".to_string())
                    .with_title("CodePro Memory"),
            )
            .with_instructions(
                "Use memory_search for bounded discovery, memory_read for one exact event, and \
                 memory_stats for compact run counts. Never request an entire event log."
                    .to_string(),
            );
        Ok(Self {
            info,
            root: root.into(),
            caller_session_id,
            event_session_id,
            search_progress: Mutex::new(MemorySearchProgress::default()),
        })
    }

    pub fn event_log_path(root: &Path, run_id: &str) -> Result<PathBuf> {
        if run_id.is_empty()
            || run_id.len() > 128
            || !run_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            bail!("无效的 CodePro run_id");
        }
        Ok(root.join(run_id).join("run").join("events.jsonl"))
    }

    fn tools() -> Vec<Tool> {
        vec![
            read_only_tool::<MemorySearchParams>(
                MEMORY_SEARCH_TOOL_NAME,
                "Search one CodePro run with bounded filters and return only matching event summaries.",
            ),
            read_only_tool::<MemoryReadParams>(
                MEMORY_READ_TOOL_NAME,
                "Read one exact CodePro event by sequence or event_id.",
            ),
            read_only_tool::<MemoryStatsParams>(
                MEMORY_STATS_TOOL_NAME,
                "Return compact counts and sequence bounds for one CodePro run.",
            ),
        ]
    }

    fn search(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
    ) -> std::result::Result<CallToolResult, String> {
        let params: MemorySearchParams = parse_arguments(arguments)?;
        let limit = params.limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
        if !(1..=MAX_SEARCH_LIMIT).contains(&limit) {
            return Err(format!("limit 必须在 1 到 {} 之间", MAX_SEARCH_LIMIT));
        }
        let started_from = parse_timestamp(params.started_from.as_deref(), "started_from")?;
        let started_to = parse_timestamp(params.started_to.as_deref(), "started_to")?;
        if started_from
            .zip(started_to)
            .is_some_and(|(from, to)| from > to)
        {
            return Err("started_from 不能晚于 started_to".to_string());
        }

        let records = self.load_records(&ctx.session_id, &params.run_id)?;
        self.require_search_progress(&ctx.session_id, &params, &records)?;
        let mut matched_count = 0;
        let mut matches = Vec::new();
        for record in records.into_iter().rev() {
            if !record_matches(&record, &params, started_from, started_to) {
                continue;
            }
            matched_count += 1;
            if matches.len() < limit {
                matches.push(bounded_record(&record));
            }
        }
        success_bounded_search_json(MemorySearchResult {
            matched_count,
            returned_count: matches.len(),
            truncated: matched_count > matches.len(),
            records: matches,
        })
    }

    fn require_search_progress(
        &self,
        session_id: &str,
        params: &MemorySearchParams,
        records: &[CodeProEventRecord],
    ) -> std::result::Result<(), String> {
        let last_sequence = records.last().map(|record| record.sequence);
        let mut progress = self
            .search_progress
            .lock()
            .map_err(|_| "memory_search 查询状态锁已损坏".to_string())?;

        if progress.session_id.as_deref() == Some(session_id)
            && progress.params.as_ref() == Some(params)
            && progress.last_sequence == last_sequence
        {
            return Err(format!(
                "{NO_PROGRESS_SIGNAL}：相同 memory_search 查询没有发现新事件（最新序号：{}）。请先重新规划；没有新证据时不要重复检索。",
                last_sequence
                    .map(|sequence| sequence.to_string())
                    .unwrap_or_else(|| "无".to_string())
            ));
        }

        progress.session_id = Some(session_id.to_string());
        progress.params = Some(params.clone());
        progress.last_sequence = last_sequence;
        Ok(())
    }

    fn read(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
    ) -> std::result::Result<CallToolResult, String> {
        let params: MemoryReadParams = parse_arguments(arguments)?;
        if params.sequence.is_some() == params.event_id.is_some() {
            return Err("必须且只能提供 sequence 或 event_id 其中一个".to_string());
        }
        let records = self.load_records(&ctx.session_id, &params.run_id)?;
        let record = records
            .into_iter()
            .rev()
            .find(|record| {
                params
                    .sequence
                    .is_some_and(|sequence| record.sequence == sequence)
                    || params
                        .event_id
                        .as_deref()
                        .is_some_and(|event_id| record.event_id == event_id)
            })
            .ok_or_else(|| "未找到指定事件".to_string())?;
        success_json(&MemoryReadResult {
            record: bounded_record(&record),
        })
    }

    fn stats(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
    ) -> std::result::Result<CallToolResult, String> {
        let params: MemoryStatsParams = parse_arguments(arguments)?;
        let records = self.load_records(&ctx.session_id, &params.run_id)?;
        let mut by_status = BTreeMap::new();
        let mut by_event_type = BTreeMap::new();
        for record in &records {
            *by_status.entry(wire_name(&record.status)).or_insert(0) += 1;
            *by_event_type
                .entry(wire_name(&record.event_type))
                .or_insert(0) += 1;
        }
        success_json(&MemoryStatsResult {
            run_id: params.run_id,
            total_records: records.len(),
            first_sequence: records.first().map(|record| record.sequence),
            last_sequence: records.last().map(|record| record.sequence),
            by_status,
            by_event_type,
        })
    }

    fn load_records(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> std::result::Result<Vec<CodeProEventRecord>, String> {
        if self
            .caller_session_id
            .as_deref()
            .is_some_and(|caller_session_id| caller_session_id != session_id)
        {
            return Err("事件日志不属于当前会话边界".to_string());
        }
        let event_session_id = self.event_session_id.as_deref().unwrap_or(session_id);
        let path = Self::event_log_path(&self.root, run_id).map_err(|error| error.to_string())?;
        let records = read_codepro_event_records(path).map_err(|error| error.to_string())?;
        if records
            .iter()
            .any(|record| record.session_id != event_session_id || record.run_id != run_id)
        {
            return Err("事件日志不属于当前会话边界".to_string());
        }
        Ok(records)
    }
}

#[async_trait]
impl McpClientTrait for CodeProMemoryClient {
    async fn list_tools(
        &self,
        _session_id: &str,
        _next_cursor: Option<String>,
        _cancellation_token: CancellationToken,
    ) -> Result<ListToolsResult, Error> {
        Ok(ListToolsResult {
            tools: Self::tools(),
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        ctx: &ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
        _cancellation_token: CancellationToken,
    ) -> Result<CallToolResult, Error> {
        let result = match name {
            MEMORY_SEARCH_TOOL_NAME => self
                .search(ctx, arguments)
                .unwrap_or_else(|error| CallToolResult::error(vec![Content::text(error)])),
            MEMORY_READ_TOOL_NAME => self
                .read(ctx, arguments)
                .unwrap_or_else(|error| CallToolResult::error(vec![Content::text(error)])),
            MEMORY_STATS_TOOL_NAME => self
                .stats(ctx, arguments)
                .unwrap_or_else(|error| CallToolResult::error(vec![Content::text(error)])),
            _ => CallToolResult::error(vec![Content::text(format!("Error: Unknown tool: {name}"))]),
        };
        Ok(result)
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }
}

fn parse_arguments<T: DeserializeOwned>(
    arguments: Option<JsonObject>,
) -> std::result::Result<T, String> {
    serde_json::from_value(arguments.map_or(serde_json::Value::Null, serde_json::Value::Object))
        .map_err(|error| format!("参数无效: {error}"))
}

fn parse_timestamp(
    value: Option<&str>,
    field: &str,
) -> std::result::Result<Option<DateTime<Utc>>, String> {
    value
        .map(|value| {
            DateTime::parse_from_rfc3339(value)
                .map(|value| value.with_timezone(&Utc))
                .map_err(|error| format!("{field} 必须是 RFC 3339 时间: {error}"))
        })
        .transpose()
}

fn record_matches(
    record: &CodeProEventRecord,
    params: &MemorySearchParams,
    started_from: Option<DateTime<Utc>>,
    started_to: Option<DateTime<Utc>>,
) -> bool {
    let status = wire_name(&record.status);
    matches_optional(params.task_id.as_deref(), record.task_id.as_deref(), false)
        && matches_optional(
            params.agent_role.as_deref(),
            record.agent_role.map(|role| role.as_str()),
            false,
        )
        && matches_optional(
            params.path.as_deref(),
            record.path.as_ref().map(|path| path.to_string_lossy()),
            true,
        )
        && matches_optional(
            params.command.as_deref(),
            record.command_summary.as_deref(),
            true,
        )
        && matches_optional(params.status.as_deref(), Some(status.as_str()), false)
        && started_from.is_none_or(|from| record.started_at >= from)
        && started_to.is_none_or(|to| record.started_at <= to)
        && params.query.as_deref().is_none_or(|query| {
            let query = query.to_lowercase();
            [
                Some(record.title.as_str()),
                record.detail_summary.as_deref(),
                record.path.as_ref().and_then(|path| path.to_str()),
                record.command_summary.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_lowercase().contains(&query))
        })
}

fn matches_optional<'a>(
    expected: Option<&str>,
    actual: Option<impl AsRef<str> + 'a>,
    contains: bool,
) -> bool {
    expected.is_none_or(|expected| {
        actual.is_some_and(|actual| {
            if contains {
                actual
                    .as_ref()
                    .to_lowercase()
                    .contains(&expected.to_lowercase())
            } else {
                actual.as_ref().eq_ignore_ascii_case(expected)
            }
        })
    })
}

fn wire_name(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "unknown".to_string())
}

fn success_json(value: &impl Serialize) -> std::result::Result<CallToolResult, String> {
    serde_json::to_string(value)
        .map(|json| CallToolResult::success(vec![Content::text(json)]))
        .map_err(|error| format!("无法序列化查询结果: {error}"))
}

fn success_bounded_search_json(
    mut result: MemorySearchResult,
) -> std::result::Result<CallToolResult, String> {
    loop {
        let json = serde_json::to_string(&result)
            .map_err(|error| format!("无法序列化查询结果: {error}"))?;
        if json.len() <= MAX_MEMORY_TOOL_RESPONSE_BYTES {
            return Ok(CallToolResult::success(vec![Content::text(json)]));
        }
        if result.records.pop().is_none() {
            return Err("无法在上下文上限内返回查询结果".to_string());
        }
        result.returned_count = result.records.len();
        result.truncated = true;
    }
}

fn bounded_record(record: &CodeProEventRecord) -> CodeProEventRecord {
    let mut bounded = record.clone();
    bounded.event_id = truncate_for_memory(&bounded.event_id, MAX_MEMORY_IDENTIFIER_CHARS);
    bounded.session_id = truncate_for_memory(&bounded.session_id, MAX_MEMORY_IDENTIFIER_CHARS);
    bounded.run_id = truncate_for_memory(&bounded.run_id, MAX_MEMORY_IDENTIFIER_CHARS);
    bounded.task_id = bounded
        .task_id
        .map(|value| truncate_for_memory(&value, MAX_MEMORY_IDENTIFIER_CHARS));
    bounded.parent_task_id = bounded
        .parent_task_id
        .map(|value| truncate_for_memory(&value, MAX_MEMORY_IDENTIFIER_CHARS));
    bounded.effective_model = bounded
        .effective_model
        .map(|value| truncate_for_memory(&value, MAX_MEMORY_MODEL_CHARS));
    bounded.title = truncate_for_memory(&bounded.title, MAX_MEMORY_TEXT_CHARS);
    bounded.detail_summary = bounded
        .detail_summary
        .map(|value| truncate_for_memory(&value, MAX_MEMORY_TEXT_CHARS));
    bounded.path = bounded.path.map(|value| {
        PathBuf::from(truncate_for_memory(
            &value.to_string_lossy(),
            MAX_MEMORY_PATH_CHARS,
        ))
    });
    bounded.command_summary = bounded
        .command_summary
        .map(|value| truncate_for_memory(&value, MAX_MEMORY_TEXT_CHARS));
    bounded.diff_summary = bounded
        .diff_summary
        .map(|value| truncate_for_memory(&value, MAX_MEMORY_TEXT_CHARS));
    bounded.artifact_ref = bounded.artifact_ref.map(|value| {
        PathBuf::from(truncate_for_memory(
            &value.to_string_lossy(),
            MAX_MEMORY_PATH_CHARS,
        ))
    });
    bounded.retry_from_event_id = bounded
        .retry_from_event_id
        .map(|value| truncate_for_memory(&value, MAX_MEMORY_IDENTIFIER_CHARS));
    bounded
}

fn truncate_for_memory(value: &str, max_chars: usize) -> String {
    let mut characters = value.chars();
    let prefix = characters.by_ref().take(max_chars).collect::<String>();
    if characters.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn read_only_tool<T: JsonSchema>(name: &'static str, description: &'static str) -> Tool {
    let schema = serde_json::to_value(schema_for!(T))
        .expect("CodePro memory tool schema must serialize")
        .as_object()
        .expect("CodePro memory tool schema must be an object")
        .clone();
    Tool::new(name, description, schema).annotate(
        ToolAnnotations::with_title(name.to_string())
            .read_only(true)
            .destructive(false)
            .idempotent(true)
            .open_world(false),
    )
}
