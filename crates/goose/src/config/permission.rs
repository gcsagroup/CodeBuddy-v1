use crate::config::paths::Paths;
use rmcp::model::Tool;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};
use tracing;

const PERMISSION_FILE: &str = "permission.yaml";

static PERMISSION_MANAGER: LazyLock<Arc<PermissionManager>> =
    LazyLock::new(|| Arc::new(PermissionManager::new(Paths::config_dir())));

/// Enum representing the possible permission levels for a tool.
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionLevel {
    AlwaysAllow, // Tool can always be used without prompt
    AskBefore,   // Tool requires permission to be granted before use
    NeverAllow,  // Tool is never allowed to be used
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum ValidationCommandPermission {
    InputRequired,
    BoundCommand(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CodeProTaskScope {
    run_id: String,
    task_id: String,
    permission_session_id: Option<String>,
    workspace_root: Option<PathBuf>,
    read_scope: Vec<String>,
    write_scope: Vec<String>,
    task_workspace_grant_revision: Option<u32>,
    grant_added_workspace_wildcard: bool,
    mode_added_workspace_wildcard: bool,
    validation_command: Option<ValidationCommandPermission>,
}

impl CodeProTaskScope {
    pub fn new(run_id: impl Into<String>, task_id: impl Into<String>) -> Result<Self, String> {
        let scope = Self {
            run_id: run_id.into(),
            task_id: task_id.into(),
            permission_session_id: None,
            workspace_root: None,
            read_scope: Vec::new(),
            write_scope: Vec::new(),
            task_workspace_grant_revision: None,
            grant_added_workspace_wildcard: false,
            mode_added_workspace_wildcard: false,
            validation_command: None,
        };
        if !valid_scope_identifier(&scope.run_id) || !valid_scope_identifier(&scope.task_id) {
            return Err("CodePro permission scope contains an invalid run or task ID".to_string());
        }
        Ok(scope)
    }

    pub fn new_bound(
        run_id: impl Into<String>,
        task_id: impl Into<String>,
        workspace_root: impl Into<PathBuf>,
        read_scope: Vec<String>,
        write_scope: Vec<String>,
    ) -> Result<Self, String> {
        let mut scope = Self::new(run_id, task_id)?;
        scope.workspace_root = Some(workspace_root.into());
        scope.read_scope = read_scope;
        scope.write_scope = write_scope;
        Ok(scope)
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    /// Only the durable root task may use the session's full-access mode.
    /// Delegated tasks keep their own narrower contract even when the parent
    /// session runs autonomously.
    pub(crate) fn is_durable_main_agent(&self) -> bool {
        self.task_id == "main-agent"
            && self.permission_session_id.is_some()
            && (self.write_scope.is_empty() || self.write_scope.iter().any(|scope| scope == "**"))
    }

    pub(crate) fn with_validation_command(
        mut self,
        permission: ValidationCommandPermission,
    ) -> Self {
        self.validation_command = Some(permission);
        self
    }

    pub(crate) fn confirmed_validation_command(&self) -> Option<&str> {
        match &self.validation_command {
            Some(ValidationCommandPermission::BoundCommand(command)) => Some(command),
            _ => None,
        }
    }

    pub(crate) fn allows_validation_command(&self, command: &str) -> bool {
        match &self.validation_command {
            None => true,
            Some(ValidationCommandPermission::InputRequired) => false,
            Some(ValidationCommandPermission::BoundCommand(confirmed)) => command == confirmed,
        }
    }

    pub fn with_permission_session_id(
        mut self,
        permission_session_id: impl Into<String>,
    ) -> Result<Self, String> {
        let permission_session_id = permission_session_id.into();
        if !valid_scope_identifier(&permission_session_id) {
            return Err(
                "CodePro permission scope contains an invalid parent session ID".to_string(),
            );
        }
        self.permission_session_id = Some(permission_session_id);
        Ok(self)
    }

    pub(crate) fn permission_session_id(&self) -> Option<&str> {
        self.permission_session_id.as_deref()
    }

    pub fn workspace_root(&self) -> Option<&Path> {
        self.workspace_root.as_deref()
    }

    /// Resolve a file identity through the nearest existing ancestor. Missing
    /// nested directories retain a stable identity, while symlinks/junctions
    /// are checked against the same physical workspace used at execution.
    pub(crate) fn canonical_workspace_target(&self, supplied: &Path) -> Option<PathBuf> {
        let root = self.workspace_root.as_ref()?.canonicalize().ok()?;
        if supplied
            .components()
            .any(|component| component == std::path::Component::ParentDir)
        {
            return None;
        }
        let target = if supplied.is_absolute() {
            supplied.to_path_buf()
        } else {
            root.join(supplied)
        };
        let mut existing = target.as_path();
        let mut missing = Vec::new();
        loop {
            match existing.canonicalize() {
                Ok(canonical) => {
                    if !canonical.starts_with(&root) {
                        return None;
                    }
                    let mut resolved = canonical;
                    for part in missing.iter().rev() {
                        resolved.push(part);
                    }
                    return Some(resolved);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing.push(existing.file_name()?.to_os_string());
                    existing = existing.parent()?;
                }
                Err(_) => return None,
            }
        }
    }

    pub fn read_scope(&self) -> &[String] {
        &self.read_scope
    }

    pub fn write_scope(&self) -> &[String] {
        &self.write_scope
    }

    pub(crate) fn task_workspace_grant_revision(&self) -> Option<u32> {
        self.task_workspace_grant_revision
    }

    pub(crate) fn without_task_workspace_grant(mut self) -> Self {
        if self.grant_added_workspace_wildcard {
            self.write_scope.retain(|scope| scope != "**");
        }
        self.task_workspace_grant_revision = None;
        self.grant_added_workspace_wildcard = false;
        self
    }

    pub(crate) fn without_mode_full_access(mut self) -> Self {
        if self.mode_added_workspace_wildcard {
            self.write_scope.retain(|scope| scope != "**");
        }
        self.mode_added_workspace_wildcard = false;
        self
    }

    pub(crate) fn with_mode_full_access(mut self) -> Self {
        if self.is_durable_main_agent() && !self.write_scope.iter().any(|scope| scope == "**") {
            self.write_scope.push("**".to_string());
            self.mode_added_workspace_wildcard = true;
        }
        self
    }

    pub(crate) fn with_task_workspace_grant(
        mut self,
        grant: &crate::agents::protocol::TaskWorkspaceGrant,
    ) -> Result<Self, String> {
        let root = self
            .workspace_root
            .as_ref()
            .ok_or_else(|| "task workspace is unbound".to_string())?
            .canonicalize()
            .map_err(|error| format!("task workspace cannot be resolved: {error}"))?;
        let approved = std::path::Path::new(&grant.workspace_root)
            .canonicalize()
            .map_err(|error| format!("approved workspace cannot be resolved: {error}"))?;
        if !paths_equal(&root, &approved) {
            return Err("task grant workspace differs from the current task workspace".to_string());
        }
        self = self.without_task_workspace_grant();
        if self.write_scope.is_empty() {
            self.write_scope.push("**".to_string());
            self.grant_added_workspace_wildcard = true;
        }
        self.task_workspace_grant_revision = Some(grant.authorization_revision);
        Ok(self)
    }

    pub(crate) fn for_delegated_task(
        &self,
        task_id: impl Into<String>,
        requested_write_scope: &[String],
    ) -> Result<Self, String> {
        let task_id = task_id.into();
        if !valid_scope_identifier(&task_id) {
            return Err(
                "CodePro delegated permission scope contains an invalid task ID".to_string(),
            );
        }
        for requested in requested_write_scope {
            if !scope_pattern_is_covered(&self.write_scope, requested) {
                return Err(format!(
                    "delegated write scope is not covered by the parent task: {requested}"
                ));
            }
        }
        Ok(Self {
            run_id: self.run_id.clone(),
            task_id,
            permission_session_id: self.permission_session_id.clone(),
            workspace_root: self.workspace_root.clone(),
            read_scope: self.read_scope.clone(),
            write_scope: requested_write_scope.to_vec(),
            task_workspace_grant_revision: self.task_workspace_grant_revision,
            grant_added_workspace_wildcard: false,
            mode_added_workspace_wildcard: false,
            validation_command: self.validation_command.clone(),
        })
    }

    pub(crate) fn write_scope_allows_path(&self, relative: &Path) -> bool {
        let relative = relative.to_string_lossy().replace('\\', "/");
        let relative = relative.trim_start_matches("./");
        if relative.is_empty()
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "..")
        {
            return false;
        }

        self.write_scope.iter().any(|scope| {
            let scope = scope.replace('\\', "/");
            let scope = scope.trim_start_matches("./").trim_end_matches('/');
            if scope == "**" {
                return true;
            }
            if scope.contains('*') && !scope.ends_with("/**") {
                return false;
            }
            if let Some(prefix) = scope.strip_suffix("/**") {
                return path_component_eq(relative, prefix) || path_has_prefix(relative, prefix);
            }
            path_component_eq(relative, scope)
        })
    }

    pub(crate) fn write_scope_allows_confirmed_external_file(&self, target: &Path) -> bool {
        if !target.is_absolute() {
            return false;
        }
        self.write_scope.iter().any(|scope| {
            let scope_path = Path::new(scope);
            scope_path.is_absolute() && paths_equal(scope_path, target)
        })
    }
}

fn scope_pattern_is_covered(parent_scopes: &[String], requested: &str) -> bool {
    fn normalize(scope: &str) -> &str {
        scope.trim_start_matches("./").trim_end_matches('/')
    }

    let requested = normalize(requested);
    let requested_path = requested.strip_suffix("/**").unwrap_or(requested);
    if requested.is_empty()
        || Path::new(requested_path).is_absolute()
        || Path::new(requested_path)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || (requested.contains('*') && !requested.ends_with("/**") && requested != "**")
    {
        return false;
    }
    parent_scopes.iter().any(|parent| {
        let parent = normalize(parent);
        if parent == "**" || parent == requested {
            return true;
        }
        let Some(parent_prefix) = parent.strip_suffix("/**") else {
            return false;
        };
        let requested_prefix = requested_path;
        path_component_eq(requested_prefix, parent_prefix)
            || path_has_prefix(requested_prefix, parent_prefix)
    })
}

#[cfg(windows)]
fn paths_equal(left: &Path, right: &Path) -> bool {
    fn normalized(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .trim_end_matches('/')
            .to_string()
    }
    normalized(left).eq_ignore_ascii_case(&normalized(right))
}

#[cfg(not(windows))]
fn paths_equal(left: &Path, right: &Path) -> bool {
    left == right
}

#[cfg(windows)]
fn path_component_eq(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(windows)]
fn path_has_prefix(path: &str, prefix: &str) -> bool {
    path.get(..prefix.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
        && path.as_bytes().get(prefix.len()) == Some(&b'/')
}

#[cfg(not(windows))]
fn path_component_eq(left: &str, right: &str) -> bool {
    left == right
}

#[cfg(not(windows))]
fn path_has_prefix(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ScopedPermissionKey {
    session_id: String,
    task_scope: Option<CodeProTaskScope>,
    tool_name: String,
}

#[derive(Debug, Default)]
struct ScopedPermissionState {
    permissions: HashMap<ScopedPermissionKey, PermissionLevel>,
    invalidated_sessions: HashSet<String>,
}

fn scoped_tool_name(task_scope: Option<&CodeProTaskScope>, tool_name: &str) -> String {
    if task_scope.is_some() && tool_name.starts_with("computer_") {
        "computer_*".to_string()
    } else {
        tool_name.to_string()
    }
}

fn valid_scope_identifier(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

/// Struct representing the configuration of permissions, categorized by level.
#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct PermissionConfig {
    pub always_allow: Vec<String>, // List of tools that are always allowed
    pub ask_before: Vec<String>,   // List of tools that require user consent
    pub never_allow: Vec<String>,  // List of tools that are never allowed
}

/// PermissionManager manages permission configurations for various tools.
#[derive(Debug)]
pub struct PermissionManager {
    config_path: PathBuf,
    permission_map: RwLock<HashMap<String, PermissionConfig>>,
    scoped_permission_state: RwLock<ScopedPermissionState>,
}

// Constants representing specific permission categories
const USER_PERMISSION: &str = "user";
const SMART_APPROVE_PERMISSION: &str = "smart_approve";

impl PermissionManager {
    pub fn new(config_dir: PathBuf) -> Self {
        let permission_path = config_dir.join(PERMISSION_FILE);
        let permission_map = if permission_path.exists() {
            let file_contents =
                fs::read_to_string(&permission_path).expect("Failed to read permission.yaml");
            serde_yaml::from_str(&file_contents).unwrap_or_else(|e| {
                tracing::error!(
                    "Failed to parse {}: {}. Refusing to start with corrupted permission config.",
                    permission_path.display(),
                    e,
                );
                panic!(
                    "Corrupted permission config at {}. Fix or remove the file to continue.",
                    permission_path.display(),
                );
            })
        } else {
            // Consolidate directory creation for re-use in global singleton or ACP.
            fs::create_dir_all(&config_dir).expect("Failed to create config directory");
            HashMap::new()
        };
        PermissionManager {
            config_path: permission_path,
            permission_map: RwLock::new(permission_map),
            scoped_permission_state: RwLock::new(ScopedPermissionState::default()),
        }
    }

    pub fn instance() -> Arc<PermissionManager> {
        Arc::clone(&PERMISSION_MANAGER)
    }

    /// Returns a list of all the names (keys) in the permission map.
    pub fn get_permission_names(&self) -> Vec<String> {
        self.permission_map
            .read()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }

    /// Retrieves the user permission level for a specific tool.
    pub fn get_user_permission(&self, principal_name: &str) -> Option<PermissionLevel> {
        self.get_permission(USER_PERMISSION, principal_name)
    }

    /// Retrieves the smart approve permission level for a specific tool.
    pub fn get_smart_approve_permission(&self, principal_name: &str) -> Option<PermissionLevel> {
        self.get_permission(SMART_APPROVE_PERMISSION, principal_name)
    }

    /// Retrieves the config file path.
    pub fn get_config_path(&self) -> &Path {
        self.config_path.as_path()
    }

    pub fn apply_tool_annotations(&self, tools: &[Tool]) {
        let mut write_annotated = Vec::new();
        for tool in tools {
            let Some(anns) = &tool.annotations else {
                continue;
            };
            if anns.read_only_hint == Some(false) {
                write_annotated.push(tool.name.to_string());
            }
        }
        if !write_annotated.is_empty() {
            self.bulk_update_smart_approve_permissions(
                &write_annotated,
                PermissionLevel::AskBefore,
            );
        }
    }

    fn bulk_update_smart_approve_permissions(&self, tool_names: &[String], level: PermissionLevel) {
        let mut map = self.permission_map.write().unwrap();
        let permission_config = map.entry(SMART_APPROVE_PERMISSION.to_string()).or_default();

        for tool_name in tool_names {
            // Remove from all lists to avoid duplicates
            permission_config.always_allow.retain(|p| p != tool_name);
            permission_config.ask_before.retain(|p| p != tool_name);
            permission_config.never_allow.retain(|p| p != tool_name);

            // Add to the appropriate list
            match &level {
                PermissionLevel::AlwaysAllow => {
                    permission_config.always_allow.push(tool_name.clone())
                }
                PermissionLevel::AskBefore => permission_config.ask_before.push(tool_name.clone()),
                PermissionLevel::NeverAllow => {
                    permission_config.never_allow.push(tool_name.clone())
                }
            }
        }

        let yaml_content =
            serde_yaml::to_string(&*map).expect("Failed to serialize permission config");
        fs::write(&self.config_path, yaml_content).expect("Failed to write to permission.yaml");
    }

    /// Helper function to retrieve the permission level for a specific permission category and tool.
    fn get_permission(&self, name: &str, principal_name: &str) -> Option<PermissionLevel> {
        let map = self.permission_map.read().unwrap();
        // Check if the permission category exists in the map
        if let Some(permission_config) = map.get(name) {
            // Check the permission levels for the given tool
            if permission_config
                .always_allow
                .contains(&principal_name.to_string())
            {
                return Some(PermissionLevel::AlwaysAllow);
            } else if permission_config
                .ask_before
                .contains(&principal_name.to_string())
            {
                return Some(PermissionLevel::AskBefore);
            } else if permission_config
                .never_allow
                .contains(&principal_name.to_string())
            {
                return Some(PermissionLevel::NeverAllow);
            }
        }
        None // Return None if no matching permission level is found
    }

    /// Updates the user permission level for a specific tool.
    pub fn update_user_permission(&self, principal_name: &str, level: PermissionLevel) {
        self.update_permission(USER_PERMISSION, principal_name, level)
    }

    /// Updates the smart approve permission level for a specific tool.
    pub fn update_smart_approve_permission(&self, principal_name: &str, level: PermissionLevel) {
        self.update_permission(SMART_APPROVE_PERMISSION, principal_name, level)
    }

    /// Helper function to update a permission level for a specific tool in a given permission category.
    fn update_permission(&self, name: &str, principal_name: &str, level: PermissionLevel) {
        let mut map = self.permission_map.write().unwrap();
        // Get or create a new PermissionConfig for the specified category
        let permission_config = map.entry(name.to_string()).or_default();

        // Remove the principal from all existing lists to avoid duplicates
        permission_config
            .always_allow
            .retain(|p| p != principal_name);
        permission_config.ask_before.retain(|p| p != principal_name);
        permission_config
            .never_allow
            .retain(|p| p != principal_name);

        // Add the principal to the appropriate list
        match level {
            PermissionLevel::AlwaysAllow => permission_config
                .always_allow
                .push(principal_name.to_string()),
            PermissionLevel::AskBefore => permission_config
                .ask_before
                .push(principal_name.to_string()),
            PermissionLevel::NeverAllow => permission_config
                .never_allow
                .push(principal_name.to_string()),
        }

        // Serialize the updated permission map and write it back to the config file
        let yaml_content =
            serde_yaml::to_string(&*map).expect("Failed to serialize permission config");
        fs::write(&self.config_path, yaml_content).expect("Failed to write to permission.yaml");
    }

    /// Removes all entries where the principal name starts with the given extension name.
    pub fn remove_extension(&self, extension_name: &str) {
        let mut map = self.permission_map.write().unwrap();
        for permission_config in map.values_mut() {
            permission_config
                .always_allow
                .retain(|p| !p.starts_with(extension_name));
            permission_config
                .ask_before
                .retain(|p| !p.starts_with(extension_name));
            permission_config
                .never_allow
                .retain(|p| !p.starts_with(extension_name));
        }

        let yaml_content =
            serde_yaml::to_string(&*map).expect("Failed to serialize permission config");
        fs::write(&self.config_path, yaml_content).expect("Failed to write to permission.yaml");
    }

    pub fn get_scoped_permission(
        &self,
        session_id: &str,
        task_scope: Option<&CodeProTaskScope>,
        tool_name: &str,
    ) -> Option<PermissionLevel> {
        let state = self.scoped_permission_state.read().unwrap();
        if state.invalidated_sessions.contains(session_id) {
            return None;
        }
        if let Some(scope) = task_scope {
            let task_key = ScopedPermissionKey {
                session_id: session_id.to_string(),
                task_scope: Some(scope.clone()),
                tool_name: scoped_tool_name(task_scope, tool_name),
            };
            if let Some(level) = state.permissions.get(&task_key) {
                return Some(level.clone());
            }
        }
        state
            .permissions
            .get(&ScopedPermissionKey {
                session_id: session_id.to_string(),
                task_scope: None,
                tool_name: tool_name.to_string(),
            })
            .cloned()
    }

    pub fn get_exact_task_scoped_permission(
        &self,
        session_id: &str,
        task_scope: &CodeProTaskScope,
        tool_name: &str,
    ) -> Option<PermissionLevel> {
        let state = self.scoped_permission_state.read().unwrap();
        if state.invalidated_sessions.contains(session_id) {
            return None;
        }
        state
            .permissions
            .get(&ScopedPermissionKey {
                session_id: session_id.to_string(),
                task_scope: Some(task_scope.clone()),
                tool_name: scoped_tool_name(Some(task_scope), tool_name),
            })
            .cloned()
    }

    pub fn update_scoped_permission(
        &self,
        session_id: &str,
        task_scope: Option<&CodeProTaskScope>,
        tool_name: &str,
        level: PermissionLevel,
    ) -> Result<(), String> {
        if !valid_scope_identifier(session_id) || !valid_scope_identifier(tool_name) {
            return Err("CodePro scoped permission contains an invalid session or tool ID".into());
        }
        let mut state = self.scoped_permission_state.write().unwrap();
        if state.invalidated_sessions.contains(session_id) {
            return Err("CodePro scoped permission session is no longer active".into());
        }
        state.permissions.insert(
            ScopedPermissionKey {
                session_id: session_id.to_string(),
                task_scope: task_scope.cloned(),
                tool_name: scoped_tool_name(task_scope, tool_name),
            },
            level,
        );
        Ok(())
    }

    pub fn clear_scoped_permissions(&self, session_id: &str) {
        self.scoped_permission_state
            .write()
            .unwrap()
            .permissions
            .retain(|key, _| key.session_id != session_id);
    }

    pub fn invalidate_scoped_permissions(&self, session_id: &str) {
        let mut state = self.scoped_permission_state.write().unwrap();
        state
            .permissions
            .retain(|key, _| key.session_id != session_id);
        state.invalidated_sessions.insert(session_id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ToolAnnotations;
    use rmcp::object;
    use tempfile::TempDir;

    #[test]
    fn second_repair_batch_delegated_write_scope_is_a_parent_subset() {
        let parent = CodeProTaskScope::new_bound(
            "run",
            "parent",
            PathBuf::from("C:/workspace"),
            vec!["**".to_string()],
            vec!["src/**".to_string(), "README.md".to_string()],
        )
        .unwrap();

        let read_only = parent.for_delegated_task("child-read", &[]).unwrap();
        assert!(read_only.write_scope().is_empty());
        let writer = parent
            .for_delegated_task("child-write", &["src/app.rs".to_string()])
            .unwrap();
        assert_eq!(writer.write_scope(), &["src/app.rs".to_string()]);
        assert!(parent
            .for_delegated_task("child-escape", &["tests/**".to_string()])
            .is_err());
        assert!(parent
            .for_delegated_task("child-parent", &["../outside.rs".to_string()])
            .is_err());
    }

    #[test]
    fn r3_durable_task_grant_never_turns_a_read_only_delegate_into_a_writer() {
        let workspace = TempDir::new().unwrap();
        let parent = CodeProTaskScope::new_bound(
            "run-grant",
            "main-agent-root",
            workspace.path(),
            vec!["**".to_string()],
            Vec::new(),
        )
        .unwrap();
        let grant = crate::agents::protocol::TaskWorkspaceGrant {
            grant_id: "grant".to_string(),
            source_task_id: crate::agents::protocol::TaskId::new("main-agent-root").unwrap(),
            request_id: "confirmation".to_string(),
            option_id: "allow_always".to_string(),
            workspace_root: workspace
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            requirement_revision: 1,
            authorization_revision: 1,
        };
        let parent = parent.with_task_workspace_grant(&grant).unwrap();
        assert!(parent.write_scope_allows_path(Path::new("src/new/deep/file.rs")));
        let reviewer = parent.for_delegated_task("read-only", &[]).unwrap();
        assert!(reviewer.write_scope().is_empty());
        assert!(!reviewer.write_scope_allows_path(Path::new("src/new/deep/file.rs")));
        let implementer = parent
            .for_delegated_task("implementer", &["src/**".to_string()])
            .unwrap();
        assert!(implementer.write_scope_allows_path(Path::new("src/lib.rs")));
        assert!(!implementer.write_scope_allows_path(Path::new("README.md")));
        assert_eq!(implementer.task_workspace_grant_revision(), Some(1));
    }

    #[test]
    fn autonomous_root_can_delegate_a_narrow_scope_and_revoke_its_mode_grant() {
        let workspace = TempDir::new().unwrap();
        let root = CodeProTaskScope::new_bound(
            "run-auto",
            "main-agent",
            workspace.path(),
            vec!["**".to_string()],
            Vec::new(),
        )
        .unwrap()
        .with_permission_session_id("session-auto")
        .unwrap();
        let full = root.clone().with_mode_full_access();
        assert!(full.write_scope_allows_path(Path::new("src/new/file.rs")));
        let child = full
            .for_delegated_task("read-implementation", &["src/**".to_string()])
            .unwrap();
        assert!(child.write_scope_allows_path(Path::new("src/lib.rs")));
        assert!(!child.write_scope_allows_path(Path::new("README.md")));
        assert!(!child.is_durable_main_agent());
        assert!(full.without_mode_full_access().write_scope().is_empty());
    }

    #[test]
    fn r3_new_nested_write_target_has_stable_physical_identity() {
        let workspace = TempDir::new().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let scope = CodeProTaskScope::new_bound(
            "run-nested",
            "task-nested",
            &root,
            vec!["**".to_string()],
            vec!["src/**".to_string()],
        )
        .unwrap();
        assert_eq!(
            scope.canonical_workspace_target(Path::new("src/new/deep/file.rs")),
            Some(root.join("src/new/deep/file.rs"))
        );
        assert!(scope
            .canonical_workspace_target(Path::new("../outside/file.rs"))
            .is_none());
        let outside = workspace.path().parent().unwrap().join("outside/file.rs");
        assert!(scope.canonical_workspace_target(&outside).is_none());
    }

    // Helper function to create a test instance of PermissionManager with a temp dir
    fn create_test_permission_manager() -> (PermissionManager, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let manager = PermissionManager::new(temp_dir.path().to_path_buf());
        (manager, temp_dir)
    }

    #[test]
    fn test_get_permission_names_empty() {
        let (manager, _temp_dir) = create_test_permission_manager();

        assert!(manager.get_permission_names().is_empty());
    }

    #[test]
    fn test_update_user_permission() {
        let (manager, _temp_dir) = create_test_permission_manager();
        manager.update_user_permission("tool1", PermissionLevel::AlwaysAllow);

        let permission = manager.get_user_permission("tool1");
        assert_eq!(permission, Some(PermissionLevel::AlwaysAllow));
    }

    #[test]
    fn task_write_scope_matches_exact_files_and_recursive_directories() {
        let exact = CodeProTaskScope::new_bound(
            "run-a",
            "task-a",
            "/workspace",
            vec![],
            vec!["src/owned.rs".into(), "tests/fixtures/**".into()],
        )
        .unwrap();

        assert!(exact.write_scope_allows_path(Path::new("src/owned.rs")));
        assert!(exact.write_scope_allows_path(Path::new("tests/fixtures/case.txt")));
        assert!(!exact.write_scope_allows_path(Path::new("src/other.rs")));
        assert!(!exact.write_scope_allows_path(Path::new("tests/fixture.txt")));
    }

    #[test]
    fn unsupported_write_scope_patterns_fail_closed() {
        let scope = CodeProTaskScope::new_bound(
            "run-a",
            "task-a",
            "/workspace",
            vec![],
            vec!["src/*.rs".into(), "../outside/**".into()],
        )
        .unwrap();

        assert!(!scope.write_scope_allows_path(Path::new("src/lib.rs")));
        assert!(!scope.write_scope_allows_path(Path::new("outside/file.txt")));
    }

    #[cfg(windows)]
    #[test]
    fn confirmed_external_scope_normalizes_windows_separators_and_case() {
        let scope = CodeProTaskScope::new_bound(
            "run-a",
            "task-a",
            r"D:\workspace",
            vec![],
            vec![r"C:\Users\Tester\Desktop\note.txt".into()],
        )
        .unwrap();

        assert!(scope.write_scope_allows_confirmed_external_file(Path::new(
            "c:/users/tester/desktop/note.txt"
        )));
    }

    #[test]
    fn test_update_smart_approve_permission() {
        let (manager, _temp_dir) = create_test_permission_manager();
        manager.update_smart_approve_permission("tool2", PermissionLevel::AskBefore);

        let permission = manager.get_smart_approve_permission("tool2");
        assert_eq!(permission, Some(PermissionLevel::AskBefore));
    }

    #[test]
    fn test_get_permission_not_found() {
        let (manager, _temp_dir) = create_test_permission_manager();

        let permission = manager.get_user_permission("non_existent_tool");
        assert_eq!(permission, None);
    }

    #[test]
    fn scoped_permissions_are_isolated_by_session_and_task_without_disk_writes() {
        let (manager, _temp_dir) = create_test_permission_manager();
        let task_a = CodeProTaskScope::new("run-a", "task-a").unwrap();
        let task_b = CodeProTaskScope::new("run-a", "task-b").unwrap();

        manager
            .update_scoped_permission("session-a", None, "git_stage", PermissionLevel::AlwaysAllow)
            .unwrap();
        manager
            .update_scoped_permission(
                "session-a",
                Some(&task_a),
                "git_push",
                PermissionLevel::AlwaysAllow,
            )
            .unwrap();

        assert_eq!(
            manager.get_scoped_permission("session-a", None, "git_stage"),
            Some(PermissionLevel::AlwaysAllow)
        );
        assert_eq!(
            manager.get_scoped_permission("session-b", None, "git_stage"),
            None
        );
        assert_eq!(
            manager.get_scoped_permission("session-a", Some(&task_a), "git_push"),
            Some(PermissionLevel::AlwaysAllow)
        );
        assert_eq!(
            manager.get_scoped_permission("session-a", Some(&task_b), "git_push"),
            None
        );
        assert!(!manager.get_config_path().exists());

        manager.clear_scoped_permissions("session-a");
        assert_eq!(
            manager.get_scoped_permission("session-a", None, "git_stage"),
            None
        );
        assert_eq!(
            manager.get_scoped_permission("session-a", Some(&task_a), "git_push"),
            None
        );
    }

    #[test]
    fn bound_task_scope_carries_the_host_workspace_contract() {
        let workspace = PathBuf::from(r"C:\isolated\project");
        let scope = CodeProTaskScope::new_bound(
            "run-a",
            "task-a",
            &workspace,
            vec!["./**".to_string()],
            vec!["src/**".to_string()],
        )
        .unwrap();

        assert_eq!(scope.workspace_root(), Some(workspace.as_path()));
        assert_eq!(scope.read_scope(), &["./**"]);
        assert_eq!(scope.write_scope(), &["src/**"]);

        let legacy_scope = CodeProTaskScope::new("run-a", "task-a").unwrap();
        assert_eq!(legacy_scope.workspace_root(), None);
        assert!(legacy_scope.read_scope().is_empty());
        assert!(legacy_scope.write_scope().is_empty());
    }

    #[test]
    fn invalidated_session_rejects_late_permission_writes() {
        let (manager, _temp_dir) = create_test_permission_manager();
        manager
            .update_scoped_permission(
                "closing-session",
                None,
                "git_push",
                PermissionLevel::AlwaysAllow,
            )
            .unwrap();

        manager.invalidate_scoped_permissions("closing-session");

        assert_eq!(
            manager.get_scoped_permission("closing-session", None, "git_push"),
            None
        );
        assert!(manager
            .update_scoped_permission(
                "closing-session",
                None,
                "git_push",
                PermissionLevel::AlwaysAllow,
            )
            .is_err());
    }

    #[test]
    fn task_permission_overrides_the_broader_session_permission() {
        let (manager, _temp_dir) = create_test_permission_manager();
        let task = CodeProTaskScope::new("run-a", "task-a").unwrap();
        manager
            .update_scoped_permission(
                "session-a",
                None,
                "computer_type",
                PermissionLevel::NeverAllow,
            )
            .unwrap();
        manager
            .update_scoped_permission(
                "session-a",
                Some(&task),
                "computer_type",
                PermissionLevel::AlwaysAllow,
            )
            .unwrap();

        assert_eq!(
            manager.get_scoped_permission("session-a", Some(&task), "computer_type"),
            Some(PermissionLevel::AlwaysAllow)
        );
    }

    #[test]
    fn task_scoped_computer_permission_covers_the_computer_tool_family_only() {
        let (manager, _temp_dir) = create_test_permission_manager();
        let task_a = CodeProTaskScope::new("run-a", "task-a").unwrap();
        let task_b = CodeProTaskScope::new("run-a", "task-b").unwrap();

        manager
            .update_scoped_permission(
                "session-a",
                Some(&task_a),
                "computer_focus",
                PermissionLevel::AlwaysAllow,
            )
            .unwrap();

        assert_eq!(
            manager.get_scoped_permission("session-a", Some(&task_a), "computer_key"),
            Some(PermissionLevel::AlwaysAllow)
        );
        assert_eq!(
            manager.get_scoped_permission("session-a", Some(&task_a), "computer_type"),
            Some(PermissionLevel::AlwaysAllow)
        );
        assert_eq!(
            manager.get_scoped_permission("session-a", Some(&task_a), "shell"),
            None
        );
        assert_eq!(
            manager.get_scoped_permission("session-a", Some(&task_b), "computer_key"),
            None
        );
    }

    #[test]
    fn test_permission_levels() {
        let (manager, _temp_dir) = create_test_permission_manager();

        manager.update_user_permission("tool4", PermissionLevel::AlwaysAllow);
        manager.update_user_permission("tool5", PermissionLevel::AskBefore);
        manager.update_user_permission("tool6", PermissionLevel::NeverAllow);

        // Check the permission levels
        assert_eq!(
            manager.get_user_permission("tool4"),
            Some(PermissionLevel::AlwaysAllow)
        );
        assert_eq!(
            manager.get_user_permission("tool5"),
            Some(PermissionLevel::AskBefore)
        );
        assert_eq!(
            manager.get_user_permission("tool6"),
            Some(PermissionLevel::NeverAllow)
        );
    }

    #[test]
    fn test_permission_update_replaces_existing_level() {
        let (manager, _temp_dir) = create_test_permission_manager();

        // Initially AlwaysAllow
        manager.update_user_permission("tool7", PermissionLevel::AlwaysAllow);
        assert_eq!(
            manager.get_user_permission("tool7"),
            Some(PermissionLevel::AlwaysAllow)
        );

        // Now change to NeverAllow
        manager.update_user_permission("tool7", PermissionLevel::NeverAllow);
        assert_eq!(
            manager.get_user_permission("tool7"),
            Some(PermissionLevel::NeverAllow)
        );

        // Ensure it's removed from other levels
        let map = manager.permission_map.read().unwrap();
        let config = map.get(USER_PERMISSION).unwrap();
        assert!(!config.always_allow.contains(&"tool7".to_string()));
        assert!(!config.ask_before.contains(&"tool7".to_string()));
        assert!(config.never_allow.contains(&"tool7".to_string()));
    }

    #[test]
    fn test_remove_extension() {
        let (manager, _temp_dir) = create_test_permission_manager();
        manager.update_user_permission("prefix__tool1", PermissionLevel::AlwaysAllow);
        manager.update_user_permission("nonprefix__tool2", PermissionLevel::AlwaysAllow);
        manager.update_user_permission("prefix__tool3", PermissionLevel::AskBefore);

        // Remove entries starting with "prefix"
        manager.remove_extension("prefix");

        let map = manager.permission_map.read().unwrap();
        let config = map.get(USER_PERMISSION).unwrap();

        // Verify entries with "prefix" are removed
        assert!(!config.always_allow.contains(&"prefix__tool1".to_string()));
        assert!(!config.ask_before.contains(&"prefix__tool3".to_string()));

        // Verify other entries remain
        assert!(config
            .always_allow
            .contains(&"nonprefix__tool2".to_string()));
    }

    #[test]
    #[should_panic(expected = "Corrupted permission config")]
    fn test_corrupted_permission_file_panics() {
        let temp_dir = TempDir::new().unwrap();
        let permission_path = temp_dir.path().join(PERMISSION_FILE);
        fs::write(&permission_path, "{{invalid yaml: [broken").unwrap();
        PermissionManager::new(temp_dir.path().to_path_buf());
    }

    use test_case::test_case;

    #[test_case(
        vec![Tool::new("tool".to_string(), String::new(), object!({"type": "object"}))
            .annotate(ToolAnnotations::new().read_only(false))],
        Some(PermissionLevel::AskBefore);
        "write_annotation_caches_ask"
    )]
    #[test_case(
        vec![Tool::new("tool".to_string(), String::new(), object!({"type": "object"}))],
        None;
        "unannotated_left_uncached"
    )]
    #[test_case(
        vec![Tool::new("tool".to_string(), String::new(), object!({"type": "object"}))
            .annotate(ToolAnnotations::new().read_only(true))],
        None;
        "readonly_annotation_skipped"
    )]
    fn test_apply_tool_annotations(tools: Vec<Tool>, expect_cache: Option<PermissionLevel>) {
        let (manager, _temp_dir) = create_test_permission_manager();
        manager.apply_tool_annotations(&tools);
        assert_eq!(manager.get_smart_approve_permission("tool"), expect_cache);
    }
}
