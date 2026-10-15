use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const CODEPRO_WORKSPACE_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProWorkspaceMode {
    Direct,
    LegacyUnresolved,
    GitWorktree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProGitWorktreeMetadata {
    pub common_dir: PathBuf,
    pub base_object_id: String,
    pub head_object_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProWorkspaceDescriptor {
    pub schema_version: u16,
    pub mode: CodeProWorkspaceMode,
    pub source_repo: PathBuf,
    pub worktree_path: PathBuf,
    #[serde(default)]
    pub git: Option<CodeProGitWorktreeMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProWorkspaceProjection {
    pub mode: CodeProWorkspaceMode,
    pub source_repo: PathBuf,
    pub worktree_path: PathBuf,
    pub execution_directory: Option<PathBuf>,
}

impl CodeProWorkspaceDescriptor {
    pub fn direct(source_path: PathBuf) -> Self {
        Self {
            schema_version: CODEPRO_WORKSPACE_SCHEMA_VERSION,
            mode: CodeProWorkspaceMode::Direct,
            source_repo: source_path.clone(),
            worktree_path: source_path,
            git: None,
        }
    }

    pub fn legacy_unresolved(source_repo: PathBuf, worktree_path: PathBuf) -> Self {
        Self {
            schema_version: CODEPRO_WORKSPACE_SCHEMA_VERSION,
            mode: CodeProWorkspaceMode::LegacyUnresolved,
            source_repo,
            worktree_path,
            git: None,
        }
    }

    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.schema_version == CODEPRO_WORKSPACE_SCHEMA_VERSION,
            "unsupported CodePro workspace schema version"
        );
        anyhow::ensure!(
            !self.source_repo.as_os_str().is_empty() && !self.worktree_path.as_os_str().is_empty(),
            "CodePro workspace paths must not be empty"
        );
        match self.mode {
            CodeProWorkspaceMode::Direct => {
                anyhow::ensure!(
                    self.git.is_none(),
                    "direct workspace cannot contain Git authority"
                );
                anyhow::ensure!(
                    paths_equivalent(&self.source_repo, &self.worktree_path)?,
                    "direct workspace paths do not agree"
                );
            }
            CodeProWorkspaceMode::LegacyUnresolved => {
                anyhow::ensure!(
                    self.git.is_none(),
                    "legacy unresolved workspace cannot contain Git authority"
                );
                anyhow::ensure!(
                    !paths_equivalent(&self.source_repo, &self.worktree_path)?,
                    "legacy unresolved workspace paths must differ"
                );
            }
            CodeProWorkspaceMode::GitWorktree => {
                let git = self
                    .git
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("Git worktree metadata is required"))?;
                anyhow::ensure!(
                    !git.common_dir.as_os_str().is_empty(),
                    "Git common directory must not be empty"
                );
                anyhow::ensure!(
                    valid_object_id(&git.base_object_id) && valid_object_id(&git.head_object_id),
                    "Git object ID must be 40 or 64 hexadecimal characters"
                );
            }
        }
        Ok(())
    }

    pub fn projection(&self) -> CodeProWorkspaceProjection {
        CodeProWorkspaceProjection {
            mode: self.mode,
            source_repo: self.source_repo.clone(),
            worktree_path: self.worktree_path.clone(),
            execution_directory: (self.mode != CodeProWorkspaceMode::LegacyUnresolved)
                .then(|| self.worktree_path.clone()),
        }
    }
}

pub(crate) fn paths_equivalent(left: &Path, right: &Path) -> Result<bool> {
    match (
        canonical_workspace_path(left),
        canonical_workspace_path(right),
    ) {
        (Ok(left), Ok(right)) => Ok(left == right),
        (Err(_), Err(_)) => Ok(left == right),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}

fn valid_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug)]
pub struct CodeProWorkspace {
    path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodeProRunLocation {
    pub(crate) source_repo: PathBuf,
    pub(crate) worktree_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEvidence {
    pub patch: String,
    pub files_changed: Vec<String>,
    pub sensitive_files_changed: Vec<String>,
}

impl CodeProWorkspace {
    pub fn direct(source: &Path) -> Result<Self> {
        Ok(Self {
            path: canonical_workspace_path(source)?,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl CodeProRunLocation {
    pub(crate) fn direct(working_dir: &Path) -> Self {
        Self {
            source_repo: working_dir.to_path_buf(),
            worktree_path: working_dir.to_path_buf(),
        }
    }
}

fn canonical_workspace_path(path: &Path) -> Result<PathBuf> {
    let canonical = path.canonicalize()?;
    #[cfg(target_os = "windows")]
    let canonical = normalize_windows_canonical_path(canonical);
    Ok(canonical)
}

#[cfg(target_os = "windows")]
fn normalize_windows_canonical_path(path: PathBuf) -> PathBuf {
    let display = path.to_string_lossy();
    if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(drive_path) = display.strip_prefix(r"\\?\") {
        return PathBuf::from(drive_path);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_workspace_has_no_copy_or_shadow_repository_entry_points() {
        let source = include_str!("codepro_workspace.rs").replace("\r\n", "\n");
        let production = source
            .split_once("\n#[cfg(test)]\nmod tests {")
            .map(|(production, _)| production)
            .expect("workspace test module boundary");

        for forbidden in [
            "pub async fn create(",
            "pub async fn open_or_create(",
            "create_shadow_workspace",
            "std::fs::copy",
            "CODEBUDDY_WORKSPACE_ROOT",
            "CodePro shadow workspace baseline",
        ] {
            assert!(
                !production.contains(forbidden),
                "direct workspace must not retain legacy copy capability: {forbidden}"
            );
        }
    }

    #[test]
    fn direct_workspace_uses_the_original_project_without_copying_it() {
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("app.txt"), "original\n").unwrap();

        let workspace = CodeProWorkspace::direct(source.path()).unwrap();

        assert_eq!(
            workspace.path().canonicalize().unwrap(),
            source.path().canonicalize().unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("app.txt")).unwrap(),
            "original\n"
        );
    }

    #[test]
    fn direct_run_location_uses_the_canonical_workspace_path() {
        let source = tempfile::tempdir().unwrap();
        let workspace = CodeProWorkspace::direct(source.path()).unwrap();

        let location = CodeProRunLocation::direct(workspace.path());

        assert_eq!(location.source_repo, workspace.path());
        assert_eq!(location.worktree_path, workspace.path());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn direct_workspace_does_not_expose_the_windows_verbatim_prefix() {
        let source = tempfile::tempdir().unwrap();

        let workspace = CodeProWorkspace::direct(source.path()).unwrap();
        let display = workspace.path().display().to_string();

        assert!(!display.starts_with(r"\\?\"));
        assert!(workspace.path().is_absolute());
        assert!(workspace.path().exists());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalizes_windows_drive_and_unc_verbatim_paths() {
        assert_eq!(
            normalize_windows_canonical_path(PathBuf::from(r"\\?\C:\projects\app")),
            PathBuf::from(r"C:\projects\app")
        );
        assert_eq!(
            normalize_windows_canonical_path(PathBuf::from(r"\\?\UNC\server\share\app")),
            PathBuf::from(r"\\server\share\app")
        );
    }

    #[test]
    fn legacy_unresolved_has_no_execution_directory() {
        let descriptor = CodeProWorkspaceDescriptor::legacy_unresolved(
            PathBuf::from("/source"),
            PathBuf::from("/historical-worktree"),
        );

        descriptor.validate().unwrap();
        assert_eq!(descriptor.mode, CodeProWorkspaceMode::LegacyUnresolved);
        assert!(descriptor.projection().execution_directory.is_none());
    }

    #[test]
    fn workspace_contract_rejects_inconsistent_git_authority() {
        let git = CodeProGitWorktreeMetadata {
            common_dir: PathBuf::from("/repo/.git"),
            base_object_id: "a".repeat(40),
            head_object_id: "b".repeat(64),
        };
        let mut direct = CodeProWorkspaceDescriptor::direct(PathBuf::from("/source"));
        direct.git = Some(git.clone());
        assert!(direct.validate().is_err());

        let mut worktree = CodeProWorkspaceDescriptor {
            schema_version: CODEPRO_WORKSPACE_SCHEMA_VERSION,
            mode: CodeProWorkspaceMode::GitWorktree,
            source_repo: PathBuf::from("/source"),
            worktree_path: PathBuf::from("/worktree"),
            git: Some(git),
        };
        worktree.git.as_mut().unwrap().head_object_id = "not-an-object".to_string();
        assert!(worktree.validate().is_err());
        worktree.git = None;
        assert!(worktree.validate().is_err());
    }

    #[test]
    fn workspace_mode_serializes_in_snake_case() {
        let descriptor = CodeProWorkspaceDescriptor::legacy_unresolved(
            PathBuf::from("/source"),
            PathBuf::from("/worktree"),
        );
        let value = serde_json::to_value(descriptor).unwrap();
        assert_eq!(value["mode"], "legacy_unresolved");
    }
}
