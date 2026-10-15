pub mod ask_user;
pub mod document;
pub mod edit;
pub mod image;
mod managed_process;
pub mod search;
pub mod shell;
pub mod tree;

use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::ToolCallContext;
use anyhow::Result;
use ask_user::{ask_user, AskUserParams};
use async_trait::async_trait;
use document::{DocumentReadParams, DocumentTool};
use edit::{EditTools, FileEditParams, FileWriteParams};
use image::{ImageReadParams, ImageTool};
use indoc::indoc;
use rmcp::model::{
    CallToolResult, Content, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, Tool, ToolAnnotations,
};
use schemars::{schema_for, JsonSchema};
use search::{SearchParams, SearchTool};
use serde_json::Value;
use shell::{shell_display_name, ShellOutput, ShellParams, ShellTool};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tree::{TreeParams, TreeTool};

use crate::session::SessionManager;

pub static EXTENSION_NAME: &str = "developer";

pub struct DeveloperClient {
    info: InitializeResult,
    session_manager: Arc<SessionManager>,
    shell_tool: Arc<ShellTool>,
    edit_tools: Arc<EditTools>,
    tree_tool: Arc<TreeTool>,
    image_tool: Arc<ImageTool>,
    search_tool: Arc<SearchTool>,
    document_tool: Arc<DocumentTool>,
}

fn developer_instructions() -> &'static str {
    if cfg!(windows) {
        indoc! {"
            Use the developer extension to build software and operate a terminal.

            Make sure to use the tools *efficiently* - reading all the content you need in as few
            iterations as possible and then making the requested edits or running commands. You are
            responsible for managing your context window, and to minimize unnecessary turns which
            cost the user money.

            For editing software, prefer the flow of using tree to understand the codebase structure
            and file sizes. When you need to search, prefer findstr or Select-String (via shell).
            Then use type or Get-Content to gather the context you need, always reading before
            editing. Use write and edit to efficiently make changes. Test and verify as appropriate.

            When read_document reports path_not_found, stop the current read attempt.
            Do not guess another file path; use tree on the nearest existing directory before retrying.
            If tree shows multiple plausible files, inspect their context before choosing; ask
            only if the remaining choice belongs to the user. Use ask_user only for a material
            user-owned decision that cannot be inferred safely and has no reasonable low-risk
            default. Ask the smallest concrete question, then continue the original task after
            the user responds. Do not ask for facts you can discover safely, implementation
            tactics, permission scope changes, or whether to continue already authorized work.
            For an action requiring approval, attempt the exact action so the host can present
            its permission card. An ask_user answer never grants tool permission. If the user
            explicitly requires confirmation before editing, do not invoke write/edit until
            native approval is available or the user separately confirms the concrete edit;
            leave it blocked rather than treating an ask_user answer as authorization.
            If ask_user returns unanswered, do not infer consent, repeat the same question, or
            claim the dependent work is complete. Continue independent authorized work; when
            none remains, report the specific missing decision and current progress.
        "}
    } else {
        indoc! {"
            Use the developer extension to build software and operate a terminal.

            Make sure to use the tools *efficiently* - reading all the content you need in as few
            iterations as possible and then making the requested edits or running commands. You are
            responsible for managing your context window, and to minimize unnecessary turns which
            cost the user money.

            For editing software, prefer the flow of using tree to understand the codebase structure
            and file sizes. When you need to search, prefer rg which correctly respects gitignored
            content. Then use cat or sed to gather the context you need, always reading before editing.
            Use write and edit to efficiently make changes. Test and verify as appropriate.

            When read_document reports path_not_found, stop the current read attempt.
            Do not guess another file path; use tree on the nearest existing directory before retrying.
            If tree shows multiple plausible files, inspect their context before choosing; ask
            only if the remaining choice belongs to the user. Use ask_user only for a material
            user-owned decision that cannot be inferred safely and has no reasonable low-risk
            default. Ask the smallest concrete question, then continue the original task after
            the user responds. Do not ask for facts you can discover safely, implementation
            tactics, permission scope changes, or whether to continue already authorized work.
            For an action requiring approval, attempt the exact action so the host can present
            its permission card. An ask_user answer never grants tool permission. If the user
            explicitly requires confirmation before editing, do not invoke write/edit until
            native approval is available or the user separately confirms the concrete edit;
            leave it blocked rather than treating an ask_user answer as authorization.
            If ask_user returns unanswered, do not infer consent, repeat the same question, or
            claim the dependent work is complete. Continue independent authorized work; when
            none remains, report the specific missing decision and current progress.

            When running Python scripts or commands, always use `python3` instead of `python`.
        "}
    }
}

impl DeveloperClient {
    pub fn new(context: PlatformExtensionContext) -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(EXTENSION_NAME, "1.0.0").with_title("Developer"))
            .with_instructions(developer_instructions());

        Ok(Self {
            info,
            session_manager: context.session_manager,
            shell_tool: Arc::new(ShellTool::new(context.use_login_shell_path)?),
            edit_tools: Arc::new(EditTools::new()),
            tree_tool: Arc::new(TreeTool::new()),
            image_tool: Arc::new(ImageTool::new()),
            search_tool: Arc::new(SearchTool::new()),
            document_tool: Arc::new(DocumentTool::new()),
        })
    }

    fn schema<T: JsonSchema>() -> JsonObject {
        serde_json::to_value(schema_for!(T))
            .expect("schema serialization should succeed")
            .as_object()
            .expect("schema should serialize to an object")
            .clone()
    }

    pub fn parse_args<T: serde::de::DeserializeOwned>(
        arguments: Option<JsonObject>,
    ) -> Result<T, String> {
        let value = arguments
            .map(Value::Object)
            .ok_or_else(|| "Missing arguments".to_string())?;
        serde_json::from_value(value).map_err(|e| format!("Failed to parse arguments: {e}"))
    }

    pub(crate) fn get_tools() -> Vec<Tool> {
        let mut shell_schema = Self::schema::<ShellParams>();
        if let Some(properties) = shell_schema
            .get_mut("properties")
            .and_then(Value::as_object_mut)
        {
            properties.insert("process_action".into(), serde_json::json!({"type":"string","enum":["start","status","stop"],"description":"Optional managed long-running process operation. For start supply a foreground server command; no shell backgrounding. For status/stop reuse its handle and exact original command. Omit for ordinary finite commands."}));
            properties.insert("process_handle".into(), serde_json::json!({"type":"string","description":"Host-issued session process handle, only for status/stop. Never invent a handle or substitute a PID."}));
            properties.insert("port".into(), serde_json::json!({"type":"integer","minimum":1,"maximum":65535,"description":"For managed web-service start, the concrete port used in the command. The host refuses occupied ports and checks whether the listener belongs to its process group; HTTP readiness must still be verified."}));
        }
        vec![
            Tool::new(
                "ask_user".to_string(),
                "Ask the user for a genuinely missing, material user-owned decision when no safe low-risk default exists. Do not use for tool authorization, technical implementation choices, recoverable tool failures, or confirmation to continue authorized work. An unanswered result grants nothing; continue independent authorized work and report a concrete blocker if needed.".to_string(),
                Self::schema::<AskUserParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Ask User".to_string()),
                Some(true),
                Some(false),
                Some(false),
                Some(false),
            )),
            Tool::new(
                "write".to_string(),
                "Create a new file or overwrite an existing file. Creates parent directories if needed.".to_string(),
                Self::schema::<FileWriteParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Write".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            )),
            Tool::new(
                "edit".to_string(),
                "Edit a file by finding and replacing text. The before text must match exactly and uniquely. Use empty after text to delete.".to_string(),
                Self::schema::<FileEditParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Edit".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            )),
            Tool::new(
                "shell".to_string(),
                format!(
                    "Execute a shell command in the current dir. Commands run under `{shell}` \
                     (set GOOSE_SHELL to override) - write command strings in that shell's \
                     syntax. Returns an object with stdout and stderr as separate fields. The \
                     output of each stream is limited to up to 2000 lines, and longer outputs \
                     will be saved to a temporary file. Execution is non-interactive: stdin is closed. \
                     Run finite checks separately from starting long-lived services. Do not use \
                     interactive wait commands. For an authorized background service, explicitly \
                     use process_action=start with the foreground command. The host redirects \
                     streams and returns a session-owned handle for status/stop. Check readiness \
                     separately against this workspace, not just a shared port's HTTP 200. \
                     An output-drain timeout does not mean a background child stopped; \
                     never launch duplicates or kill unrelated processes by executable name. \
                     Nonzero exit is a failed command, not proof that no files changed. \
                     Use the returned cwd and exact command when registering execution evidence.",
                    shell = shell_display_name(),
                ),
                shell_schema,
            )
            .with_output_schema::<ShellOutput>()
            .annotate(ToolAnnotations::from_raw(
                Some("Shell".to_string()),
                Some(false),
                Some(true),
                Some(false),
                Some(true),
            )),
            Tool::new(
                "tree".to_string(),
                "List a directory tree with line counts. Traversal respects .gitignore rules.".to_string(),
                Self::schema::<TreeParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Tree".to_string()),
                Some(true),
                Some(false),
                Some(true),
                Some(false),
            )),
            Tool::new(
                "search".to_string(),
                "Search for literal text in UTF-8 files inside the current workspace. Respects .gitignore and returns bounded path:line:text matches."
                    .to_string(),
                Self::schema::<SearchParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Search".to_string()),
                Some(true),
                Some(false),
                Some(true),
                Some(false),
            )),
            Tool::new(
                "read_image".to_string(),
                "Read an image from a local file path or http(s) URL and return it as image content for the model to inspect. Supports png, jpeg, gif, and webp.".to_string(),
                Self::schema::<ImageReadParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Read Image".to_string()),
                Some(false),
                Some(false),
                Some(true),
                Some(true),
            )),
            Tool::new(
                "read_document".to_string(),
                "Read text from a workspace file. Supports text, PDF, DOCX, XLSX, and PPTX with bounded output."
                    .to_string(),
                Self::schema::<DocumentReadParams>(),
            )
            .annotate(ToolAnnotations::from_raw(
                Some("Read Document".to_string()),
                Some(true),
                Some(false),
                Some(true),
                Some(false),
            )),
        ]
    }
}

#[async_trait]
impl McpClientTrait for DeveloperClient {
    async fn list_tools(
        &self,
        _session_id: &str,
        _next_cursor: Option<String>,
        _cancellation_token: CancellationToken,
    ) -> Result<ListToolsResult, Error> {
        Ok(ListToolsResult {
            tools: Self::get_tools(),
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        ctx: &ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
        cancel_token: CancellationToken,
    ) -> Result<CallToolResult, Error> {
        let working_dir = ctx.working_dir.as_deref();
        if name == "shell"
            && arguments
                .as_ref()
                .is_some_and(|args| args.contains_key("process_action"))
        {
            let params = Self::parse_args::<managed_process::ProcessParams>(arguments);
            return Ok(match (params, working_dir) {
                (Ok(params), Some(cwd)) => {
                    self.shell_tool
                        .processes
                        .execute(
                            params,
                            cwd,
                            &ctx.session_id,
                            self.shell_tool.output_dir.path(),
                            cancel_token,
                            self.session_manager.process_tracker(&ctx.session_id),
                        )
                        .await
                }
                (Err(error), _) => ShellTool::error_result(&error, None),
                (_, None) => ShellTool::error_result(
                    "Managed processes require a bound working directory",
                    None,
                ),
            });
        }
        match name {
            "ask_user" => match Self::parse_args::<AskUserParams>(arguments) {
                Ok(params) => Ok(ask_user(params, ctx).await),
                Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {error}"
                ))
                .with_priority(0.0)])),
            },
            "shell" => match Self::parse_args::<ShellParams>(arguments) {
                Ok(params) => Ok(self
                    .shell_tool
                    .shell_with_cwd_tracked(
                        params,
                        working_dir,
                        Some(&ctx.session_id),
                        cancel_token,
                        self.session_manager.process_tracker(&ctx.session_id),
                    )
                    .await),
                Err(error) => Ok(ShellTool::error_result(&format!("Error: {error}"), None)),
            },
            "write" => match Self::parse_args::<FileWriteParams>(arguments) {
                Ok(params) => Ok(self.edit_tools.file_write_with_cwd(params, working_dir)),
                Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {error}"
                ))
                .with_priority(0.0)])),
            },
            "edit" => match Self::parse_args::<FileEditParams>(arguments) {
                Ok(params) => Ok(self.edit_tools.file_edit_with_cwd(params, working_dir)),
                Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {error}"
                ))
                .with_priority(0.0)])),
            },
            "tree" => match Self::parse_args::<TreeParams>(arguments) {
                Ok(params) => Ok(self.tree_tool.tree_with_cwd(params, working_dir)),
                Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {error}"
                ))
                .with_priority(0.0)])),
            },
            "search" => match Self::parse_args::<SearchParams>(arguments) {
                Ok(params) => Ok(self.search_tool.search_with_cwd(params, working_dir)),
                Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {error}"
                ))
                .with_priority(0.0)])),
            },
            "read_image" => match Self::parse_args::<ImageReadParams>(arguments) {
                Ok(params) => Ok(self
                    .image_tool
                    .image_read_with_cwd(params, working_dir)
                    .await),
                Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {error}"
                ))
                .with_priority(0.0)])),
            },
            "read_document" => match Self::parse_args::<DocumentReadParams>(arguments) {
                Ok(params) => Ok(self.document_tool.document_read_with_cwd_authorized(
                    params,
                    working_dir,
                    ctx.explicit_user_confirmation,
                )),
                Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {error}"
                ))
                .with_priority(0.0)])),
            },
            _ => Ok(CallToolResult::error(vec![Content::text(format!(
                "Error: Unknown tool: {name}"
            ))
            .with_priority(0.0)])),
        }
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionManager;
    #[cfg(not(windows))]
    use rmcp::model::RawContent;
    use rmcp::object;
    use std::fs;

    #[test]
    fn developer_tools_are_flat() {
        let names: Vec<String> = DeveloperClient::get_tools()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();

        assert_eq!(
            names,
            vec![
                "ask_user",
                "write",
                "edit",
                "shell",
                "tree",
                "search",
                "read_image",
                "read_document"
            ]
        );
    }

    #[test]
    fn developer_instructions_require_directory_discovery_after_missing_documents() {
        let instructions = developer_instructions();

        assert!(instructions.contains("Do not guess another file path"));
        assert!(instructions.contains("read_document reports path_not_found"));
        assert!(instructions.contains("use tree on the nearest existing directory"));
    }

    #[test]
    fn read_image_annotations_reflect_network_access() {
        let read_image = DeveloperClient::get_tools()
            .into_iter()
            .find(|tool| tool.name == "read_image")
            .unwrap();
        let annotations = read_image.annotations.unwrap();

        assert_eq!(annotations.read_only_hint, Some(false));
        assert_eq!(annotations.open_world_hint, Some(true));
    }

    fn test_context(data_dir: std::path::PathBuf) -> PlatformExtensionContext {
        PlatformExtensionContext {
            extension_manager: None,
            session_manager: Arc::new(SessionManager::new(data_dir)),
            session: None,
            use_login_shell_path: false,
        }
    }

    #[cfg(not(windows))]
    fn first_text(result: &CallToolResult) -> &str {
        match &result.content[0].raw {
            RawContent::Text(text) => &text.text,
            _ => panic!("expected text content"),
        }
    }

    #[tokio::test]
    async fn developer_client_uses_working_dir_for_file_tools() {
        let temp = tempfile::tempdir().unwrap();
        let client = DeveloperClient::new(test_context(temp.path().join("sessions"))).unwrap();
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();

        let ctx = ToolCallContext::new("session".to_owned(), Some(cwd.clone()), None);
        let write = client
            .call_tool(
                &ctx,
                "write",
                Some(object!({
                    "path": "notes.txt",
                    "content": "first line"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(write.is_error, Some(false));
        assert_eq!(
            fs::read_to_string(cwd.join("notes.txt")).unwrap(),
            "first line"
        );

        let edit = client
            .call_tool(
                &ctx,
                "edit",
                Some(object!({
                    "path": "notes.txt",
                    "before": "first",
                    "after": "updated"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(edit.is_error, Some(false));
        assert_eq!(
            fs::read_to_string(cwd.join("notes.txt")).unwrap(),
            "updated line"
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn developer_client_passes_session_id_to_shell_tool() {
        let temp = tempfile::tempdir().unwrap();
        let client = DeveloperClient::new(test_context(temp.path().join("sessions"))).unwrap();
        let ctx = ToolCallContext::new("session-789".to_owned(), None, None);

        let result = client
            .call_tool(
                &ctx,
                "shell",
                Some(object!({
                    "command": "printenv AGENT_SESSION_ID"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(result.is_error, Some(false));
        assert_eq!(first_text(&result), "session-789");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn developer_client_uses_working_dir_for_shell_tool() {
        let temp = tempfile::tempdir().unwrap();
        let client = DeveloperClient::new(test_context(temp.path().join("sessions"))).unwrap();
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();

        let ctx = ToolCallContext::new("session".to_owned(), Some(cwd.clone()), None);
        let result = client
            .call_tool(
                &ctx,
                "shell",
                Some(object!({
                    "command": "pwd"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(false));
        let observed = std::fs::canonicalize(first_text(&result)).unwrap();
        let expected = std::fs::canonicalize(&cwd).unwrap();
        assert_eq!(observed, expected);
    }
}
