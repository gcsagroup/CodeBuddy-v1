use goose_sdk_types::custom_notifications::ReadOutcome;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const METADATA_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WorkspaceKind {
    Rust,
    Node,
    Python,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceDiscovery {
    pub(crate) root: PathBuf,
    pub(crate) manifest_path: Option<PathBuf>,
    pub(crate) kind: WorkspaceKind,
    pub(crate) workspace_members: Vec<String>,
    pub(crate) default_members: Vec<String>,
    pub(crate) target_directory: Option<PathBuf>,
    pub(crate) test_command: String,
    pub(crate) read_outcome: ReadOutcome,
    pub(crate) correction_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum WorkspaceDiscoveryError {
    #[error("permission is required to read {path}: {reason}")]
    PermissionRequired { path: PathBuf, reason: String },
    #[error("workspace manifest resolves outside the selected root: {path}")]
    OutsideWorkspace { path: PathBuf },
    #[error("no supported test entry was found under {root}")]
    NotFound { root: PathBuf },
    #[error("workspace discovery infrastructure failed: {reason}")]
    InfrastructureFailed { reason: String },
    #[error("workspace discovery was cancelled")]
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct NormalizedCommandKey {
    pub(crate) command: String,
    pub(crate) cwd: PathBuf,
    pub(crate) manifest_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceExecutionPreflight {
    pub(crate) existing_build_processes: Vec<String>,
    pub(crate) workspace_free_bytes: u64,
    pub(crate) target_free_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CargoMetadata {
    workspace_root: PathBuf,
    workspace_members: Vec<String>,
    #[serde(default)]
    workspace_default_members: Vec<String>,
    target_directory: PathBuf,
}

impl WorkspaceDiscovery {
    pub(crate) async fn discover(
        selected_root: &Path,
        configured_command: Option<&str>,
        cancellation_token: &tokio_util::sync::CancellationToken,
    ) -> Result<Self, WorkspaceDiscoveryError> {
        if cancellation_token.is_cancelled() {
            return Err(WorkspaceDiscoveryError::Cancelled);
        }
        let root = tokio::fs::canonicalize(selected_root)
            .await
            .map_err(|error| classify_read_error(selected_root, error))?;

        let cargo_manifest = root.join("Cargo.toml");
        if path_is_file(&cargo_manifest).await? {
            return discover_rust(root, cargo_manifest, configured_command, cancellation_token)
                .await;
        }

        let package_json = root.join("package.json");
        if path_is_file(&package_json).await? {
            return discover_node(root, package_json, configured_command).await;
        }

        if let Some(discovery) = discover_configured_script(&root, configured_command).await? {
            return Ok(discovery);
        }

        let python_entry = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"]
            .into_iter()
            .map(|name| root.join(name))
            .find(|path| path.is_file());
        if python_entry.is_some() || root.join("tests").is_dir() {
            let configured = configured_command
                .filter(|command| is_python_test_command(command))
                .map(str::trim)
                .map(str::to_string);
            return Ok(Self {
                root,
                manifest_path: python_entry,
                kind: WorkspaceKind::Python,
                workspace_members: Vec::new(),
                default_members: Vec::new(),
                target_directory: None,
                test_command: configured.unwrap_or_else(|| "python -m pytest".to_string()),
                read_outcome: ReadOutcome::Succeeded,
                correction_reason: None,
            });
        }

        Err(WorkspaceDiscoveryError::NotFound { root })
    }

    pub(crate) fn command_key(&self) -> NormalizedCommandKey {
        NormalizedCommandKey {
            command: normalize_command_text(&self.test_command),
            cwd: canonical_or_original(&self.root),
            manifest_path: self.manifest_path.as_deref().map(canonical_or_original),
        }
    }

    pub(crate) async fn execution_preflight(
        &self,
    ) -> Result<WorkspaceExecutionPreflight, WorkspaceDiscoveryError> {
        let workspace_free_bytes = fs2::available_space(&self.root).map_err(|error| {
            WorkspaceDiscoveryError::InfrastructureFailed {
                reason: format!("checking workspace free space failed: {error}"),
            }
        })?;
        let target_free_bytes = self
            .target_directory
            .as_deref()
            .and_then(existing_ancestor)
            .map(fs2::available_space)
            .transpose()
            .map_err(|error| WorkspaceDiscoveryError::InfrastructureFailed {
                reason: format!("checking Cargo target free space failed: {error}"),
            })?;
        Ok(WorkspaceExecutionPreflight {
            existing_build_processes: existing_build_processes().await,
            workspace_free_bytes,
            target_free_bytes,
        })
    }
}

async fn discover_configured_script(
    root: &Path,
    configured_command: Option<&str>,
) -> Result<Option<WorkspaceDiscovery>, WorkspaceDiscoveryError> {
    let Some(command) = configured_command else {
        return Ok(None);
    };
    let Ok(parts) = shell_words::split(command) else {
        return Ok(None);
    };
    let Some(program) = parts
        .first()
        .and_then(|part| Path::new(part).file_name())
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase)
    else {
        return Ok(None);
    };
    let (kind, script_index) = match program.as_str() {
        "node" | "node.exe" => (WorkspaceKind::Node, 1),
        "python" | "python.exe" | "python3" | "python3.exe" => {
            let Some(index) = parts.iter().position(|part| part.ends_with(".py")) else {
                return Ok(None);
            };
            (WorkspaceKind::Python, index)
        }
        _ => return Ok(None),
    };
    let Some(script) = parts.get(script_index) else {
        return Ok(None);
    };
    if kind == WorkspaceKind::Python && !path_has_test_intent(Path::new(script)) {
        return Ok(None);
    }
    let script_path = root.join(script);
    if !path_is_file(&script_path).await? {
        return Ok(None);
    }
    let canonical_script = tokio::fs::canonicalize(&script_path)
        .await
        .map_err(|error| classify_read_error(&script_path, error))?;
    if !canonical_script.starts_with(root) {
        return Err(WorkspaceDiscoveryError::OutsideWorkspace {
            path: canonical_script,
        });
    }
    Ok(Some(WorkspaceDiscovery {
        root: root.to_path_buf(),
        manifest_path: Some(canonical_script),
        kind,
        workspace_members: Vec::new(),
        default_members: Vec::new(),
        target_directory: None,
        test_command: shell_words::join(parts.iter().map(String::as_str)),
        read_outcome: ReadOutcome::Succeeded,
        correction_reason: None,
    }))
}

fn path_has_test_intent(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        value == "test" || value == "tests" || value.contains("test") || value.contains("spec")
    })
}

fn existing_ancestor(path: &Path) -> Option<&Path> {
    path.ancestors().find(|candidate| candidate.exists())
}

async fn existing_build_processes() -> Vec<String> {
    #[cfg(windows)]
    let output = Command::new("tasklist.exe")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .await;
    #[cfg(not(windows))]
    let output = Command::new("ps").args(["-eo", "comm="]).output().await;
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let normalized = line.trim_matches('"').to_ascii_lowercase();
            (normalized.starts_with("cargo") || normalized.starts_with("rustc"))
                .then(|| line.trim().to_string())
        })
        .take(32)
        .collect()
}

async fn discover_rust(
    selected_root: PathBuf,
    cargo_manifest: PathBuf,
    configured_command: Option<&str>,
    cancellation_token: &tokio_util::sync::CancellationToken,
) -> Result<WorkspaceDiscovery, WorkspaceDiscoveryError> {
    let canonical_manifest = tokio::fs::canonicalize(&cargo_manifest)
        .await
        .map_err(|error| classify_read_error(&cargo_manifest, error))?;
    if !canonical_manifest.starts_with(&selected_root) {
        return Err(WorkspaceDiscoveryError::OutsideWorkspace {
            path: canonical_manifest,
        });
    }
    tokio::fs::read_to_string(&canonical_manifest)
        .await
        .map_err(|error| classify_read_error(&canonical_manifest, error))?;

    let cargo =
        which::which("cargo").map_err(|error| WorkspaceDiscoveryError::InfrastructureFailed {
            reason: format!("cargo was not found on PATH: {error}"),
        })?;
    let mut child = Command::new(cargo);
    child
        .current_dir(&selected_root)
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(&canonical_manifest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::select! {
        _ = cancellation_token.cancelled() => return Err(WorkspaceDiscoveryError::Cancelled),
        result = tokio::time::timeout(METADATA_TIMEOUT, child.output()) => result
            .map_err(|_| WorkspaceDiscoveryError::InfrastructureFailed {
                reason: "cargo metadata timed out".to_string(),
            })?
            .map_err(|error| WorkspaceDiscoveryError::InfrastructureFailed {
                reason: format!("cargo metadata could not start: {error}"),
            })?,
    };
    if !output.status.success() {
        return Err(WorkspaceDiscoveryError::InfrastructureFailed {
            reason: format!(
                "cargo metadata exited with {:?}: {}",
                output.status.code(),
                bounded_text(&String::from_utf8_lossy(&output.stderr))
            ),
        });
    }
    let metadata: CargoMetadata = serde_json::from_slice(&output.stdout).map_err(|error| {
        WorkspaceDiscoveryError::InfrastructureFailed {
            reason: format!("cargo metadata returned invalid JSON: {error}"),
        }
    })?;
    let workspace_root = canonical_or_original(&metadata.workspace_root);
    if workspace_root != selected_root {
        return Err(WorkspaceDiscoveryError::OutsideWorkspace {
            path: workspace_root,
        });
    }

    let (test_command, corrected, correction_reason) = normalized_rust_test_command(
        configured_command,
        &canonical_manifest,
        metadata.workspace_members.len(),
    );
    Ok(WorkspaceDiscovery {
        root: selected_root,
        manifest_path: Some(canonical_manifest),
        kind: WorkspaceKind::Rust,
        workspace_members: metadata.workspace_members,
        default_members: metadata.workspace_default_members,
        target_directory: Some(metadata.target_directory),
        test_command,
        read_outcome: if corrected {
            ReadOutcome::PathCorrected
        } else {
            ReadOutcome::Succeeded
        },
        correction_reason,
    })
}

async fn discover_node(
    root: PathBuf,
    package_json: PathBuf,
    configured_command: Option<&str>,
) -> Result<WorkspaceDiscovery, WorkspaceDiscoveryError> {
    let canonical_manifest = tokio::fs::canonicalize(&package_json)
        .await
        .map_err(|error| classify_read_error(&package_json, error))?;
    if !canonical_manifest.starts_with(&root) {
        return Err(WorkspaceDiscoveryError::OutsideWorkspace {
            path: canonical_manifest,
        });
    }
    let contents = tokio::fs::read_to_string(&canonical_manifest)
        .await
        .map_err(|error| classify_read_error(&canonical_manifest, error))?;
    let value: serde_json::Value = serde_json::from_str(&contents).map_err(|error| {
        WorkspaceDiscoveryError::InfrastructureFailed {
            reason: format!("package.json is invalid: {error}"),
        }
    })?;
    let has_test = value
        .get("scripts")
        .and_then(|scripts| scripts.get("test"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|script| !script.trim().is_empty());
    if !has_test {
        return Err(WorkspaceDiscoveryError::NotFound { root });
    }
    let configured = configured_command
        .filter(|command| is_node_test_command(command))
        .map(str::trim)
        .map(str::to_string);
    let corrected = configured_command.is_some() && configured.is_none();
    Ok(WorkspaceDiscovery {
        root,
        manifest_path: Some(canonical_manifest),
        kind: WorkspaceKind::Node,
        workspace_members: Vec::new(),
        default_members: Vec::new(),
        target_directory: None,
        test_command: configured.unwrap_or_else(|| "npm test".to_string()),
        read_outcome: if corrected {
            ReadOutcome::PathCorrected
        } else {
            ReadOutcome::Succeeded
        },
        correction_reason: corrected.then(|| {
            "configured command did not match the package.json test script; using npm test"
                .to_string()
        }),
    })
}

async fn path_is_file(path: &Path) -> Result<bool, WorkspaceDiscoveryError> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(classify_read_error(path, error)),
    }
}

fn classify_read_error(path: &Path, error: std::io::Error) -> WorkspaceDiscoveryError {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => WorkspaceDiscoveryError::PermissionRequired {
            path: path.to_path_buf(),
            reason: error.to_string(),
        },
        std::io::ErrorKind::NotFound => WorkspaceDiscoveryError::NotFound {
            root: path.to_path_buf(),
        },
        _ => WorkspaceDiscoveryError::InfrastructureFailed {
            reason: format!("reading {} failed: {error}", path.display()),
        },
    }
}

fn normalized_rust_test_command(
    configured_command: Option<&str>,
    manifest: &Path,
    member_count: usize,
) -> (String, bool, Option<String>) {
    let mut corrected = false;
    let mut args = configured_command
        .and_then(|command| shell_words::split(command).ok())
        .filter(|parts| {
            parts.first().is_some_and(|part| {
                Path::new(part)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.eq_ignore_ascii_case("cargo") || name.eq_ignore_ascii_case("cargo.exe")
                    })
            }) && parts.get(1).is_some_and(|part| part == "test")
        })
        .unwrap_or_else(|| {
            corrected = configured_command.is_some();
            vec!["cargo".to_string(), "test".to_string()]
        });
    let mut normalized = Vec::with_capacity(args.len() + 5);
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if matches!(
            argument.as_str(),
            "--quiet" | "-q" | "--manifest-path" | "--jobs" | "-j"
        ) {
            corrected = true;
            index += if matches!(argument.as_str(), "--manifest-path" | "--jobs" | "-j") {
                2
            } else {
                1
            };
            continue;
        }
        if argument.starts_with("--manifest-path=")
            || argument.starts_with("--jobs=")
            || argument.starts_with("-j") && argument.len() > 2
        {
            corrected = true;
            index += 1;
            continue;
        }
        normalized.push(argument.clone());
        index += 1;
    }
    args.clear();
    args.extend(normalized);
    if member_count > 1
        && !args.iter().any(|argument| {
            argument == "--workspace" || argument == "-p" || argument == "--package"
        })
    {
        args.push("--workspace".to_string());
    }
    args.push("--manifest-path".to_string());
    args.push(manifest.to_string_lossy().into_owned());
    args.push("--jobs".to_string());
    args.push("1".to_string());
    let command = shell_words::join(args.iter().map(String::as_str));
    let reason = corrected.then(|| {
        "removed a guessed manifest, quiet mode, or parallel Cargo setting and bound the command to the discovered workspace manifest"
            .to_string()
    });
    (command, corrected, reason)
}

fn is_node_test_command(command: &str) -> bool {
    shell_words::split(command).ok().is_some_and(|parts| {
        parts.first().is_some_and(|part| {
            matches!(part.to_ascii_lowercase().as_str(), "npm" | "pnpm" | "yarn")
        }) && parts
            .iter()
            .skip(1)
            .any(|part| matches!(part.as_str(), "test" | "vitest"))
    })
}

fn is_python_test_command(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    normalized.starts_with("pytest") || normalized.contains(" -m pytest")
}

fn normalize_command_text(command: &str) -> String {
    shell_words::split(command)
        .map(|parts| shell_words::join(parts.iter().map(String::as_str)))
        .unwrap_or_else(|_| command.split_whitespace().collect::<Vec<_>>().join(" "))
        .to_ascii_lowercase()
}

fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn bounded_text(value: &str) -> String {
    value.trim().chars().take(2_000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guessed_manifest_quiet_and_parallel_cargo_are_corrected() {
        let root = tempfile::tempdir().unwrap();
        let manifest = root.path().join("Cargo.toml");
        std::fs::write(&manifest, "[package]\nname='sample'\nversion='0.1.0'\n").unwrap();
        let (command, corrected, reason) = normalized_rust_test_command(
            Some("cargo test --quiet --manifest-path goose/Cargo.toml --jobs 8"),
            &manifest,
            1,
        );
        assert!(corrected);
        assert!(reason.is_some());
        assert!(!command.contains("--quiet"));
        assert!(!command.contains("goose/Cargo.toml"));
        assert!(command.contains("--jobs 1"));
        assert!(command.contains(manifest.to_string_lossy().as_ref()));
    }

    #[tokio::test]
    async fn package_json_test_script_is_authoritative_for_node_projects() {
        let root = tempfile::tempdir().unwrap();
        tokio::fs::write(
            root.path().join("package.json"),
            r#"{"scripts":{"test":"node --test"}}"#,
        )
        .await
        .unwrap();
        let discovery = WorkspaceDiscovery::discover(
            root.path(),
            Some("cargo test --workspace --quiet"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(discovery.kind, WorkspaceKind::Node);
        assert_eq!(discovery.test_command, "npm test");
        assert_eq!(discovery.read_outcome, ReadOutcome::PathCorrected);
    }

    #[tokio::test]
    async fn existing_configured_node_test_script_is_an_authoritative_entry() {
        let root = tempfile::tempdir().unwrap();
        tokio::fs::write(root.path().join("tests.js"), "process.exit(0);\n")
            .await
            .unwrap();

        let discovery = WorkspaceDiscovery::discover(
            root.path(),
            Some("node tests.js"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(discovery.kind, WorkspaceKind::Node);
        assert_eq!(discovery.test_command, "node tests.js");
        assert!(discovery.manifest_path.unwrap().ends_with("tests.js"));
    }

    #[tokio::test]
    async fn configured_python_test_script_wins_over_generic_pytest_discovery() {
        let root = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(root.path().join("tests"))
            .await
            .unwrap();
        tokio::fs::write(root.path().join("_import_test.py"), "print('ok')\n")
            .await
            .unwrap();

        let discovery = WorkspaceDiscovery::discover(
            root.path(),
            Some("python _import_test.py"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(discovery.kind, WorkspaceKind::Python);
        assert_eq!(discovery.test_command, "python _import_test.py");
        assert!(discovery
            .manifest_path
            .unwrap()
            .ends_with("_import_test.py"));

        tokio::fs::write(root.path().join("app.py"), "print('app')\n")
            .await
            .unwrap();
        let generic = WorkspaceDiscovery::discover(
            root.path(),
            Some("python app.py"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(generic.test_command, "python -m pytest");
    }

    #[test]
    fn command_key_deduplicates_whitespace_and_path_spelling() {
        let root = tempfile::tempdir().unwrap();
        let manifest = root.path().join("Cargo.toml");
        std::fs::write(&manifest, "[package]\nname='sample'\nversion='0.1.0'\n").unwrap();
        let first = WorkspaceDiscovery {
            root: root.path().to_path_buf(),
            manifest_path: Some(manifest.clone()),
            kind: WorkspaceKind::Rust,
            workspace_members: vec![],
            default_members: vec![],
            target_directory: None,
            test_command: "cargo   test --jobs 1".to_string(),
            read_outcome: ReadOutcome::Succeeded,
            correction_reason: None,
        };
        let mut second = first.clone();
        second.test_command = "cargo test   --jobs   1".to_string();
        assert_eq!(first.command_key(), second.command_key());
    }

    #[tokio::test]
    async fn cancelled_discovery_does_not_become_a_failure() {
        let root = tempfile::tempdir().unwrap();
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        assert_eq!(
            WorkspaceDiscovery::discover(root.path(), None, &token).await,
            Err(WorkspaceDiscoveryError::Cancelled)
        );
    }

    #[tokio::test]
    async fn preflight_reports_space_without_terminating_existing_processes() {
        let root = tempfile::tempdir().unwrap();
        let discovery = WorkspaceDiscovery {
            root: root.path().to_path_buf(),
            manifest_path: None,
            kind: WorkspaceKind::Python,
            workspace_members: Vec::new(),
            default_members: Vec::new(),
            target_directory: Some(root.path().join("target")),
            test_command: "python -m pytest".to_string(),
            read_outcome: ReadOutcome::Succeeded,
            correction_reason: None,
        };

        let preflight = discovery.execution_preflight().await.unwrap();

        assert!(preflight.workspace_free_bytes > 0);
        assert!(preflight.target_free_bytes.is_some());
    }
}
