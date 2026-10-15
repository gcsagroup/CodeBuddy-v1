use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidationInvocation {
    executable: String,
    argv: Vec<String>,
    cwd: String,
    validation_identity: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationInvocationError {
    Empty,
    CompoundCommandNotSupported,
    InvalidQuoting,
    Unsupported,
    UntrustedAbsoluteWrapper,
}

impl ValidationInvocationError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty_command",
            Self::CompoundCommandNotSupported => "compound_command_not_supported",
            Self::InvalidQuoting => "invalid_command_quoting",
            Self::Unsupported => "unsupported_validation_invocation",
            Self::UntrustedAbsoluteWrapper => "untrusted_absolute_wrapper",
        }
    }

    pub(crate) const fn recoverable_message(self) -> &'static str {
        match self {
            Self::Empty => "The validation command is empty. Submit one simple validation command.",
            Self::CompoundCommandNotSupported => {
                "Compound shell syntax is not supported. Run one validation executable with argv in the current working directory."
            }
            Self::InvalidQuoting => {
                "The validation command has invalid quoting. Submit one simple validation command."
            }
            Self::Unsupported => {
                "This shell request was not run under the bounded validation contract. Approval cannot override this execution boundary. Use one supported validation command per turn, or report that validation is unavailable; do not delegate to bypass the boundary."
            }
            Self::UntrustedAbsoluteWrapper => {
                "The absolute validation wrapper is not the trusted wrapper for this runtime. Use the trusted executable or its bare command name."
            }
        }
    }
}

impl ValidationInvocation {
    /// Bind an execution requirement to a command, not to an authorization decision.
    /// Bounded execution and approval callers must continue to use `parse`.
    pub(crate) fn for_evidence(
        command: &str,
        cwd: &Path,
    ) -> Result<Self, ValidationInvocationError> {
        if let Ok(invocation) = Self::parse(command, cwd) {
            return Ok(invocation);
        }
        let command = command.trim();
        if command.is_empty() {
            return Err(ValidationInvocationError::Empty);
        }
        // Preserve the entire shell program exactly, including compound syntax and
        // quoting. Splitting it cannot establish equivalence or grant permission.
        let executable = crate::agents::platform_extensions::developer::shell::shell_display_name();
        let argv = vec![command.to_string()];
        let cwd = normalize_path(cwd);
        let identity_payload = serde_json::json!({
            "kind": "exact_shell_command", "executable": executable, "argv": argv, "cwd": cwd,
        });
        Ok(Self {
            executable,
            argv,
            cwd,
            validation_identity: blake3::hash(identity_payload.to_string().as_bytes())
                .to_hex()
                .to_string(),
        })
    }

    pub fn parse(command: &str, cwd: &Path) -> Result<Self, ValidationInvocationError> {
        let command = command.trim();
        if command.is_empty() {
            return Err(ValidationInvocationError::Empty);
        }
        if super::codepro_simple_change_run::has_forbidden_shell_syntax(command) {
            return Err(ValidationInvocationError::CompoundCommandNotSupported);
        }
        let words =
            shell_words::split(command).map_err(|_| ValidationInvocationError::InvalidQuoting)?;
        let (executable, argv) = words
            .split_first()
            .ok_or(ValidationInvocationError::Empty)?;
        let (exact_executable, canonical_executable) = if Path::new(executable).is_absolute()
            && crate::agents::tester_runtime::is_bounded_absolute_python_validation_command(command)
        {
            let file_name = Path::new(executable)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(executable)
                .to_ascii_lowercase();
            let canonical = if file_name.starts_with("python3") {
                "python3"
            } else {
                "python"
            };
            (normalize_path(Path::new(executable)), canonical.to_string())
        } else {
            normalize_executable(executable)?
        };
        if !is_allowed(&canonical_executable, argv) {
            return Err(ValidationInvocationError::Unsupported);
        }
        let cwd = normalize_path(cwd);
        let identity_payload = serde_json::json!({
            "executable": canonical_executable,
            "argv": normalize_identity_argv(argv),
            "cwd": cwd,
        });
        let validation_identity = blake3::hash(identity_payload.to_string().as_bytes())
            .to_hex()
            .to_string();
        Ok(Self {
            executable: exact_executable,
            argv: argv.to_vec(),
            cwd,
            validation_identity,
        })
    }

    pub fn executable(&self) -> &str {
        &self.executable
    }

    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn validation_identity(&self) -> &str {
        &self.validation_identity
    }

    pub fn exact_match(&self, other: &Self) -> bool {
        self.executable == other.executable && self.argv == other.argv && self.cwd == other.cwd
    }
}

#[cfg(test)]
pub(crate) fn explicit_user_validation_invocation(
    goal: &str,
    cwd: &Path,
) -> Option<ValidationInvocation> {
    let canonical = crate::agents::codepro_intent::user_selected_test_command(goal)?;
    let normalized_goal = goal.to_ascii_lowercase();
    let requested = match canonical.as_str() {
        "npm test" if normalized_goal.contains("npm.cmd test") => "npm.cmd test",
        "pnpm test" if normalized_goal.contains("pnpm.cmd test") => "pnpm.cmd test",
        "yarn test" if normalized_goal.contains("yarn.cmd test") => "yarn.cmd test",
        _ => canonical.as_str(),
    };
    ValidationInvocation::parse(requested, cwd).ok()
}

pub(crate) fn equivalent_validation_invocations(left: &str, right: &str, cwd: &Path) -> bool {
    ValidationInvocation::parse(left, cwd)
        .ok()
        .zip(ValidationInvocation::parse(right, cwd).ok())
        .is_some_and(|(left, right)| left.validation_identity == right.validation_identity)
}

fn normalize_executable(executable: &str) -> Result<(String, String), ValidationInvocationError> {
    let path = Path::new(executable);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(executable)
        .to_ascii_lowercase();
    let canonical = match file_name.as_str() {
        "npm" | "npm.cmd" => "npm".to_string(),
        "pnpm" | "pnpm.cmd" => "pnpm".to_string(),
        "yarn" | "yarn.cmd" => "yarn".to_string(),
        "cargo" | "cargo.exe" => "cargo".to_string(),
        "node" | "node.exe" => "node".to_string(),
        "git" | "git.exe" => "git".to_string(),
        "python" | "python.exe" => "python".to_string(),
        "python3" | "python3.exe" => "python3".to_string(),
        "pytest" | "pytest.exe" => "pytest".to_string(),
        "go" | "go.exe" => "go".to_string(),
        "dotnet" | "dotnet.exe" => "dotnet".to_string(),
        "mvn" | "mvn.cmd" => "mvn".to_string(),
        "gradle" | "gradle.bat" => "gradle".to_string(),
        "gradlew" | "gradlew.bat" => "gradlew".to_string(),
        "npx" | "npx.cmd" => "npx".to_string(),
        "bun" | "bun.exe" => "bun".to_string(),
        "vitest" | "vitest.cmd" => "vitest".to_string(),
        "jest" | "jest.cmd" => "jest".to_string(),
        "tsc" | "tsc.cmd" => "tsc".to_string(),
        "eslint" | "eslint.cmd" => "eslint".to_string(),
        "make" | "make.exe" => "make".to_string(),
        "cmake" | "cmake.exe" => "cmake".to_string(),
        "dir" | "where" | "where.exe" | "findstr" | "findstr.exe" | "type" => {
            file_name.trim_end_matches(".exe").to_string()
        }
        _ => return Err(ValidationInvocationError::Unsupported),
    };

    if path.is_absolute() {
        if canonical != "npm" || file_name != "npm.cmd" || !is_trusted_npm_wrapper(path) {
            return Err(ValidationInvocationError::UntrustedAbsoluteWrapper);
        }
        return Ok((normalize_path(path), canonical));
    }
    if path.components().count() > 1 {
        let normalized = executable.replace('\\', "/").to_ascii_lowercase();
        if canonical == "gradlew" && normalized == "./gradlew" {
            return Ok(("./gradlew".to_string(), canonical));
        }
        return Err(ValidationInvocationError::UntrustedAbsoluteWrapper);
    }
    Ok((file_name, canonical))
}

fn is_trusted_npm_wrapper(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let Ok(node) = which::which("node") else {
            return false;
        };
        let Some(parent) = node.parent() else {
            return false;
        };
        paths_equal(path, &parent.join("npm.cmd"))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

#[cfg(windows)]
fn paths_equal(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn normalize_path(path: &Path) -> String {
    let path = path.canonicalize().unwrap_or_else(|_| PathBuf::from(path));
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    value
}

fn normalize_identity_argv(argv: &[String]) -> Vec<String> {
    #[cfg(windows)]
    {
        argv.iter()
            .map(|value| value.to_ascii_lowercase())
            .collect()
    }
    #[cfg(not(windows))]
    argv.to_vec()
}

fn is_allowed(executable: &str, argv: &[String]) -> bool {
    let lower = argv
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let args = lower.iter().map(String::as_str).collect::<Vec<_>>();
    match executable {
        "cargo" => matches!(args.first(), Some(&"test" | &"check" | &"clippy")),
        "npm" | "pnpm" => matches!(
            args.as_slice(),
            ["test", ..] | ["run", "test", ..] | ["run", "lint", ..] | ["run", "typecheck", ..]
        ),
        "yarn" => matches!(args.as_slice(), ["test", ..] | ["lint", ..]),
        "bun" => matches!(args.as_slice(), ["test", ..]),
        "pytest" => true,
        "python" | "python3" => matches!(args.as_slice(), ["-m", "pytest", ..]),
        "go" | "dotnet" | "mvn" | "gradle" | "gradlew" | "make" => {
            matches!(args.first(), Some(&"test"))
        }
        "npx" => matches!(args.first(), Some(&"vitest" | &"jest" | &"tsc" | &"eslint")),
        "vitest" | "jest" | "tsc" | "eslint" => true,
        "node" => {
            matches!(args.first(), Some(&"--test" | &"-v" | &"--version"))
                || argv.first().is_some_and(|script| {
                    !script.starts_with('-')
                        && [".js", ".cjs", ".mjs"]
                            .iter()
                            .any(|extension| script.to_ascii_lowercase().ends_with(extension))
                })
        }
        "git" => matches!(args.as_slice(), ["diff", "--check"]),
        "cmake" => matches!(args.first(), Some(&"--build")),
        "dir" => args.is_empty() || matches!(args.as_slice(), ["."] | ["/b"]),
        "where" => matches!(args.as_slice(), ["node"]),
        "findstr" => args.len() >= 2,
        "type" => !args.is_empty(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_repair_batch_npm_aliases_share_validation_identity_but_remain_exactly_distinct() {
        let cwd = Path::new(".");
        let npm = ValidationInvocation::parse("npm test", cwd).unwrap();
        let npm_cmd = ValidationInvocation::parse("npm.cmd test", cwd).unwrap();

        assert_eq!(npm.validation_identity(), npm_cmd.validation_identity());
        assert!(!npm.exact_match(&npm_cmd));
    }

    #[test]
    fn first_repair_batch_compound_command_returns_recoverable_reason() {
        let error = ValidationInvocation::parse("cd /d C:\\repo && npm.cmd test", Path::new("."))
            .unwrap_err();
        assert_eq!(
            error,
            ValidationInvocationError::CompoundCommandNotSupported
        );
        assert_eq!(error.code(), "compound_command_not_supported");
    }

    #[test]
    fn first_repair_batch_user_selected_npm_cmd_keeps_exact_obligation() {
        let invocation = explicit_user_validation_invocation(
            "请先运行 npm.cmd test，并报告真实退出码。",
            Path::new("."),
        )
        .unwrap();

        assert_eq!(invocation.executable(), "npm.cmd");
        assert_eq!(invocation.argv(), ["test"]);
    }

    #[cfg(windows)]
    #[test]
    fn first_repair_batch_trusted_absolute_npm_wrapper_is_allowed() {
        let node = which::which("node").unwrap();
        let npm = node.parent().unwrap().join("npm.cmd");
        if !npm.exists() {
            return;
        }
        let invocation =
            ValidationInvocation::parse(&format!("\"{}\" test", npm.display()), Path::new("."))
                .unwrap();

        assert!(!invocation.validation_identity().is_empty());
        assert_eq!(invocation.argv(), ["test"]);
    }

    #[test]
    fn first_repair_batch_preserves_relative_gradle_wrapper_validation() {
        let invocation = ValidationInvocation::parse("./gradlew test", Path::new(".")).unwrap();

        assert_eq!(invocation.executable(), "./gradlew");
        assert_eq!(invocation.argv(), ["test"]);
    }
}
