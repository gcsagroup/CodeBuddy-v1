use super::discover_skills;
use super::loaded_skill_context_with_args;
use super::management::SkillManagementService;
use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::ToolCallContext;
use crate::capability_usage::{
    record_capability_success, CapabilityUsageEvent, CapabilityUsageKind,
};
use async_trait::async_trait;
use goose_sdk_types::custom_requests::{
    SkillDestination, SkillManagementOperation, SkillSourceRef, SourceEntry, SourceType,
};
use rmcp::model::{
    CallToolResult, Content, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, ServerNotification, Tool, ToolAnnotations,
};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub static EXTENSION_NAME: &str = "skills";

pub struct SkillsClient {
    info: InitializeResult,
    working_dir: PathBuf,
    management: SkillManagementService,
}

impl SkillsClient {
    pub fn new(context: PlatformExtensionContext) -> anyhow::Result<Self> {
        let working_dir = context
            .session
            .as_ref()
            .map(|s| s.working_dir.clone())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(EXTENSION_NAME, "1.0.0").with_title("Skills"));

        Ok(Self {
            info,
            working_dir,
            management: SkillManagementService::default(),
        })
    }

    fn project_dir(&self) -> Option<String> {
        Some(self.working_dir.to_string_lossy().into_owned())
    }

    async fn call_management_tool(
        &self,
        ctx: &ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
    ) -> Option<Result<CallToolResult, Error>> {
        let args = serde_json::Value::Object(arguments.unwrap_or_default());
        let result = match name {
            "list_skills" => self
                .management
                .list_response(self.project_dir().as_deref())
                .and_then(success_json),
            "read_skill" => parse_argument::<SkillSourceRef>(&args, "source")
                .and_then(|source| self.management.read(self.project_dir().as_deref(), &source))
                .and_then(success_json),
            "preview_skill_change" => parse_argument::<SkillManagementOperation>(&args, "change")
                .and_then(|change| self.management.preview(self.project_dir(), change))
                .and_then(success_json),
            "preview_skill_download" => {
                let parsed = (|| {
                    Ok((
                        required_string(&args, "url")?,
                        parse_argument::<SkillDestination>(&args, "destination")?,
                    ))
                })();
                match parsed {
                    Ok((url, destination)) => self
                        .management
                        .preview_download(self.project_dir(), destination, &url)
                        .await
                        .and_then(success_json),
                    Err(error) => Err(error),
                }
            }
            "apply_skill_change" => {
                let parsed = required_string(&args, "previewToken");
                match parsed {
                    Ok(token) => match self.management.pending(&token) {
                        Ok(preview) if preview.requires_confirmation => {
                            if !ctx.explicit_user_confirmation {
                                Err(agent_client_protocol::Error::invalid_request()
                                    .data("host_confirmation_required"))
                            } else {
                                self.management
                                    .confirmation_request(&token)
                                    .and_then(|request| {
                                        self.management.approve(
                                            &request,
                                            goose_sdk_types::custom_requests::SkillManagementConfirmationResponse {
                                                decision: goose_sdk_types::custom_requests::SkillManagementConfirmationDecision::Confirm,
                                                nonce: request.nonce.clone(),
                                            },
                                        )
                                    })
                                    .and_then(|approval| {
                                        self.management.apply(&token, Some(approval))
                                    })
                                    .and_then(success_json)
                            }
                        }
                        Ok(_) => self.management.apply(&token, None).and_then(success_json),
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error),
                }
            }
            _ => return None,
        };
        Some(Ok(result.unwrap_or_else(management_error)))
    }
}

fn parse_argument<T: serde::de::DeserializeOwned>(
    arguments: &serde_json::Value,
    key: &str,
) -> Result<T, agent_client_protocol::Error> {
    let value = arguments
        .get(key)
        .cloned()
        .ok_or_else(|| agent_client_protocol::Error::invalid_params().data("missing_parameter"))?;
    serde_json::from_value(value)
        .map_err(|_| agent_client_protocol::Error::invalid_params().data("invalid_parameter"))
}

fn required_string(
    arguments: &serde_json::Value,
    key: &str,
) -> Result<String, agent_client_protocol::Error> {
    arguments
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| agent_client_protocol::Error::invalid_params().data("missing_parameter"))
}

fn success_json<T: serde::Serialize>(
    value: T,
) -> Result<CallToolResult, agent_client_protocol::Error> {
    serde_json::to_string_pretty(&value)
        .map(|value| CallToolResult::success(vec![Content::text(value)]))
        .map_err(agent_client_protocol::Error::into_internal_error)
}

fn management_error(error: agent_client_protocol::Error) -> CallToolResult {
    let detail = error
        .data
        .as_ref()
        .map(serde_json::Value::to_string)
        .unwrap_or_else(|| error.to_string());
    CallToolResult::error(vec![Content::text(detail)])
}

#[async_trait]
impl McpClientTrait for SkillsClient {
    async fn list_tools(
        &self,
        _session_id: &str,
        _next_cursor: Option<String>,
        _cancellation_token: CancellationToken,
    ) -> Result<ListToolsResult, Error> {
        let schema = serde_json::json!({
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name of the skill to load. Use \"skill-name/path\" to load a supporting file."
                },
                "args": {
                    "type": "string",
                    "description": "Optional arguments to provide when loading the skill."
                }
            }
        });

        let tool = Tool::new(
            "load_skill",
            "Load a skill's full content into your context so you can follow its instructions.\n\n\
             Skills are listed in your system instructions. When you need to use one, \
             load it first to get the detailed instructions.\n\n\
             Examples:\n\
             - load_skill(name: \"gdrive\") → Loads the gdrive skill instructions\n\
             - load_skill(name: \"my-skill\", args: \"the arguments for the skill\") → Loads a skill with arguments\n\
             - load_skill(name: \"my-skill/template.md\") → Loads a supporting file"
                .to_string(),
            schema.as_object().unwrap().clone(),
        )
        .annotate(
            ToolAnnotations::with_title("Load skill instructions".to_string())
                .read_only(true)
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        );

        let list = Tool::new(
            "list_skills",
            "List installed skills with stable source references, scopes, versions, and writable destinations.",
            serde_json::json!({"type": "object", "additionalProperties": false})
                .as_object()
                .unwrap()
                .clone(),
        )
        .annotate(
            ToolAnnotations::with_title("List installed skills")
                .read_only(true)
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        );
        let read = Tool::new(
            "read_skill",
            "Read one installed skill by the exact source reference returned by list_skills.",
            serde_json::json!({
                "type": "object",
                "required": ["source"],
                "additionalProperties": false,
                "properties": {"source": {"type": "object"}}
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .annotate(
            ToolAnnotations::with_title("Read installed skill")
                .read_only(true)
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        );
        let preview_change = Tool::new(
            "preview_skill_change",
            "Preview a create, local import, edit, copy, delete, or restore operation. This does not modify installed skills. Pass the returned previewToken only to apply_skill_change.",
            serde_json::json!({
                "type": "object",
                "required": ["change"],
                "additionalProperties": false,
                "properties": {"change": {"type": "object"}}
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .annotate(
            ToolAnnotations::with_title("Preview skill change")
                .read_only(true)
                .destructive(false)
                .idempotent(false)
                .open_world(false),
        );
        let preview_download = Tool::new(
            "preview_skill_download",
            "Securely stage and validate a public GitHub skill directory or direct HTTPS SKILL.md link. This does not install it; use apply_skill_change with the returned previewToken.",
            serde_json::json!({
                "type": "object",
                "required": ["url", "destination"],
                "additionalProperties": false,
                "properties": {
                    "url": {"type": "string"},
                    "destination": {"type": "object"}
                }
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .annotate(
            ToolAnnotations::with_title("Preview skill download")
                .read_only(true)
                .destructive(false)
                .idempotent(false)
                .open_world(true),
        );
        let apply = Tool::new(
            "apply_skill_change",
            "Apply exactly one current preview token. The token binds the target and version. Model-supplied confirmation fields are ignored; the host must authorize this write.",
            serde_json::json!({
                "type": "object",
                "required": ["previewToken"],
                "additionalProperties": false,
                "properties": {"previewToken": {"type": "string"}}
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .annotate(
            ToolAnnotations::with_title("Apply skill change")
                .read_only(false)
                .destructive(true)
                .idempotent(false)
                .open_world(false),
        );

        Ok(ListToolsResult {
            tools: vec![tool, list, read, preview_change, preview_download, apply],
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
        if let Some(result) = self
            .call_management_tool(ctx, name, arguments.clone())
            .await
        {
            return result;
        }
        if name != "load_skill" {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "Unknown tool: {}",
                name
            ))]));
        }

        let skill_name = arguments
            .as_ref()
            .and_then(|args| args.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if skill_name.is_empty() {
            return Ok(CallToolResult::error(vec![Content::text(
                "Missing required parameter: name",
            )]));
        }
        let args = arguments
            .as_ref()
            .and_then(|args| args.get("args"))
            .and_then(|v| v.as_str());

        let skills = discover_skills(Some(&self.working_dir));

        if let Some(skill) = skills.iter().find(|s| s.name == skill_name) {
            return match loaded_skill_context_with_args(skill, args) {
                Ok(rendered) => {
                    record_skill_success(ctx, &skill.name, "loaded");
                    Ok(CallToolResult::success(vec![Content::text(rendered)]))
                }
                Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "Failed to parse skill arguments: {}",
                    e
                ))])),
            };
        }

        if let Some((parent_skill_name, raw_relative_path)) = skill_name.split_once('/') {
            let relative_path = raw_relative_path.replace('\\', "/");
            if let Some(skill) = skills.iter().find(|s| {
                s.name == parent_skill_name
                    && matches!(s.source_type, SourceType::Skill | SourceType::BuiltinSkill)
            }) {
                let skill_dir = PathBuf::from(&skill.path);
                let canonical_skill_dir = skill_dir
                    .canonicalize()
                    .unwrap_or_else(|_| skill_dir.clone());

                for file_path in &skill.supporting_files {
                    let file_path_buf = Path::new(file_path);
                    let Ok(rel) = file_path_buf.strip_prefix(&skill_dir) else {
                        continue;
                    };
                    if rel.to_string_lossy().replace('\\', "/") != relative_path {
                        continue;
                    }

                    return Ok(match file_path_buf.canonicalize() {
                        Ok(canonical) if canonical.starts_with(&canonical_skill_dir) => {
                            match std::fs::read_to_string(&canonical) {
                                Ok(content) => {
                                    record_skill_success(
                                        ctx,
                                        parent_skill_name,
                                        "supporting file loaded",
                                    );
                                    CallToolResult::success(vec![Content::text(format!(
                                        "# Loaded: {}\n\n{}\n\n---\nFile loaded into context.",
                                        skill_name, content
                                    ))])
                                }
                                Err(e) => CallToolResult::error(vec![Content::text(format!(
                                    "Failed to read '{}': {}",
                                    skill_name, e
                                ))]),
                            }
                        }
                        Ok(_) => CallToolResult::error(vec![Content::text(format!(
                            "Refusing to load '{}': resolves outside the skill directory",
                            skill_name
                        ))]),
                        Err(e) => CallToolResult::error(vec![Content::text(format!(
                            "Failed to resolve '{}': {}",
                            skill_name, e
                        ))]),
                    });
                }

                let available: Vec<String> = skill
                    .supporting_files
                    .iter()
                    .filter_map(|f| {
                        Path::new(f)
                            .strip_prefix(&skill_dir)
                            .ok()
                            .map(|r| r.to_string_lossy().replace('\\', "/"))
                    })
                    .take(10)
                    .collect();

                return Ok(if available.is_empty() {
                    CallToolResult::error(vec![Content::text(format!(
                        "Skill '{}' has no supporting files.",
                        skill.name
                    ))])
                } else {
                    CallToolResult::error(vec![Content::text(format!(
                        "File '{}' not found. Available: {}",
                        skill_name,
                        available.join(", ")
                    ))])
                });
            }
        }

        let suggestions: Vec<&str> = skills
            .iter()
            .filter(|s| {
                s.name.to_lowercase().contains(&skill_name.to_lowercase())
                    || skill_name.to_lowercase().contains(&s.name.to_lowercase())
            })
            .take(3)
            .map(|s| s.name.as_str())
            .collect();

        Ok(if suggestions.is_empty() {
            CallToolResult::error(vec![Content::text(format!(
                "Skill '{}' not found.",
                skill_name
            ))])
        } else {
            CallToolResult::error(vec![Content::text(format!(
                "Skill '{}' not found. Did you mean: {}?",
                skill_name,
                suggestions.join(", ")
            ))])
        })
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }

    fn get_instructions(&self) -> Option<String> {
        let sources = discover_skills(Some(&self.working_dir));
        let mut skills: Vec<&SourceEntry> = sources
            .iter()
            .filter(|s| {
                s.source_type == SourceType::Skill || s.source_type == SourceType::BuiltinSkill
            })
            .collect();
        skills.sort_by(|a, b| (&a.name, &a.path).cmp(&(&b.name, &b.path)));

        if skills.is_empty() {
            return None;
        }

        let mut instructions = String::from(
            "\n\nYou have these skills at your disposal, when it is clear they can help you solve a problem or you are asked to use them:",
        );
        for skill in &skills {
            instructions.push_str(&format!("\n• {} - {}", skill.name, skill.description));
        }
        Some(instructions)
    }

    async fn subscribe(&self) -> mpsc::Receiver<ServerNotification> {
        let (_tx, rx) = mpsc::channel(1);
        rx
    }
}

fn record_skill_success(ctx: &ToolCallContext, skill_name: &str, recent_result: &str) {
    let request_id = ctx
        .tool_call_request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    record_capability_success(CapabilityUsageEvent {
        event_id: format!("skill:{}:{request_id}", ctx.session_id),
        kind: CapabilityUsageKind::Skill,
        capability_id: skill_name.to_string(),
        recent_result: recent_result.to_string(),
        reference: Some(format!("skill:{skill_name}")),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_load_skill_from_filesystem() {
        let temp_dir = TempDir::new().unwrap();
        let skill_dir = temp_dir.path().join(".goose/skills/my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: A test skill\n---\nDo the thing.",
        )
        .unwrap();

        let session = std::sync::Arc::new(crate::session::Session {
            working_dir: temp_dir.path().to_path_buf(),
            ..crate::session::Session::default()
        });
        let client = SkillsClient::new(PlatformExtensionContext {
            extension_manager: None,
            session_manager: Arc::new(crate::session::SessionManager::instance()),
            session: Some(session),
            use_login_shell_path: false,
        })
        .unwrap();

        let ctx = ToolCallContext::new("test".to_string(), None, None);
        let args: JsonObject =
            serde_json::from_value(serde_json::json!({"name": "my-skill"})).unwrap();
        let result = client
            .call_tool(&ctx, "load_skill", Some(args), CancellationToken::new())
            .await
            .unwrap();

        assert!(!result.is_error.unwrap_or(false));
        let text = match &result.content[0].raw {
            rmcp::model::RawContent::Text(t) => &t.text,
            _ => panic!("expected text"),
        };
        assert!(text.contains("my-skill"));
        assert!(text.contains("Do the thing"));
    }

    #[tokio::test]
    async fn test_load_skill_not_found_returns_error() {
        let client = SkillsClient::new(PlatformExtensionContext {
            extension_manager: None,
            session_manager: Arc::new(crate::session::SessionManager::instance()),
            session: None,
            use_login_shell_path: false,
        })
        .unwrap();

        let ctx = ToolCallContext::new("test".to_string(), None, None);
        let args: JsonObject =
            serde_json::from_value(serde_json::json!({"name": "nonexistent"})).unwrap();
        let result = client
            .call_tool(&ctx, "load_skill", Some(args), CancellationToken::new())
            .await
            .unwrap();

        assert!(result.is_error.unwrap_or(false));
    }

    #[tokio::test]
    async fn management_tools_have_bounded_annotations() {
        let client = SkillsClient::new(PlatformExtensionContext {
            extension_manager: None,
            session_manager: Arc::new(crate::session::SessionManager::instance()),
            session: None,
            use_login_shell_path: false,
        })
        .unwrap();
        let tools = client
            .list_tools("test", None, CancellationToken::new())
            .await
            .unwrap()
            .tools;
        let apply = tools
            .iter()
            .find(|tool| tool.name.as_ref() == "apply_skill_change")
            .unwrap();
        assert_eq!(
            apply.annotations.as_ref().unwrap().read_only_hint,
            Some(false)
        );
        assert_eq!(
            apply.annotations.as_ref().unwrap().destructive_hint,
            Some(true)
        );
        let download = tools
            .iter()
            .find(|tool| tool.name.as_ref() == "preview_skill_download")
            .unwrap();
        assert_eq!(
            download.annotations.as_ref().unwrap().read_only_hint,
            Some(true)
        );
        assert_eq!(
            download.annotations.as_ref().unwrap().open_world_hint,
            Some(true)
        );
    }

    #[tokio::test]
    async fn model_supplied_confirmation_cannot_authorize_delete() {
        let temp_dir = TempDir::new().unwrap();
        let project = temp_dir.path().canonicalize().unwrap();
        let skill_dir = project.join(".agents/skills/demo");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\nDo it.\n",
        )
        .unwrap();
        let session = Arc::new(crate::session::Session {
            working_dir: project.clone(),
            ..crate::session::Session::default()
        });
        let client = SkillsClient::new(PlatformExtensionContext {
            extension_manager: None,
            session_manager: Arc::new(crate::session::SessionManager::instance()),
            session: Some(session),
            use_login_shell_path: false,
        })
        .unwrap();
        let source = SkillSourceRef {
            root_kind: goose_sdk_types::custom_requests::SkillRootKind::ProjectAgents,
            root_id: project.to_string_lossy().into_owned(),
            relative_path: "demo".into(),
        };
        let current = client
            .management
            .read(Some(&source.root_id), &source)
            .unwrap();
        let preview = client
            .management
            .preview(
                Some(project.to_string_lossy().into_owned()),
                SkillManagementOperation::Delete {
                    source,
                    expected_version: current.version,
                },
            )
            .unwrap();
        let ctx = ToolCallContext::new("test".to_string(), None, None);
        let arguments = serde_json::from_value(serde_json::json!({
            "previewToken": preview.preview_token,
            "confirmed": true
        }))
        .unwrap();

        let result = client
            .call_tool(
                &ctx,
                "apply_skill_change",
                Some(arguments),
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert!(result.is_error.unwrap_or(false));
        assert!(skill_dir.exists());
    }
}
