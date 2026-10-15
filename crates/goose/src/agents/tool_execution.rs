use async_stream::try_stream;
use futures::stream::{self, BoxStream};
use futures::{Stream, StreamExt};
use rmcp::model::CallToolResult;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::future::Future;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

use crate::agents::codepro_simple_change_run::is_validation_command;
use crate::agents::extension_manager::{
    insert_trusted_codepro_failure_meta, insert_trusted_tool_audit_error,
    insert_trusted_tool_audit_meta,
};
use crate::agents::protocol::{ControlCommand, RunId, TaskId, TaskWorkspaceGrant};
use crate::agents::tester_runtime::{HostVerificationSpec, TesterRuntimeProbe};
use crate::agents::tool_audit::{
    EffectiveModel, ToolAuditActor, ToolAuditAuthorization, ToolAuditOutcome,
};
use crate::agents::tool_confirmation_router::ToolConfirmationOutcome;
use crate::agents::tool_security::{ToolExtensionSource, ToolSecurityProfile};
use crate::config::permission::CodeProTaskScope;
use crate::config::permission::PermissionLevel;
use crate::conversation::message::{
    Message, ToolAuthorizationScope, ToolExtensionSource as DisplayToolExtensionSource,
    ToolPermissionClass, ToolPermissionContext,
};
use crate::mcp_utils::ToolResult;
use crate::permission::failure_semantics::CodeProFailureKind;
use crate::permission::permission_judge::PermissionCheckResult;
use crate::permission::Permission;
use crate::session::SessionType;
use rmcp::model::{Content, ErrorCode, ErrorData, ServerNotification};

#[derive(Debug)]
pub(crate) struct WorkspaceScopeViolation {
    message: String,
}

impl WorkspaceScopeViolation {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: format!(
                "CodePro task write_scope policy violation; NEEDS_REVIEW: {}",
                message.into()
            ),
        }
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceEntryStamp {
    File(blake3::Hash),
    Symlink,
    Other,
}

pub(crate) type WorkspaceSnapshot = BTreeMap<String, WorkspaceEntryStamp>;

#[derive(Default)]
pub(crate) struct WorkspaceDelta {
    pub(crate) changed_paths: Vec<String>,
    pub(crate) resource_versions: Option<BTreeMap<String, String>>,
    pub(crate) resource_version_limitations: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct CodeProWorkspaceWriteGuard {
    workspace_root: PathBuf,
    task_scope: CodeProTaskScope,
    audit_shell_delta: bool,
    observed_workspace_path: Option<PathBuf>,
    observed_supplied_path: Option<PathBuf>,
    observation_only: bool,
}

impl CodeProWorkspaceWriteGuard {
    #[cfg(test)]
    pub(crate) fn prepare(
        task_scope: Option<&CodeProTaskScope>,
        working_dir: Option<&Path>,
        explicit_user_confirmation: bool,
        extension_name: &str,
        tool_name: &str,
        arguments: Option<&rmcp::model::JsonObject>,
    ) -> Result<Option<Self>, WorkspaceScopeViolation> {
        Self::prepare_with_tester_runtime(
            task_scope,
            working_dir,
            explicit_user_confirmation,
            false,
            extension_name,
            tool_name,
            arguments,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)] // Independent runtime and permission inputs stay explicit.
    pub(crate) fn prepare_with_tester_runtime(
        task_scope: Option<&CodeProTaskScope>,
        working_dir: Option<&Path>,
        explicit_user_confirmation: bool,
        root_full_access: bool,
        extension_name: &str,
        tool_name: &str,
        arguments: Option<&rmcp::model::JsonObject>,
        tester_runtime: Option<&TesterRuntimeProbe>,
    ) -> Result<Option<Self>, WorkspaceScopeViolation> {
        let Some(task_scope) = task_scope else {
            return Ok(None);
        };
        let observation_only = root_full_access && task_scope.is_durable_main_agent();
        let git_observation = extension_name == "local_git"
            && super::git_mcp::mutates_repository(tool_name)
            && observation_only;
        if !git_observation
            && (extension_name != "developer" || !matches!(tool_name, "write" | "edit" | "shell"))
        {
            return Ok(None);
        }
        if tool_name == "shell"
            && !observation_only
            && arguments.is_some_and(|args| args.contains_key("process_action"))
        {
            return Err(WorkspaceScopeViolation::new(
                "Managed long-running processes require the authorized full-access Main Agent; bounded workers cannot retain background processes",
            ));
        }
        if tool_name == "shell" && !observation_only {
            let command = arguments
                .and_then(|arguments| arguments.get("command"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| WorkspaceScopeViolation::new("shell command is missing"))?;
            let host_selected_validation = tester_runtime.is_some_and(|runtime| {
                working_dir.is_some_and(|working_dir| {
                    HostVerificationSpec::from_command_in_workspace(
                        command,
                        Some(runtime),
                        working_dir,
                    )
                    .is_ok()
                })
            });
            if !is_validation_command(command) && !host_selected_validation {
                return Err(WorkspaceScopeViolation::new(
                    "bounded shell only permits non-mutating validation commands; request a dedicated file tool or explicit user scope for other changes",
                ));
            }
        }
        let workspace_root = task_scope
            .workspace_root()
            .ok_or_else(|| WorkspaceScopeViolation::new("task workspace is not bound"))?
            .canonicalize()
            .map_err(|error| {
                WorkspaceScopeViolation::new(format!("cannot resolve task workspace: {error}"))
            })?;
        let mut guard = Self {
            workspace_root,
            task_scope: task_scope.clone(),
            // A validated command may legitimately update test logs, snapshots, coverage,
            // caches, or other generated artifacts inside the user-bound workspace. The
            // workspace itself is already authorized; command-shape validation above still
            // rejects state-changing shell commands, while direct file tools retain their
            // task-scope checks.
            audit_shell_delta: observation_only && (tool_name == "shell" || git_observation),
            observed_workspace_path: None,
            observed_supplied_path: None,
            observation_only,
        };

        if matches!(tool_name, "write" | "edit") {
            let path = arguments
                .and_then(|arguments| arguments.get("path"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| WorkspaceScopeViolation::new("file tool path is missing"))?;
            guard.observed_workspace_path = if observation_only {
                let target = Path::new(path);
                let target = if target.is_absolute() {
                    target.to_path_buf()
                } else {
                    working_dir.unwrap_or(&guard.workspace_root).join(target)
                };
                Some(
                    target
                        .strip_prefix(&guard.workspace_root)
                        .unwrap_or(&target)
                        .to_path_buf(),
                )
            } else {
                guard.validate_direct_path(path, working_dir, explicit_user_confirmation)?
            };
            if guard.observed_workspace_path.is_some() {
                let supplied = Path::new(path);
                guard.observed_supplied_path = Some(if supplied.is_absolute() {
                    supplied.to_path_buf()
                } else {
                    working_dir
                        .unwrap_or(&guard.workspace_root)
                        .canonicalize()
                        .map_err(|error| {
                            WorkspaceScopeViolation::new(format!(
                                "cannot resolve tool working directory: {error}"
                            ))
                        })?
                        .join(supplied)
                });
            }
        }
        Ok(Some(guard))
    }

    pub(crate) fn before_execution(
        &self,
    ) -> Result<Option<WorkspaceSnapshot>, WorkspaceScopeViolation> {
        self.confirm_observed_path_identity()?;
        if let Some(relative) = self.observed_workspace_path.as_deref() {
            snapshot_workspace_path(&self.workspace_root, relative).map(Some)
        } else if self.audit_shell_delta {
            snapshot_workspace(&self.workspace_root).map(Some)
        } else {
            Ok(None)
        }
    }

    pub(crate) fn after_execution(
        &self,
        before: Option<WorkspaceSnapshot>,
    ) -> Result<WorkspaceDelta, WorkspaceScopeViolation> {
        self.confirm_observed_path_identity()?;
        let Some(before) = before else {
            return Ok(WorkspaceDelta::default());
        };
        let after = if let Some(relative) = self.observed_workspace_path.as_deref() {
            snapshot_workspace_path(&self.workspace_root, relative)?
        } else {
            snapshot_workspace(&self.workspace_root)?
        };
        let mut violations = Vec::new();
        let mut changed_paths = Vec::new();

        for (relative, stamp) in &after {
            if before.get(relative) == Some(stamp) {
                continue;
            }
            if self.observation_only
                || self.task_scope.write_scope_allows_path(Path::new(relative))
                || self
                    .observed_workspace_path
                    .as_deref()
                    .is_some_and(|target| target.to_string_lossy().replace('\\', "/") == *relative)
            {
                changed_paths.push(relative.clone());
                continue;
            }
            if !before.contains_key(relative) {
                let target = self.workspace_root.join(relative);
                match fs::symlink_metadata(&target) {
                    Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
                        if let Err(error) = fs::remove_file(&target) {
                            violations.push(format!(
                                "new out-of-scope file {relative} could not be isolated: {error}"
                            ));
                            continue;
                        }
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        violations.push(format!(
                            "new out-of-scope path {relative} could not be inspected: {error}"
                        ));
                        continue;
                    }
                }
                violations.push(format!("created {relative}"));
            } else {
                violations.push(format!("modified pre-existing {relative}"));
            }
        }

        for relative in before.keys() {
            if after.contains_key(relative) {
                continue;
            }
            if self.observation_only
                || self.task_scope.write_scope_allows_path(Path::new(relative))
                || self
                    .observed_workspace_path
                    .as_deref()
                    .is_some_and(|target| target.to_string_lossy().replace('\\', "/") == *relative)
            {
                changed_paths.push(relative.clone());
            } else {
                violations.push(format!("deleted pre-existing {relative}"));
            }
        }

        if violations.is_empty() {
            changed_paths.sort_unstable();
            changed_paths.dedup();
            let mut versions = BTreeMap::new();
            let mut limitations = Vec::new();
            for relative in &changed_paths {
                let path = self.workspace_root.join(relative);
                let version = match after.get(relative) {
                    Some(WorkspaceEntryStamp::File(hash)) => Some(format!("blake3:{hash}")),
                    None => Some("deleted".to_string()),
                    Some(WorkspaceEntryStamp::Symlink | WorkspaceEntryStamp::Other) => None,
                };
                let identity = if after.contains_key(relative) {
                    path.canonicalize().ok()
                } else {
                    canonical_missing_target(&path)
                };
                match (identity, version) {
                    (Some(identity), Some(version)) => {
                        versions.insert(identity.to_string_lossy().to_string(), version);
                    }
                    _ => limitations.push(format!(
                        "{}: no canonical regular-file content version was observed",
                        path.display()
                    )),
                }
            }
            Ok(WorkspaceDelta {
                changed_paths,
                resource_versions: limitations.is_empty().then_some(versions),
                resource_version_limitations: limitations,
            })
        } else {
            Err(WorkspaceScopeViolation::new(violations.join(", ")))
        }
    }

    fn confirm_observed_path_identity(&self) -> Result<(), WorkspaceScopeViolation> {
        if self.observation_only {
            return Ok(());
        }
        let (Some(supplied), Some(approved_relative)) = (
            self.observed_supplied_path.as_deref(),
            self.observed_workspace_path.as_deref(),
        ) else {
            return Ok(());
        };
        let current = self
            .task_scope
            .canonical_workspace_target(supplied)
            .ok_or_else(|| {
                WorkspaceScopeViolation::new("file path changed or now escapes the workspace")
            })?;
        if current != self.workspace_root.join(approved_relative) {
            return Err(WorkspaceScopeViolation::new(
                "file path resolves to a different target than the approved action",
            ));
        }
        Ok(())
    }

    fn validate_direct_path(
        &self,
        supplied: &str,
        working_dir: Option<&Path>,
        explicit_user_confirmation: bool,
    ) -> Result<Option<PathBuf>, WorkspaceScopeViolation> {
        let supplied = Path::new(supplied);
        if supplied.is_absolute() {
            if let Some(relative) = workspace_relative_path(&self.workspace_root, supplied) {
                let resolved =
                    self.validate_workspace_relative_path(&relative, explicit_user_confirmation)?;
                return Ok(Some(resolved));
            }
            self.validate_confirmed_external_file(supplied, explicit_user_confirmation)?;
            return Ok(None);
        }
        if supplied.as_os_str().is_empty()
            || supplied.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(WorkspaceScopeViolation::new(format!(
                "unsafe file path {}",
                supplied.display()
            )));
        }

        let base = working_dir.unwrap_or(&self.workspace_root);
        let base = base.canonicalize().map_err(|error| {
            WorkspaceScopeViolation::new(format!("cannot resolve tool working directory: {error}"))
        })?;
        let base_relative = base.strip_prefix(&self.workspace_root).map_err(|_| {
            WorkspaceScopeViolation::new("tool working directory is outside the task workspace")
        })?;
        let mut relative = base_relative.to_path_buf();
        for component in supplied.components() {
            if let Component::Normal(name) = component {
                relative.push(name);
            }
        }
        let resolved =
            self.validate_workspace_relative_path(&relative, explicit_user_confirmation)?;
        Ok(Some(resolved))
    }

    fn validate_workspace_relative_path(
        &self,
        relative: &Path,
        explicit_user_confirmation: bool,
    ) -> Result<PathBuf, WorkspaceScopeViolation> {
        let target = self.workspace_root.join(relative);
        let canonical = self
            .task_scope
            .canonical_workspace_target(&target)
            .ok_or_else(|| {
                WorkspaceScopeViolation::new(format!(
                    "workspace path cannot be safely resolved: {}",
                    relative.display()
                ))
            })?;
        let resolved = canonical.strip_prefix(&self.workspace_root).map_err(|_| {
            WorkspaceScopeViolation::new("workspace path resolves outside the task workspace")
        })?;
        if !self.task_scope.write_scope_allows_path(resolved) && !explicit_user_confirmation {
            return Err(WorkspaceScopeViolation::new(format!(
                "{} is outside the allowed write_scope",
                resolved.display()
            )));
        }
        Ok(resolved.to_path_buf())
    }

    fn validate_confirmed_external_file(
        &self,
        supplied: &Path,
        explicit_user_confirmation: bool,
    ) -> Result<(), WorkspaceScopeViolation> {
        if !explicit_user_confirmation {
            return Err(WorkspaceScopeViolation::new(format!(
                "external file requires explicit user confirmation: {}",
                supplied.display()
            )));
        }
        if !self
            .task_scope
            .write_scope_allows_confirmed_external_file(supplied)
        {
            return Err(WorkspaceScopeViolation::new(format!(
                "{} is outside the approved exact-file write_scope",
                supplied.display()
            )));
        }
        let metadata = match fs::symlink_metadata(supplied) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return validate_new_external_file_parent(supplied);
            }
            Err(error) => {
                return Err(WorkspaceScopeViolation::new(format!(
                    "cannot inspect approved external file {}: {error}",
                    supplied.display()
                )));
            }
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(WorkspaceScopeViolation::new(
                "approved external target must be a regular file or a new file in an existing regular directory",
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(WorkspaceScopeViolation::new(
                    "approved external target cannot be a reparse point",
                ));
            }
        }
        Ok(())
    }
}

fn canonical_missing_target(path: &Path) -> Option<PathBuf> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(mut canonical) => {
                for part in missing.iter().rev() {
                    canonical.push(part);
                }
                return Some(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(existing.file_name()?.to_os_string());
                existing = existing.parent()?;
            }
            Err(_) => return None,
        }
    }
}

fn is_workspace_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x0400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn hash_workspace_file(path: &Path) -> Result<blake3::Hash, WorkspaceScopeViolation> {
    let mut file = fs::File::open(path).map_err(|error| {
        WorkspaceScopeViolation::new(format!(
            "cannot open workspace file {}: {error}",
            path.display()
        ))
    })?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            WorkspaceScopeViolation::new(format!(
                "cannot hash workspace file {}: {error}",
                path.display()
            ))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize())
}

fn snapshot_workspace_path(
    root: &Path,
    relative: &Path,
) -> Result<WorkspaceSnapshot, WorkspaceScopeViolation> {
    let mut snapshot = WorkspaceSnapshot::new();
    let path = root.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(snapshot),
        Err(error) => {
            return Err(WorkspaceScopeViolation::new(format!(
                "cannot inspect workspace path {}: {error}",
                path.display()
            )))
        }
    };
    let normalized = relative.to_string_lossy().replace('\\', "/");
    let stamp = if is_workspace_link(&metadata) {
        WorkspaceEntryStamp::Symlink
    } else if metadata.is_file() {
        WorkspaceEntryStamp::File(hash_workspace_file(&path)?)
    } else {
        WorkspaceEntryStamp::Other
    };
    snapshot.insert(normalized, stamp);
    Ok(snapshot)
}

fn validate_new_external_file_parent(target: &Path) -> Result<(), WorkspaceScopeViolation> {
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            WorkspaceScopeViolation::new("approved external target has no parent directory")
        })?;
    let metadata = fs::symlink_metadata(parent).map_err(|error| {
        WorkspaceScopeViolation::new(format!(
            "cannot inspect approved external parent {}: {error}",
            parent.display()
        ))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(WorkspaceScopeViolation::new(
            "approved external parent must be an existing regular directory",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(WorkspaceScopeViolation::new(
                "approved external parent cannot be a reparse point",
            ));
        }
    }
    Ok(())
}

fn workspace_relative_path(workspace_root: &Path, supplied: &Path) -> Option<PathBuf> {
    if let Ok(relative) = supplied.strip_prefix(workspace_root) {
        return Some(relative.to_path_buf());
    }

    #[cfg(windows)]
    {
        fn normalize(path: &Path) -> String {
            path.to_string_lossy()
                .replace('\\', "/")
                .trim_start_matches("//?/")
                .trim_end_matches('/')
                .to_string()
        }

        let root = normalize(workspace_root);
        let target = normalize(supplied);
        if target.len() <= root.len()
            || !target
                .get(..root.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&root))
            || target.as_bytes().get(root.len()) != Some(&b'/')
        {
            return None;
        }
        target.get(root.len() + 1..).map(PathBuf::from)
    }

    #[cfg(not(windows))]
    None
}

fn snapshot_workspace(root: &Path) -> Result<WorkspaceSnapshot, WorkspaceScopeViolation> {
    fn visit(
        root: &Path,
        directory: &Path,
        snapshot: &mut WorkspaceSnapshot,
    ) -> Result<(), WorkspaceScopeViolation> {
        let entries = fs::read_dir(directory).map_err(|error| {
            WorkspaceScopeViolation::new(format!(
                "cannot scan workspace directory {}: {error}",
                directory.display()
            ))
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                WorkspaceScopeViolation::new(format!("cannot read workspace entry: {error}"))
            })?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                WorkspaceScopeViolation::new(format!(
                    "cannot inspect workspace path {}: {error}",
                    path.display()
                ))
            })?;
            if metadata.is_dir() && !is_workspace_link(&metadata) {
                visit(root, &path, snapshot)?;
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .expect("workspace traversal remains below its root")
                .to_string_lossy()
                .replace('\\', "/");
            let stamp = if is_workspace_link(&metadata) {
                WorkspaceEntryStamp::Symlink
            } else if metadata.is_file() {
                WorkspaceEntryStamp::File(hash_workspace_file(&path)?)
            } else {
                WorkspaceEntryStamp::Other
            };
            snapshot.insert(relative, stamp);
        }
        Ok(())
    }

    let mut snapshot = WorkspaceSnapshot::new();
    visit(root, root, &mut snapshot)?;
    Ok(snapshot)
}

fn tool_permission_context(
    profile: Option<ToolSecurityProfile>,
    has_task_scope: bool,
    _session_type: SessionType,
) -> ToolPermissionContext {
    let has_resolved_permission_class = profile
        .and_then(|profile| profile.permission_class)
        .is_some();
    let permission_class = match profile.and_then(|profile| profile.permission_class) {
        Some(crate::agents::platform_extensions::tool_registry::CodeProPermissionClass::ReadOnly) => {
            ToolPermissionClass::ReadOnly
        }
        Some(
            crate::agents::platform_extensions::tool_registry::CodeProPermissionClass::WorkspaceWrite,
        ) => ToolPermissionClass::WorkspaceWrite,
        Some(
            crate::agents::platform_extensions::tool_registry::CodeProPermissionClass::ExternalWrite,
        ) => ToolPermissionClass::ExternalWrite,
        Some(crate::agents::platform_extensions::tool_registry::CodeProPermissionClass::HighRisk) => {
            ToolPermissionClass::HighRisk
        }
        Some(crate::agents::platform_extensions::tool_registry::CodeProPermissionClass::Forbidden) => {
            ToolPermissionClass::Forbidden
        }
        None => ToolPermissionClass::Legacy,
    };
    let extension_source = match profile.map(|profile| profile.source) {
        Some(ToolExtensionSource::Platform) => DisplayToolExtensionSource::Platform,
        Some(ToolExtensionSource::Builtin) => DisplayToolExtensionSource::Builtin,
        Some(ToolExtensionSource::ExternalStdio) => DisplayToolExtensionSource::ExternalStdio,
        Some(ToolExtensionSource::ExternalHttp) => DisplayToolExtensionSource::ExternalHttp,
        Some(ToolExtensionSource::Frontend) => DisplayToolExtensionSource::Frontend,
        Some(ToolExtensionSource::InlinePython) => DisplayToolExtensionSource::InlinePython,
        Some(ToolExtensionSource::Unknown) | None => DisplayToolExtensionSource::Unknown,
    };
    let authorization_scope = if has_task_scope {
        ToolAuthorizationScope::Task
    } else if has_resolved_permission_class {
        ToolAuthorizationScope::Session
    } else {
        ToolAuthorizationScope::Global
    };

    ToolPermissionContext {
        permission_class,
        extension_source,
        authorization_scope,
        task_workspace_root: None,
    }
}

/// Context passed through the tool call dispatch chain.
#[derive(Clone)]
pub struct ToolCallContext {
    pub session_id: String,
    pub working_dir: Option<PathBuf>,
    pub tool_call_request_id: Option<String>,
    pub(crate) codepro_task_scope: Option<CodeProTaskScope>,
    pub(crate) codepro_tester_runtime: Option<TesterRuntimeProbe>,
    pub(crate) explicit_user_confirmation: bool,
    pub(crate) codepro_auto_full_access: bool,
    pub(crate) computer_operation_method: super::tool_task::ComputerOperationMethod,
    pub(crate) actor: ToolAuditActor,
    pub(crate) effective_model: EffectiveModel,
    pub(crate) audit_authorization: ToolAuditAuthorization,
    pub(crate) codepro_runtime: Option<crate::agents::control_plane::CodeProRuntime>,
    pub(crate) codepro_event_log_root: Option<PathBuf>,
}

impl ToolCallContext {
    pub(crate) async fn admit_business_action(
        &self,
    ) -> anyhow::Result<Option<tokio::sync::OwnedMutexGuard<()>>> {
        let (Some(runtime), Some(scope)) = (&self.codepro_runtime, &self.codepro_task_scope) else {
            return Ok(None);
        };
        // A bound parent session identifies a durable control-plane task. A
        // standalone simple-change scope has no durable run to inspect here.
        let Some(parent_session_id) = scope.permission_session_id() else {
            return Ok(None);
        };
        let run_id = RunId::new(scope.run_id().to_string())?;
        let task_id = TaskId::new(scope.task_id().to_string())?;
        let request_id = self
            .tool_call_request_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("durable tool action has no request identity"))?;
        let guard = runtime
            .admit_action(
                parent_session_id,
                &run_id,
                &task_id,
                request_id,
                scope.task_workspace_grant_revision(),
            )
            .await?;
        Ok(Some(guard))
    }

    pub fn new(
        session_id: String,
        working_dir: Option<PathBuf>,
        tool_call_request_id: Option<String>,
    ) -> Self {
        Self {
            session_id,
            working_dir,
            tool_call_request_id,
            codepro_task_scope: None,
            codepro_tester_runtime: None,
            explicit_user_confirmation: false,
            codepro_auto_full_access: false,
            computer_operation_method: Default::default(),
            actor: ToolAuditActor::HostUnknown,
            effective_model: EffectiveModel::new("unknown").expect("unknown is a valid model"),
            audit_authorization: ToolAuditAuthorization::PolicyAllowed,
            codepro_runtime: None,
            codepro_event_log_root: None,
        }
    }

    pub(crate) fn with_codepro_runtime_context(
        mut self,
        runtime: Option<crate::agents::control_plane::CodeProRuntime>,
        event_log_root: Option<PathBuf>,
    ) -> Self {
        self.codepro_runtime = runtime;
        self.codepro_event_log_root = event_log_root;
        self
    }

    pub(crate) fn with_codepro_task_scope(mut self, scope: CodeProTaskScope) -> Self {
        self.codepro_task_scope = Some(scope);
        self
    }

    pub(crate) fn with_codepro_auto_full_access(mut self, enabled: bool) -> Self {
        self.codepro_auto_full_access = enabled;
        self
    }

    pub(crate) fn with_codepro_tester_runtime(
        mut self,
        runtime: Option<TesterRuntimeProbe>,
    ) -> Self {
        self.codepro_tester_runtime = runtime;
        self
    }

    pub(crate) fn with_explicit_user_confirmation(mut self, confirmed: bool) -> Self {
        self.explicit_user_confirmation = confirmed;
        self
    }

    pub(crate) fn with_audit_identity(
        mut self,
        actor: ToolAuditActor,
        effective_model: EffectiveModel,
    ) -> Self {
        self.actor = actor;
        self.effective_model = effective_model;
        self
    }

    pub(crate) fn with_audit_authorization(
        mut self,
        authorization: ToolAuditAuthorization,
    ) -> Self {
        self.audit_authorization = authorization;
        self
    }

    #[cfg(any(feature = "code-mode", test))]
    pub(crate) fn for_nested_tool_call(&self) -> Self {
        let mut nested = self.clone();
        nested.tool_call_request_id = Some(format!("nested-{}", uuid::Uuid::new_v4()));
        nested.explicit_user_confirmation = false;
        nested.audit_authorization = ToolAuditAuthorization::PolicyAllowed;
        nested
    }

    pub fn working_dir_str(&self) -> Option<&str> {
        self.working_dir.as_ref().and_then(|p| p.to_str())
    }
}

// ToolCallResult combines the result of a tool call with an optional notification stream that
// can be used to receive notifications from the tool.
pub struct ToolCallResult {
    pub result: Box<dyn Future<Output = ToolResult<rmcp::model::CallToolResult>> + Send + Unpin>,
    pub notification_stream: Option<Box<dyn Stream<Item = ServerNotification> + Send + Unpin>>,
    pub action_required_stream: Option<Box<dyn Stream<Item = Message> + Send + Unpin>>,
}

impl From<ToolResult<rmcp::model::CallToolResult>> for ToolCallResult {
    fn from(result: ToolResult<rmcp::model::CallToolResult>) -> Self {
        Self {
            result: Box::new(futures::future::ready(result)),
            notification_stream: None,
            action_required_stream: None,
        }
    }
}

use super::agent::{tool_stream, ToolStream};
use crate::agents::Agent;
use crate::conversation::message::ToolRequest;
use crate::session::Session;
use crate::tool_inspection::get_security_finding_id_from_results;

pub const USER_DENIED_RESPONSE: &str = "The user has declined to run this tool. \
    DO NOT attempt to call this tool again. \
    If there are no alternative methods to proceed, clearly explain the situation and STOP.";

pub const POLICY_DENIED_RESPONSE: &str = "The host policy has blocked this tool call. \
    DO NOT retry the same blocked action. \
    Explain that policy prevented the action and suggest a safer permitted alternative.";

pub const FORBIDDEN_RESPONSE: &str = "The host has forbidden this tool call. \
    DO NOT retry this operation. Explain that this operation is not permitted and suggest a safer alternative.";

pub const CANCELLED_RESPONSE: &str = "The tool approval was cancelled. Do not run the tool. \
    Ask the user to restart the action if they still want it.";

pub const ENVIRONMENT_FAILURE_RESPONSE: &str =
    "The host could not complete the tool approval request. \
    Do not treat this as a user denial. Ask the user to check the environment and retry.";

fn confirmation_failure_contract(
    outcome: &ToolConfirmationOutcome,
) -> Option<(CodeProFailureKind, &'static str)> {
    match outcome {
        ToolConfirmationOutcome::Selected(_)
        | ToolConfirmationOutcome::TaskWorkspaceGrant { .. } => None,
        ToolConfirmationOutcome::Cancelled => {
            Some((CodeProFailureKind::Cancelled, CANCELLED_RESPONSE))
        }
        ToolConfirmationOutcome::PolicyDenied => {
            Some((CodeProFailureKind::PolicyDenied, POLICY_DENIED_RESPONSE))
        }
        ToolConfirmationOutcome::Forbidden => {
            Some((CodeProFailureKind::Forbidden, FORBIDDEN_RESPONSE))
        }
        ToolConfirmationOutcome::EnvironmentFailure => Some((
            CodeProFailureKind::EnvironmentFailure,
            ENVIRONMENT_FAILURE_RESPONSE,
        )),
    }
}

pub const CHAT_MODE_TOOL_SKIPPED_RESPONSE: &str = "Let the user know the tool call was skipped in goose chat mode. \
                                        DO NOT apologize for skipping the tool call. DO NOT say sorry. \
                                        Provide an explanation of what the tool call would do, structured as a \
                                        plan for the user. Again, DO NOT apologize. \
                                        **Example Plan:**\n \
                                        1. **Identify Task Scope** - Determine the purpose and expected outcome.\n \
                                        2. **Outline Steps** - Break down the steps.\n \
                                        If needed, adjust the explanation based on user preferences or questions.";

impl Agent {
    async fn commit_task_workspace_grant(
        &self,
        session: &Session,
        task_scope: Option<&CodeProTaskScope>,
        approval_request_id: &str,
        option_id: &str,
    ) -> Result<(), String> {
        if session.session_type != SessionType::CodePro {
            return Err("delegated sessions cannot enlarge the parent task grant".to_string());
        }
        let scope = task_scope.ok_or_else(|| "task workspace is unbound".to_string())?;
        if scope.permission_session_id() != Some(session.id.as_str()) {
            return Err("task grant does not belong to the parent session".to_string());
        }
        let workspace_root = scope
            .workspace_root()
            .ok_or_else(|| "task workspace is unbound".to_string())?
            .canonicalize()
            .map_err(|error| format!("task workspace cannot be resolved: {error}"))?;
        let runtime =
            self.config.codepro_runtime.as_ref().ok_or_else(|| {
                "durable CodePro authorization runtime is unavailable".to_string()
            })?;
        let run_id = RunId::new(scope.run_id().to_string()).map_err(|error| error.to_string())?;
        let source_task_id =
            TaskId::new(scope.task_id().to_string()).map_err(|error| error.to_string())?;
        let snapshot = runtime
            .snapshot(&session.id, &run_id)
            .await
            .map_err(|error| format!("current task authorization cannot be read: {error}"))?;
        let grant_id =
            blake3::hash(format!("{}\0{}\0{}", run_id, approval_request_id, option_id).as_bytes())
                .to_hex()
                .to_string();
        runtime
            .control(
                &session.id,
                ControlCommand::CommitTaskWorkspaceGrant {
                    run_id,
                    grant: TaskWorkspaceGrant {
                        grant_id,
                        source_task_id,
                        request_id: approval_request_id.to_string(),
                        option_id: option_id.to_string(),
                        workspace_root: workspace_root.to_string_lossy().to_string(),
                        requirement_revision: snapshot.projection.user_requirement_revision,
                        authorization_revision: snapshot
                            .projection
                            .authorization_revision
                            .saturating_add(1),
                    },
                },
                Some(snapshot.projection.last_sequence),
            )
            .await
            .map_err(|error| format!("task workspace approval was not committed: {error}"))?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // Approval dispatch carries the existing session context.
    pub(crate) fn handle_approval_tool_requests<'a>(
        &'a self,
        tool_requests: &'a [ToolRequest],
        tool_futures: &'a mut Vec<(String, ToolStream)>,
        request_to_response_map: &'a mut HashMap<String, Message>,
        cancellation_token: Option<CancellationToken>,
        session: &'a Session,
        inspection_results: &'a [crate::tool_inspection::InspectionResult],
        permission_scope: Option<&'a CodeProTaskScope>,
    ) -> BoxStream<'a, anyhow::Result<Message>> {
        try_stream! {
        for request in tool_requests.iter() {
            if let Ok(tool_call) = request.tool_call.clone() {
                let mode = self.permission_mode_for_scope(permission_scope).await;
                let mut current_scope = permission_scope.cloned();
                if let (Some(scope), Some(runtime)) = (current_scope.as_mut(), self.config.codepro_runtime.as_ref()) {
                    if let Some(parent_session) = scope.permission_session_id() {
                        let snapshot = runtime.snapshot(parent_session, &RunId::new(scope.run_id().to_string())?).await?;
                        let mut refreshed = scope.clone().without_mode_full_access().without_task_workspace_grant();
                        if let Some(grant) = snapshot.projection.task_workspace_grant.as_ref() {
                            if grant.requirement_revision == snapshot.projection.user_requirement_revision
                                && grant.source_task_id.as_str() == scope.task_id()
                            {
                                refreshed = refreshed.with_task_workspace_grant(grant).map_err(anyhow::Error::msg)?;
                            }
                        }
                        *scope = refreshed;
                    }
                }
                if mode == crate::config::GooseMode::Auto {
                    current_scope = current_scope.map(CodeProTaskScope::with_mode_full_access);
                }
                let permission_scope = current_scope.as_ref();
                let current_inspections = self.tool_inspection_manager.inspect_tools(
                    &session.id, std::slice::from_ref(request), &[], mode, permission_scope,
                ).await?;
                if mode == crate::config::GooseMode::Chat || current_inspections.iter().any(|result| {
                    matches!(result.action, crate::tool_inspection::InspectionAction::Deny)
                }) {
                    self.handle_denied_tools(
                        &PermissionCheckResult {
                            approved: Vec::new(),
                            needs_approval: Vec::new(),
                            denied: vec![request.clone()],
                        },
                        request_to_response_map,
                        session,
                        permission_scope,
                    ).await;
                    continue;
                }
                if !current_inspections.is_empty() && current_inspections.iter().all(|result| {
                    matches!(result.action, crate::tool_inspection::InspectionAction::Allow)
                }) {
                    let (req_id, result) = self.dispatch_tool_call_with_confirmation_in_scope(
                        tool_call, request.id.clone(), cancellation_token.clone(), session, false, permission_scope,
                    ).await;
                    tool_futures.push((req_id, match result {
                        Ok(result) => tool_stream(
                            result.notification_stream.unwrap_or_else(|| Box::new(stream::empty())),
                            result.action_required_stream.unwrap_or_else(|| Box::new(stream::empty())),
                            result.result,
                        ),
                        Err(error) => tool_stream(Box::new(stream::empty()), Box::new(stream::empty()), futures::future::ready(Err(error))),
                    }));
                    continue;
                }
                let security_message = inspection_results.iter()
                    .find(|result| result.tool_request_id == request.id)
                    .and_then(|result| {
                        if let crate::tool_inspection::InspectionAction::RequireApproval(Some(message)) = &result.action {
                            Some(message.clone())
                        } else {
                            None
                        }
                    });

                let registered_confirmation = self
                    .tool_confirmation_router
                    .register(request.id.clone())
                    .await;

                let profile = match self.tool_inspection_manager.tool_security_profile(&tool_call.name) {
                    Some(profile) => Some(profile),
                    None => self.extension_manager
                        .registered_codepro_tool_security_profile(&tool_call.name)
                        .await,
                };
                let mut permission_context = tool_permission_context(
                    profile,
                    permission_scope.is_some() || self.config.codepro_permission_scope.is_some(),
                    session.session_type,
                );
                if session.session_type == SessionType::CodePro
                    && permission_context.permission_class == ToolPermissionClass::WorkspaceWrite
                    && matches!(tool_call.name.rsplit("__").next(), Some("write" | "edit"))
                    && self.config.codepro_runtime.as_ref().is_some_and(|runtime| {
                        runtime.mode_policy().effective()
                            == crate::agents::control_plane::CodeProRuntimeMode::Durable
                    })
                {
                    permission_context.task_workspace_root = permission_scope
                        .and_then(CodeProTaskScope::workspace_root)
                        .and_then(|root| root.canonicalize().ok())
                        .map(|root| root.to_string_lossy().to_string());
                }
                let approval_request_id = registered_confirmation.confirmation_id.clone();
                let approval_prompt = if let Some(root) = permission_context.task_workspace_root.as_deref() {
                    let scope_disclosure = format!(
                        "“本任务允许”将允许当前 run 在工作区 {root} 内连续创建和编辑文件，并可按委托范围让只读或更窄的子任务使用；不包括 shell、网络、安装、Git 或工作区外写入。只允许这一次仍仅批准当前动作。"
                    );
                    Some(match security_message.as_deref() {
                        Some(message) => format!("{message}\n\n{scope_disclosure}"),
                        None => scope_disclosure,
                    })
                } else {
                    security_message
                };
                let action_required_msg = Message::assistant()
                    .with_action_required_context(
                        approval_request_id.clone(),
                        tool_call.name.to_string().clone(),
                        tool_call.arguments.clone().unwrap_or_default(),
                        approval_prompt,
                        permission_context,
                    )
                    .user_only();
                yield action_required_msg;

                let confirmation_outcome = registered_confirmation.receiver.await
                    .map_err(|_| anyhow::anyhow!("Confirmation channel closed for request {}", request.id))?;
                let (confirmation, grant_option_id) = match confirmation_outcome {
                    ToolConfirmationOutcome::Selected(confirmation) => (confirmation, None),
                    ToolConfirmationOutcome::TaskWorkspaceGrant { confirmation, option_id } => {
                        (confirmation, Some(option_id))
                    }
                    failure => {
                        let (failure_kind, response_text) = confirmation_failure_contract(&failure)
                            .expect("selected confirmations are handled by the preceding match arm");
                        if let Some(response) = request_to_response_map.get_mut(&request.id) {
                            let mut failed_result =
                                CallToolResult::error(vec![Content::text(response_text)]);
                            insert_trusted_codepro_failure_meta(&mut failed_result, failure_kind);
                            response.add_tool_response_with_metadata(
                                request.id.clone(),
                                Ok(failed_result),
                                request.metadata.as_ref(),
                            );
                        }
                        continue;
                    }
                };

                if let Some(finding_id) = get_security_finding_id_from_results(&request.id, inspection_results) {
                    let action = match confirmation.permission {
                        Permission::AllowOnce | Permission::AlwaysAllow => "ALLOW",
                        _ => "BLOCK",
                    };
                    tracing::info!(
                        monotonic_counter.goose.prompt_injection_user_decisions = 1,
                        security.event_type = "user_decision",
                        security.action = action,
                        security.finding_id = %finding_id,
                        tool.request_id = %request.id,
                        user.decision = ?confirmation.permission,
                        "security finding: user decision"
                    );
                }

                if confirmation.permission == Permission::AllowOnce || confirmation.permission == Permission::AlwaysAllow {
                    // A pending card is not a lease on the old policy. Its answer
                    // cannot override a mode change to Chat or an explicit deny
                    // committed while the user was deciding.
                    let current_mode = self.permission_mode_for_scope(permission_scope).await;
                    let confirmed_scope = permission_scope.cloned().map(|scope| {
                        let scope = scope.without_mode_full_access();
                        if current_mode == crate::config::GooseMode::Auto {
                            scope.with_mode_full_access()
                        } else {
                            scope
                        }
                    });
                    let permission_scope = confirmed_scope.as_ref();
                    let confirmation_inspections = self.tool_inspection_manager.inspect_tools(
                        &session.id,
                        std::slice::from_ref(request),
                        &[],
                        current_mode,
                        permission_scope,
                    ).await?;
                    if current_mode == crate::config::GooseMode::Chat
                        || confirmation_inspections.iter().any(|result| {
                            matches!(result.action, crate::tool_inspection::InspectionAction::Deny)
                        })
                    {
                        self.handle_denied_tools(
                            &PermissionCheckResult {
                                approved: Vec::new(),
                                needs_approval: Vec::new(),
                                denied: vec![request.clone()],
                            },
                            request_to_response_map,
                            session,
                            permission_scope,
                        ).await;
                        continue;
                    }
                    if let Some(option_id) = grant_option_id.as_deref() {
                        if let Err(error) = self
                            .commit_task_workspace_grant(
                                session,
                                permission_scope,
                                &approval_request_id,
                                option_id,
                            )
                            .await
                        {
                            if let Some(response) = request_to_response_map.get_mut(&request.id) {
                                response.add_tool_response_with_metadata(
                                    request.id.clone(),
                                    Ok(CallToolResult::error(vec![Content::text(error)])),
                                    request.metadata.as_ref(),
                                );
                            }
                            continue;
                        }
                    }
                    let (req_id, tool_result) = self
                        .dispatch_tool_call_with_confirmation_in_scope(
                            tool_call.clone(),
                            request.id.clone(),
                            cancellation_token.clone(),
                            session,
                            true,
                            permission_scope,
                        )
                        .await;

                    tool_futures.push((req_id, match tool_result {
                        Ok(result) => tool_stream(
                            result.notification_stream.unwrap_or_else(|| Box::new(stream::empty())),
                            result.action_required_stream.unwrap_or_else(|| Box::new(stream::empty())),
                            result.result,
                        ),
                        Err(e) => tool_stream(
                            Box::new(stream::empty()),
                            Box::new(stream::empty()),
                            futures::future::ready(Err(e)),
                        ),
                    }));

                    if confirmation.permission == Permission::AlwaysAllow {
                        self.tool_inspection_manager
                            .update_permission_manager_for_action(
                                &session.id,
                                &tool_call,
                                PermissionLevel::AlwaysAllow,
                                permission_scope,
                            )
                            .await;
                    }
                } else {
                    let ctx = self
                        .tool_call_context_in_scope(
                            session,
                            request.id.clone(),
                            false,
                            permission_scope,
                        )
                        .await
                        .with_audit_authorization(ToolAuditAuthorization::UserDenied);
                    let audit_receipt = match self
                        .extension_manager
                        .record_denied_tool_call(&ctx, &tool_call)
                        .await
                    {
                        Ok(receipt) => Some(receipt),
                        Err(_) => {
                            tracing::error!(
                                security.event_type = "tool_audit_write_failed",
                                security.action = "retain_user_denial",
                                "Denied tool audit write failed"
                            );
                            None
                        }
                    };
                    if let Some(response) = request_to_response_map.get_mut(&request.id) {
                        let mut denied_result = CallToolResult::error(vec![Content::text(
                            USER_DENIED_RESPONSE,
                        )]);
                        if let Some(receipt) = audit_receipt.as_ref() {
                            insert_trusted_tool_audit_meta(&mut denied_result, receipt);
                        }
                        response.add_tool_response_with_metadata(
                            request.id.clone(),
                            Ok(denied_result),
                            request.metadata.as_ref(),
                        );
                    }

                    if confirmation.permission == Permission::AlwaysDeny {
                        self.tool_inspection_manager
                            .update_permission_manager_in_scope(
                                &session.id,
                                &tool_call.name,
                                PermissionLevel::NeverAllow,
                                permission_scope,
                            )
                            .await;
                    }
                }
            }
        }
    }.boxed()
    }

    pub(crate) fn handle_frontend_tool_request<'a>(
        &'a self,
        tool_request: &'a ToolRequest,
        message_tool_response: &'a mut Message,
        session: &'a Session,
        permission_scope: Option<&'a CodeProTaskScope>,
    ) -> BoxStream<'a, anyhow::Result<Message>> {
        try_stream! {
                if let Ok(tool_call) = tool_request.tool_call.clone() {
                    if self.is_frontend_tool(&tool_call.name).await {
                        let ctx = self
                            .tool_call_context_in_scope(
                                session,
                                tool_request.id.clone(),
                                false,
                                permission_scope,
                            )
                            .await;
                        let admission_guard = match ctx.admit_business_action().await {
                            Ok(guard) => guard,
                            Err(error) => {
                                message_tool_response.add_tool_response_with_metadata(
                                    tool_request.id.clone(),
                                    Err(ErrorData::new(
                                        ErrorCode::INVALID_REQUEST,
                                        format!("CodePro frontend action was not admitted by the current run: {error}"),
                                        None,
                                    )),
                                    tool_request.metadata.as_ref(),
                                );
                                return;
                            }
                        };
                        let audit_claim = if let Some(guard) = admission_guard {
                            let claim = self
                                .extension_manager
                                .begin_frontend_tool_audit(&ctx, &tool_call)
                                .await?;
                            drop(guard);
                            Some(claim)
                        } else {
                            None
                        };
                        yield Message::assistant().with_frontend_tool_request(
                            tool_request.id.clone(),
                            Ok(tool_call.clone())
                        );

                        if let Some((id, mut result)) = self.tool_result_rx.lock().await.recv().await {
                            if id != tool_request.id {
                                message_tool_response.add_tool_response_with_metadata(
                                    tool_request.id.clone(),
                                    Err(ErrorData::new(
                                        ErrorCode::INTERNAL_ERROR,
                                        format!("Frontend tool result belongs to request {id}, not {}. The original action outcome is unknown.", tool_request.id),
                                        None,
                                    )),
                                    tool_request.metadata.as_ref(),
                                );
                                return;
                            }
                            if let Some(claim) = audit_claim.as_ref() {
                                let outcome = match &result {
                                    Ok(response) if response.is_error != Some(true) => ToolAuditOutcome::Success,
                                    _ => ToolAuditOutcome::ToolError,
                                };
                                let receipt = self
                                    .extension_manager
                                    .complete_frontend_tool_audit(claim, outcome)
                                    .await?;
                                match &mut result {
                                    Ok(response) => insert_trusted_tool_audit_meta(response, &receipt),
                                    Err(error) => {
                                        *error = insert_trusted_tool_audit_error(error.clone(), &receipt);
                                    }
                                }
                            }
                            message_tool_response.add_tool_response_with_metadata(
                                id,
                                result,
                                tool_request.metadata.as_ref(),
                            );
                        } else {
                            message_tool_response.add_tool_response_with_metadata(
                                tool_request.id.clone(),
                                Err(ErrorData::new(
                                    ErrorCode::INTERNAL_ERROR,
                                    "Frontend tool result channel closed; the admitted action outcome is unknown".to_string(),
                                    None,
                                )),
                                tool_request.metadata.as_ref(),
                            );
                        }
                    }
            }
        }
        .boxed()
    }
}

#[cfg(test)]
mod codepro_context_tests {
    use super::{
        confirmation_failure_contract, tool_permission_context, CodeProWorkspaceWriteGuard,
        ToolCallContext, CANCELLED_RESPONSE, ENVIRONMENT_FAILURE_RESPONSE, FORBIDDEN_RESPONSE,
        POLICY_DENIED_RESPONSE, USER_DENIED_RESPONSE,
    };
    use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
    use crate::agents::tester_runtime::TesterRuntimeProbe;
    use crate::agents::tool_audit::{EffectiveModel, ToolAuditActor, ToolAuditAuthorization};
    use crate::agents::tool_confirmation_router::ToolConfirmationOutcome;
    use crate::agents::tool_security::{ToolExtensionSource, ToolSecurityProfile};
    use crate::config::permission::CodeProTaskScope;
    use crate::conversation::message::{
        ToolAuthorizationScope, ToolExtensionSource as DisplayToolExtensionSource,
        ToolPermissionClass,
    };
    use crate::permission::failure_semantics::CodeProFailureKind;
    use crate::session::SessionType;
    use rmcp::object;

    #[test]
    fn second_repair_batch_write_guard_reports_only_real_target_changes() {
        let workspace = tempfile::tempdir().unwrap();
        let target = workspace.path().join("app.js");
        std::fs::write(&target, "before\n").unwrap();
        let scope = CodeProTaskScope::new_bound(
            "run",
            "task",
            workspace.path(),
            vec!["**".to_string()],
            vec!["app.js".to_string()],
        )
        .unwrap();
        let arguments = serde_json::json!({"path":"app.js"});
        let guard = CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(workspace.path()),
            false,
            "developer",
            "edit",
            arguments.as_object(),
        )
        .unwrap()
        .unwrap();

        let before = guard.before_execution().unwrap();
        assert!(guard
            .after_execution(before)
            .unwrap()
            .changed_paths
            .is_empty());

        let before = guard.before_execution().unwrap();
        std::fs::write(&target, "after\n").unwrap();
        let delta = guard.after_execution(before).unwrap();
        assert_eq!(delta.changed_paths, vec!["app.js".to_string()]);
        assert_eq!(
            delta
                .resource_versions
                .unwrap()
                .get(&target.canonicalize().unwrap().to_string_lossy().to_string()),
            Some(&format!("blake3:{}", blake3::hash(b"after\n"))),
        );
        let before = guard.before_execution().unwrap();
        let canonical = target.canonicalize().unwrap().to_string_lossy().to_string();
        std::fs::remove_file(&target).unwrap();
        let deleted = guard.after_execution(before).unwrap();
        assert_eq!(
            deleted
                .resource_versions
                .unwrap()
                .get(&canonical)
                .map(String::as_str),
            Some("deleted")
        );
    }

    #[test]
    fn second_repair_batch_one_time_approval_authorizes_only_the_requested_path() {
        let workspace = tempfile::tempdir().unwrap();
        let target = workspace.path().join("app.js");
        std::fs::write(&target, "before\n").unwrap();
        let scope = CodeProTaskScope::new_bound(
            "run",
            "task",
            workspace.path(),
            vec!["**".to_string()],
            Vec::new(),
        )
        .unwrap();
        let arguments = serde_json::json!({"path":"app.js"});

        assert!(CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(workspace.path()),
            false,
            "developer",
            "edit",
            arguments.as_object(),
        )
        .is_err());
        let guard = CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(workspace.path()),
            true,
            "developer",
            "edit",
            arguments.as_object(),
        )
        .unwrap()
        .unwrap();
        let before = guard.before_execution().unwrap();
        std::fs::write(&target, "after\n").unwrap();
        assert_eq!(
            guard.after_execution(before).unwrap().changed_paths,
            vec!["app.js".to_string()]
        );
    }

    #[test]
    fn non_user_confirmation_failures_keep_distinct_failure_contracts() {
        let cases = [
            (
                ToolConfirmationOutcome::Cancelled,
                CodeProFailureKind::Cancelled,
                CANCELLED_RESPONSE,
            ),
            (
                ToolConfirmationOutcome::PolicyDenied,
                CodeProFailureKind::PolicyDenied,
                POLICY_DENIED_RESPONSE,
            ),
            (
                ToolConfirmationOutcome::Forbidden,
                CodeProFailureKind::Forbidden,
                FORBIDDEN_RESPONSE,
            ),
            (
                ToolConfirmationOutcome::EnvironmentFailure,
                CodeProFailureKind::EnvironmentFailure,
                ENVIRONMENT_FAILURE_RESPONSE,
            ),
        ];

        for (outcome, expected_kind, expected_response) in cases {
            assert_eq!(
                confirmation_failure_contract(&outcome),
                Some((expected_kind, expected_response))
            );
            assert_ne!(expected_kind, CodeProFailureKind::UserDenied);
            assert_ne!(expected_response, USER_DENIED_RESPONSE);
        }
    }

    #[test]
    fn policy_and_user_denials_never_impersonate_each_other() {
        assert!(USER_DENIED_RESPONSE.to_ascii_lowercase().contains("user"));
        assert!(!POLICY_DENIED_RESPONSE.to_ascii_lowercase().contains("user"));
        assert!(POLICY_DENIED_RESPONSE
            .to_ascii_lowercase()
            .contains("policy"));
        assert_ne!(POLICY_DENIED_RESPONSE, USER_DENIED_RESPONSE);
    }

    #[test]
    fn trusted_tool_profiles_map_to_fixed_permission_card_context() {
        let permission_cases = [
            (
                CodeProPermissionClass::ReadOnly,
                ToolPermissionClass::ReadOnly,
            ),
            (
                CodeProPermissionClass::WorkspaceWrite,
                ToolPermissionClass::WorkspaceWrite,
            ),
            (
                CodeProPermissionClass::ExternalWrite,
                ToolPermissionClass::ExternalWrite,
            ),
            (
                CodeProPermissionClass::HighRisk,
                ToolPermissionClass::HighRisk,
            ),
            (
                CodeProPermissionClass::Forbidden,
                ToolPermissionClass::Forbidden,
            ),
        ];
        for (permission_class, expected) in permission_cases {
            let context = tool_permission_context(
                Some(ToolSecurityProfile {
                    source: ToolExtensionSource::Platform,
                    permission_class: Some(permission_class),
                }),
                true,
                SessionType::CodePro,
            );
            assert_eq!(context.permission_class, expected);
            assert_eq!(context.authorization_scope, ToolAuthorizationScope::Task);
        }

        let source_cases = [
            (
                ToolExtensionSource::Platform,
                DisplayToolExtensionSource::Platform,
            ),
            (
                ToolExtensionSource::Builtin,
                DisplayToolExtensionSource::Builtin,
            ),
            (
                ToolExtensionSource::ExternalStdio,
                DisplayToolExtensionSource::ExternalStdio,
            ),
            (
                ToolExtensionSource::ExternalHttp,
                DisplayToolExtensionSource::ExternalHttp,
            ),
            (
                ToolExtensionSource::Frontend,
                DisplayToolExtensionSource::Frontend,
            ),
            (
                ToolExtensionSource::InlinePython,
                DisplayToolExtensionSource::InlinePython,
            ),
            (
                ToolExtensionSource::Unknown,
                DisplayToolExtensionSource::Unknown,
            ),
        ];
        for (source, expected) in source_cases {
            let context = tool_permission_context(
                Some(ToolSecurityProfile {
                    source,
                    permission_class: Some(CodeProPermissionClass::ReadOnly),
                }),
                false,
                SessionType::CodePro,
            );
            assert_eq!(context.extension_source, expected);
            assert_eq!(context.authorization_scope, ToolAuthorizationScope::Session);
        }

        let ordinary_trusted_tool = tool_permission_context(
            Some(ToolSecurityProfile {
                source: ToolExtensionSource::Platform,
                permission_class: Some(CodeProPermissionClass::WorkspaceWrite),
            }),
            false,
            SessionType::User,
        );
        assert_eq!(
            ordinary_trusted_tool.authorization_scope,
            ToolAuthorizationScope::Session,
            "trusted tools persist decisions in the current session even outside CodePro",
        );

        let profiled_legacy_tool = tool_permission_context(
            Some(ToolSecurityProfile {
                source: ToolExtensionSource::Unknown,
                permission_class: None,
            }),
            false,
            SessionType::User,
        );
        assert_eq!(
            profiled_legacy_tool.permission_class,
            ToolPermissionClass::Legacy
        );
        assert_eq!(
            profiled_legacy_tool.authorization_scope,
            ToolAuthorizationScope::Global,
            "a profile without a resolved permission class still uses legacy global storage",
        );

        let legacy = tool_permission_context(None, false, SessionType::User);
        assert_eq!(legacy.permission_class, ToolPermissionClass::Legacy);
        assert_eq!(legacy.extension_source, DisplayToolExtensionSource::Unknown);
        assert_eq!(legacy.authorization_scope, ToolAuthorizationScope::Global);
    }

    fn bound_scope(root: &std::path::Path, allowed: &str) -> CodeProTaskScope {
        CodeProTaskScope::new_bound(
            "run-scope",
            "task-scope",
            root,
            vec!["./**".into()],
            vec![allowed.into()],
        )
        .unwrap()
    }

    #[test]
    fn developer_write_and_edit_reject_unlisted_paths_before_execution() {
        let workspace = tempfile::tempdir().unwrap();
        let scope = bound_scope(workspace.path(), "src/owned.rs");

        for tool in ["write", "edit"] {
            let guard = super::CodeProWorkspaceWriteGuard::prepare(
                Some(&scope),
                Some(workspace.path()),
                false,
                "developer",
                tool,
                Some(&object!({ "path": "notes/generated.txt" })),
            );
            let violation = guard.expect_err("unlisted writes must fail before tool execution");
            assert!(violation.message().contains("NEEDS_REVIEW"));
            assert!(!workspace.path().join("notes/generated.txt").exists());
        }
    }

    #[test]
    fn developer_write_rejects_parent_but_accepts_absolute_workspace_paths() {
        let workspace = tempfile::tempdir().unwrap();
        let scope = bound_scope(workspace.path(), "src/**");
        let absolute = workspace.path().join("src/owned.rs");

        assert!(super::CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(workspace.path()),
            false,
            "developer",
            "write",
            Some(&object!({ "path": "../escape.txt" })),
        )
        .is_err());
        assert!(super::CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(workspace.path()),
            false,
            "developer",
            "write",
            Some(&object!({ "path": absolute.display().to_string() })),
        )
        .is_ok());
    }

    #[test]
    fn exact_external_file_requires_confirmation_and_then_passes_guard() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let external = root.path().join("external.txt");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(&external, "before").unwrap();
        let scope = CodeProTaskScope::new_bound(
            "run-scope",
            "task-scope",
            &workspace,
            vec![external.display().to_string()],
            vec![external.display().to_string()],
        )
        .unwrap();
        let arguments = object!({ "path": external.display().to_string() });

        let denied = super::CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(&workspace),
            false,
            "developer",
            "write",
            Some(&arguments),
        )
        .expect_err("external write without an explicit user choice must fail closed");
        assert!(denied.message().contains("explicit user confirmation"));

        assert!(super::CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(&workspace),
            true,
            "developer",
            "write",
            Some(&arguments),
        )
        .is_ok());

        let new_external = root.path().join("new-external.txt");
        let create_scope = CodeProTaskScope::new_bound(
            "run-scope",
            "task-create-scope",
            &workspace,
            vec![new_external.display().to_string()],
            vec![new_external.display().to_string()],
        )
        .unwrap();
        assert!(super::CodeProWorkspaceWriteGuard::prepare(
            Some(&create_scope),
            Some(&workspace),
            true,
            "developer",
            "write",
            Some(&object!({ "path": new_external.display().to_string() })),
        )
        .is_ok());
    }

    #[test]
    fn bounded_developer_shell_allows_validation_and_rejects_mutation() {
        let workspace = tempfile::tempdir().unwrap();
        let scope = bound_scope(workspace.path(), "src/**");

        assert!(super::CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(workspace.path()),
            false,
            "developer",
            "shell",
            Some(&object!({ "command": "node --test" })),
        )
        .is_ok());

        let validation_guard = super::CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(workspace.path()),
            false,
            "developer",
            "shell",
            Some(&object!({ "command": "node tests.js" })),
        )
        .unwrap()
        .expect("bounded validation command should retain its workspace guard");
        assert!(
            validation_guard.before_execution().unwrap().is_none(),
            "authorized workspace test artifacts must not be rejected as task-scope writes"
        );

        for command in ["node -v", "where node", "dir"] {
            assert!(
                super::CodeProWorkspaceWriteGuard::prepare(
                    Some(&scope),
                    Some(workspace.path()),
                    false,
                    "developer",
                    "shell",
                    Some(&object!({ "command": command })),
                )
                .is_ok(),
                "safe diagnostic command should be allowed: {command}"
            );
        }

        let violation = super::CodeProWorkspaceWriteGuard::prepare(
            Some(&scope),
            Some(workspace.path()),
            false,
            "developer",
            "shell",
            Some(&object!({ "command": "Set-Content src/owned.rs changed" })),
        )
        .expect_err("bounded shell mutation must fail closed without an OS write sandbox");
        assert!(violation.message().contains("NEEDS_REVIEW"));
    }

    #[test]
    fn bounded_shell_accepts_the_host_selected_python_for_pytest() {
        let workspace = tempfile::tempdir().unwrap();
        let scope = bound_scope(workspace.path(), "src/**");
        let selected_python = workspace.path().join(".venv/Scripts/python.exe");
        let runtime = TesterRuntimeProbe::path_python_for_test("cmd", selected_python.clone());
        let command = format!(
            "\"{}\" -m pytest -q tests/unit/test_workspace_security.py",
            selected_python.display()
        );

        assert!(
            super::CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
                Some(&scope),
                Some(workspace.path()),
                false,
                false,
                "developer",
                "shell",
                Some(&object!({ "command": command })),
                Some(&runtime),
            )
            .is_ok()
        );
    }

    #[test]
    fn git_mcp_observation_records_pull_files_without_expanding_worker_scope() {
        let workspace = tempfile::tempdir().unwrap();
        let scope = CodeProTaskScope::new_bound(
            "git-run",
            "main-agent",
            workspace.path(),
            vec!["**".into()],
            Vec::new(),
        )
        .unwrap()
        .with_permission_session_id("git-session")
        .unwrap();
        let args = object!({"path": workspace.path().to_string_lossy()});
        let guard = super::CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
            Some(&scope),
            Some(workspace.path()),
            false,
            true,
            "local_git",
            "git_pull",
            Some(&args),
            None,
        )
        .unwrap()
        .unwrap();
        std::fs::write(workspace.path().join("draft.txt"), "preserve").unwrap();
        let before = guard.before_execution().unwrap();
        std::fs::write(workspace.path().join("remote.txt"), "pulled").unwrap();
        let delta = guard.after_execution(before).unwrap();
        assert_eq!(delta.changed_paths, vec!["remote.txt"]);
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("draft.txt")).unwrap(),
            "preserve"
        );
        assert!(delta
            .resource_versions
            .unwrap()
            .values()
            .all(|value| value.starts_with("blake3:")));
        let child = scope.for_delegated_task("reviewer", &[]).unwrap();
        for (scope, full_access) in [(&child, true), (&scope, false)] {
            assert!(
                super::CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
                    Some(scope),
                    Some(workspace.path()),
                    false,
                    full_access,
                    "local_git",
                    "git_pull",
                    Some(&args),
                    None
                )
                .unwrap()
                .is_none()
            );
        }
    }

    #[test]
    fn autonomous_full_access_does_not_expand_a_delegated_scope() {
        let workspace = tempfile::tempdir().unwrap();
        let root = CodeProTaskScope::new_bound(
            "run-a",
            "main-agent",
            workspace.path(),
            vec!["**".to_string()],
            Vec::new(),
        )
        .unwrap()
        .with_permission_session_id("session-a")
        .unwrap();
        let child = root.for_delegated_task("reviewer", &[]).unwrap();
        let command = object!({ "command": "python --version" });
        assert!(
            super::CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
                Some(&root),
                Some(workspace.path()),
                false,
                true,
                "developer",
                "shell",
                Some(&command),
                None,
            )
            .unwrap()
            .is_some()
        );
        assert!(
            super::CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
                Some(&child),
                Some(workspace.path()),
                false,
                true,
                "developer",
                "shell",
                Some(&command),
                None,
            )
            .is_err()
        );
    }

    #[test]
    fn bounded_shell_accepts_host_selected_workspace_python_test_script() {
        let workspace = tempfile::tempdir().unwrap();
        let scope = bound_scope(workspace.path(), "src/**");
        let selected_python = std::path::PathBuf::from(if cfg!(windows) {
            "C:/Program Files/Python/python.exe"
        } else {
            "/opt/Project Python/bin/python3"
        });
        let runtime = TesterRuntimeProbe::path_python_for_test("cmd", selected_python.clone());
        std::fs::write(workspace.path().join("_import_test.py"), "print('ok')\n").unwrap();

        assert!(
            super::CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
                Some(&scope),
                Some(workspace.path()),
                false,
                false,
                "developer",
                "shell",
                Some(&object!({
                    "command": &format!(r#""{}" "_import_test.py""#, selected_python.display())
                })),
                Some(&runtime),
            )
            .is_ok(),
            "task-contract Python tests must not be misclassified as writes"
        );
    }

    #[test]
    fn bounded_shell_accepts_safe_host_selected_python_quality_checks_only() {
        let workspace = tempfile::tempdir().unwrap();
        let scope = bound_scope(workspace.path(), "src/**");
        let selected_python = workspace.path().join(".venv/Scripts/python.exe");
        let runtime = TesterRuntimeProbe::path_python_for_test("cmd", selected_python.clone());

        for arguments in [
            "-m ruff check . --no-cache",
            "-m mypy src",
            "-m compileall -q src tests",
            "-m pip check",
        ] {
            let command = format!("\"{}\" {arguments}", selected_python.display());
            assert!(
                super::CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
                    Some(&scope),
                    Some(workspace.path()),
                    false,
                    false,
                    "developer",
                    "shell",
                    Some(&object!({ "command": command })),
                    Some(&runtime),
                )
                .is_ok(),
                "safe quality check was blocked: {arguments}"
            );
        }

        for arguments in [
            "-m ruff check . --fix",
            "-m compileall -q ../outside",
            "-m pip install example",
            "-c print('unsafe')",
        ] {
            let command = format!("\"{}\" {arguments}", selected_python.display());
            assert!(
                super::CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
                    Some(&scope),
                    Some(workspace.path()),
                    false,
                    false,
                    "developer",
                    "shell",
                    Some(&object!({ "command": command })),
                    Some(&runtime),
                )
                .is_err(),
                "mutating or unbounded command escaped the workspace guard: {arguments}"
            );
        }
    }

    #[test]
    fn tool_context_defaults_to_unconfirmed_and_carries_trusted_host_scope() {
        let scope = CodeProTaskScope::new("run-a", "task-a").unwrap();
        let default_context =
            ToolCallContext::new("session-a".to_string(), None, Some("request-a".to_string()));
        assert!(!default_context.explicit_user_confirmation);
        assert!(default_context.codepro_task_scope.is_none());
        assert_eq!(default_context.actor, ToolAuditActor::HostUnknown);
        assert_eq!(
            default_context.effective_model,
            EffectiveModel::new("unknown").unwrap()
        );
        assert_eq!(
            default_context.audit_authorization,
            ToolAuditAuthorization::PolicyAllowed
        );

        let confirmed = default_context
            .with_codepro_task_scope(scope.clone())
            .with_explicit_user_confirmation(true);
        assert!(confirmed.explicit_user_confirmation);
        assert_eq!(confirmed.codepro_task_scope, Some(scope));
    }

    #[test]
    fn nested_tool_context_clears_confirmation_and_uses_a_fresh_request_identity() {
        let outer = ToolCallContext::new(
            "session-a".to_string(),
            None,
            Some("outer-request".to_string()),
        )
        .with_explicit_user_confirmation(true)
        .with_audit_identity(
            ToolAuditActor::CodeproCoder,
            EffectiveModel::new("provider/model").unwrap(),
        )
        .with_audit_authorization(ToolAuditAuthorization::UserConfirmed);

        let first = outer.for_nested_tool_call();
        let second = outer.for_nested_tool_call();

        assert!(!first.explicit_user_confirmation);
        assert_ne!(first.tool_call_request_id, outer.tool_call_request_id);
        assert_ne!(first.tool_call_request_id, second.tool_call_request_id);
        assert_eq!(first.actor, ToolAuditActor::CodeproCoder);
        assert_eq!(
            first.effective_model,
            EffectiveModel::new("provider/model").unwrap()
        );
        assert_eq!(
            first.audit_authorization,
            ToolAuditAuthorization::PolicyAllowed
        );
    }
}
