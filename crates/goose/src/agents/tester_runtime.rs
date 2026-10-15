use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::agents::task_dag::{
    HostRepairActionKindV1, HostRepairActionV1, HostVerificationContractV1,
};
use crate::agents::workers::{
    ProcessTreeTerminator, SystemProcessGroupOwner, SystemProcessTreeTerminator,
};
use crate::session::SessionProcessTracker;
use crate::subprocess::SubprocessExt;
use base64::Engine;
use goose_sdk_types::custom_notifications::{
    TestExecutionOutcome, TestExecutionPhase, TestExecutionProgress,
    TEST_EXECUTION_PROGRESS_SCHEMA_VERSION,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Instant;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RECEIPT_TEXT: usize = 1_024;
const STREAM_BUFFER_BYTES: usize = 8 * 1_024;
const TERMINATION_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);
const STREAM_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_EXPECTED_FILE_BYTES: usize = 64 * 1024;
const TEST_PROGRESS_HEARTBEAT: Duration = Duration::from_secs(2);
const TEST_PROGRESS_TAIL_BYTES: usize = 8 * 1024;

#[derive(Clone)]
pub(crate) struct TestExecutionProgressSink {
    log_path: PathBuf,
    publish: Arc<dyn Fn(TestExecutionProgress) + Send + Sync>,
}

impl TestExecutionProgressSink {
    pub(crate) fn new(
        log_path: PathBuf,
        publish: impl Fn(TestExecutionProgress) + Send + Sync + 'static,
    ) -> Self {
        Self {
            log_path,
            publish: Arc::new(publish),
        }
    }

    pub(crate) fn emit(&self, progress: TestExecutionProgress) {
        if let Some(parent) = self.log_path.parent() {
            if std::fs::create_dir_all(parent).is_ok() {
                if let Ok(mut file) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.log_path)
                {
                    if let Ok(mut line) = serde_json::to_vec(&progress) {
                        line.push(b'\n');
                        let _ = file.write_all(&line).and_then(|_| file.sync_data());
                    }
                }
            }
        }
        (self.publish)(progress);
    }
}

#[derive(Clone)]
pub(crate) struct TestExecutionProgressContext {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) attempt_id: String,
    pub(crate) manifest_path: Option<PathBuf>,
    pub(crate) retry_attempt: u16,
    pub(crate) repair_attempt: u16,
    pub(crate) initial_phase: TestExecutionPhase,
    pub(crate) sink: TestExecutionProgressSink,
}

#[derive(Debug, Clone)]
struct LiveTestOutput {
    phase: TestExecutionPhase,
    stdout_tail: String,
    stderr_tail: String,
    last_output_at: Option<chrono::DateTime<chrono::Utc>>,
    current_crate: Option<String>,
    current_test: Option<String>,
    completed: u64,
    total: Option<u64>,
}

impl LiveTestOutput {
    fn new(phase: TestExecutionPhase) -> Self {
        Self {
            phase,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            last_output_at: None,
            current_crate: None,
            current_test: None,
            completed: 0,
            total: None,
        }
    }

    fn observe(&mut self, stream: TestOutputStream, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes);
        let tail = match stream {
            TestOutputStream::Stdout => &mut self.stdout_tail,
            TestOutputStream::Stderr => &mut self.stderr_tail,
        };
        tail.push_str(&text);
        bound_tail(tail);
        self.last_output_at = Some(chrono::Utc::now());
        for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
            if line.contains("Blocking waiting for file lock")
                || line.contains("waiting for file lock on")
            {
                self.phase = TestExecutionPhase::WaitingForCargoLock;
            } else if line.starts_with("Updating ")
                || line.starts_with("Downloading ")
                || line.starts_with("Downloaded ")
                || line.starts_with("Fresh ")
            {
                self.phase = TestExecutionPhase::ResolvingDependencies;
            } else if let Some(crate_name) = line.strip_prefix("Compiling ") {
                self.phase = TestExecutionPhase::Compiling;
                self.current_crate = crate_name.split_whitespace().next().map(str::to_string);
            } else if line.starts_with("Running ") || line.starts_with("running ") {
                self.phase = TestExecutionPhase::RunningTests;
                if let Some(total) = line
                    .strip_prefix("running ")
                    .and_then(|rest| rest.split_whitespace().next())
                    .and_then(|value| value.parse::<u64>().ok())
                {
                    self.total = Some(total);
                }
            } else if let Some(test) = line.strip_prefix("test ") {
                self.phase = TestExecutionPhase::RunningTests;
                self.current_test = test
                    .split(" ... ")
                    .next()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                if line.ends_with(" ... ok") {
                    self.completed = self.completed.saturating_add(1);
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
enum TestOutputStream {
    Stdout,
    Stderr,
}

#[async_trait::async_trait]
trait HostProcessGroupLifecycle: Send + Sync {
    fn terminate_group(&self) -> Result<(), String>;
    async fn wait_empty(&self, timeout: Duration) -> bool;
}

#[async_trait::async_trait]
impl HostProcessGroupLifecycle for SystemProcessGroupOwner {
    fn terminate_group(&self) -> Result<(), String> {
        SystemProcessGroupOwner::terminate_group(self).map_err(|error| error.to_string())
    }

    async fn wait_empty(&self, timeout: Duration) -> bool {
        SystemProcessGroupOwner::wait_empty(self, timeout).await
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostVerificationSpec {
    target: HostVerificationTarget,
    assertion_id: String,
    expected_summary: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum HostVerificationTarget {
    Command {
        executable: PathBuf,
        argv: Vec<String>,
    },
    ExactFileBytes {
        relative_path: PathBuf,
        expected_bytes: Vec<u8>,
    },
}

impl HostVerificationSpec {
    fn new(executable: PathBuf, argv: Vec<String>) -> Result<Self, String> {
        if !executable.is_absolute() || argv.len() > 128 {
            return Err("host verification command is empty or too large".to_string());
        }
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"codeagentpro:host-verification:v1\0");
        hasher.update(executable.to_string_lossy().as_bytes());
        for argument in &argv {
            if argument.len() > 4_096 || argument.chars().any(|character| character == '\0') {
                return Err("host verification argument is invalid or too large".to_string());
            }
            hasher.update(b"\0");
            hasher.update(argument.as_bytes());
        }
        Ok(Self {
            target: HostVerificationTarget::Command { executable, argv },
            assertion_id: hasher.finalize().to_hex().to_string(),
            expected_summary: "exit_code:0".to_string(),
        })
    }

    pub(crate) fn exact_file_bytes(
        relative_path: PathBuf,
        expected_bytes: Vec<u8>,
    ) -> Result<Self, String> {
        if relative_path.as_os_str().is_empty()
            || relative_path.is_absolute()
            || relative_path.components().any(|component| {
                !matches!(
                    component,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            })
            || expected_bytes.len() > MAX_EXPECTED_FILE_BYTES
        {
            return Err("exact-file verification target is unsafe or too large".to_string());
        }
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"codeagentpro:host-file-verification:v1\0");
        hasher.update(relative_path.to_string_lossy().as_bytes());
        hasher.update(b"\0");
        hasher.update(&expected_bytes);
        let expected_len = expected_bytes.len();
        let expected_sha256 = sha256_hex(&expected_bytes);
        Ok(Self {
            target: HostVerificationTarget::ExactFileBytes {
                relative_path,
                expected_bytes,
            },
            assertion_id: hasher.finalize().to_hex().to_string(),
            expected_summary: format!(
                "exact_file_bytes;bytes:{};sha256:{}",
                expected_len, expected_sha256
            ),
        })
    }

    pub(crate) fn executable(&self) -> &Path {
        match &self.target {
            HostVerificationTarget::Command { executable, .. } => executable,
            HostVerificationTarget::ExactFileBytes { .. } => {
                panic!("exact-file verification has no executable")
            }
        }
    }

    pub(crate) fn argv(&self) -> &[String] {
        match &self.target {
            HostVerificationTarget::Command { argv, .. } => argv,
            HostVerificationTarget::ExactFileBytes { .. } => {
                panic!("exact-file verification has no argv")
            }
        }
    }

    pub(crate) fn command_display(&self) -> String {
        match &self.target {
            HostVerificationTarget::Command { executable, argv } => shell_words::join(
                std::iter::once(executable.to_string_lossy().into_owned())
                    .chain(argv.iter().cloned()),
            ),
            HostVerificationTarget::ExactFileBytes { relative_path, .. } => {
                format!("host_exact_bytes {}", relative_path.display())
            }
        }
    }

    pub(crate) fn shell_kind(&self) -> &'static str {
        match &self.target {
            HostVerificationTarget::Command { .. } => "direct",
            HostVerificationTarget::ExactFileBytes { .. } => "host_exact_bytes",
        }
    }

    fn exact_file_target(&self) -> Option<(&Path, &[u8])> {
        match &self.target {
            HostVerificationTarget::ExactFileBytes {
                relative_path,
                expected_bytes,
            } => Some((relative_path, expected_bytes)),
            HostVerificationTarget::Command { .. } => None,
        }
    }

    pub(crate) fn from_command(
        command_line: &str,
        runtime_probe: Option<&TesterRuntimeProbe>,
    ) -> Result<Self, String> {
        let command_line = normalize_host_verification_command_line(command_line);
        let selected_python = runtime_probe.and_then(|probe| match &probe.python {
            TesterPythonRuntime::ProjectDotVenv(path)
            | TesterPythonRuntime::ProjectVenv(path)
            | TesterPythonRuntime::PathPython(path) => Some(path.as_path()),
            _ => None,
        });
        parse_host_verification_spec(command_line.as_ref(), selected_python)
    }

    pub(crate) fn from_command_in_workspace(
        command_line: &str,
        runtime_probe: Option<&TesterRuntimeProbe>,
        working_dir: &Path,
    ) -> Result<Self, String> {
        let command_line = normalize_host_verification_command_line(command_line);
        if let Some(spec) = python_script_verification_spec_in_workspace(
            command_line.as_ref(),
            runtime_probe,
            working_dir,
        )? {
            return Ok(spec);
        }
        if let Some(spec) =
            node_script_verification_spec_in_workspace(command_line.as_ref(), working_dir)?
        {
            return Ok(spec);
        }
        #[cfg(windows)]
        if command_line.trim().eq_ignore_ascii_case("npm test") {
            let package_json = working_dir.join("package.json");
            let value = std::fs::read_to_string(&package_json)
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
            if let Some(script) = value
                .as_ref()
                .and_then(|value| value.get("scripts"))
                .and_then(|scripts| scripts.get("test"))
                .and_then(serde_json::Value::as_str)
            {
                if let Ok(spec) = node_script_verification_spec_in_workspace(script, working_dir)
                    .and_then(|spec| {
                        spec.map_or_else(|| Self::from_command(script, runtime_probe), Ok)
                    })
                {
                    return Ok(spec);
                }
            }
        }
        Self::from_command(command_line.as_ref(), runtime_probe)
    }

    pub(crate) fn from_durable_direct_command_in_workspace(
        command_line: &str,
        runtime_probe: Option<&TesterRuntimeProbe>,
        working_dir: &Path,
    ) -> Result<Self, String> {
        match Self::from_command_in_workspace(command_line, runtime_probe, working_dir) {
            Ok(spec) => Ok(spec),
            Err(original_error) => {
                let parts = shell_words::split(command_line)
                    .map_err(|_| "host verification command has invalid quoting".to_string())?;
                if let Some((executable, argv)) = parts.split_first() {
                    if Path::new(executable).is_absolute()
                        && argv.first().map(String::as_str) == Some("--test")
                        && is_trusted_node_command(executable)?
                    {
                        for script in &argv[1..] {
                            node_test_file_verification_spec_in_workspace(
                                Path::new(script),
                                working_dir,
                            )?;
                        }
                        return Self::new(PathBuf::from(executable), argv.to_vec());
                    }
                }
                #[cfg(windows)]
                {
                    let parts = command_line.split_whitespace().collect::<Vec<_>>();
                    if let [executable, script] = parts.as_slice() {
                        if is_trusted_node_command(executable)? {
                            return node_test_file_verification_spec_in_workspace(
                                Path::new(script),
                                working_dir,
                            );
                        }
                    }
                }
                Err(original_error)
            }
        }
    }

    pub(crate) fn validate_durable_direct_command_identity(
        command_line: &str,
        assertion_id: &str,
    ) -> Result<(), String> {
        let command_line = normalize_host_verification_command_line(command_line);
        let parts = shell_words::split(command_line.as_ref())
            .map_err(|_| "durable host receipt has invalid command quoting".to_string())?;
        let (executable, argv) = parts
            .split_first()
            .ok_or_else(|| "durable host receipt has no command".to_string())?;
        let recorded = Self::new(PathBuf::from(executable), argv.to_vec())?;
        if recorded.assertion_id != assertion_id {
            return Err("durable host receipt command identity does not match".to_string());
        }
        Ok(())
    }

    pub(crate) fn from_test_file_in_workspace(
        test_file: &Path,
        runtime_probe: Option<&TesterRuntimeProbe>,
        working_dir: &Path,
    ) -> Result<Self, String> {
        let extension = test_file
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        match extension.as_str() {
            "py" => runtime_probe
                .ok_or_else(|| "Tester Python runtime was not selected".to_string())?
                .python_script_spec(test_file),
            "js" | "cjs" | "mjs" => {
                node_test_file_verification_spec_in_workspace(test_file, working_dir)
            }
            _ => Err("host verification test file type is unsupported".to_string()),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(executable: PathBuf, argv: Vec<String>) -> Self {
        let executable = if executable.is_absolute() {
            executable
        } else {
            resolve_trusted_executable(executable.to_string_lossy().as_ref())
                .expect("test verification executable is available")
        };
        Self::new(executable, argv).expect("valid test verification spec")
    }
}

fn python_script_verification_spec_in_workspace(
    command_line: &str,
    runtime_probe: Option<&TesterRuntimeProbe>,
    working_dir: &Path,
) -> Result<Option<HostVerificationSpec>, String> {
    let Some(runtime_probe) = runtime_probe else {
        return Ok(None);
    };
    let parts = shell_words::split(command_line)
        .map_err(|_| "host verification command has invalid quoting".to_string())?;
    let Some((executable, argv)) = parts.split_first() else {
        return Ok(None);
    };

    let script = match &runtime_probe.python {
        TesterPythonRuntime::ProjectDotVenv(selected)
        | TesterPythonRuntime::ProjectVenv(selected)
        | TesterPythonRuntime::PathPython(selected) => {
            if !matches_selected_executable(
                executable,
                selected,
                &["python", "python.exe", "python3", "python3.exe"],
            ) || argv.len() != 1
            {
                return Ok(None);
            }
            &argv[0]
        }
        TesterPythonRuntime::UvRun(selected) => {
            if !matches_selected_executable(executable, selected, &["uv", "uv.exe"])
                || argv.len() != 3
                || argv[0] != "run"
                || argv[1] != "python"
            {
                return Ok(None);
            }
            &argv[2]
        }
        TesterPythonRuntime::Unavailable => return Ok(None),
    };
    if !Path::new(script)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("py"))
    {
        return Ok(None);
    }

    python_test_file_verification_spec_in_workspace(Path::new(script), runtime_probe, working_dir)
        .map(Some)
}

fn matches_selected_executable(executable: &str, selected: &Path, bare_names: &[&str]) -> bool {
    let executable_path = Path::new(executable);
    same_selected_executable_path(executable_path, selected)
        || (executable_path.components().count() == 1
            && executable_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    bare_names
                        .iter()
                        .any(|candidate| name.eq_ignore_ascii_case(candidate))
                }))
}

fn same_selected_executable_path(candidate: &Path, selected: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |path: &Path| {
            ordinary_windows_process_path(path.to_path_buf())
                .to_string_lossy()
                .replace('/', "\\")
                .to_ascii_lowercase()
        };
        normalize(candidate) == normalize(selected)
    }
    #[cfg(not(windows))]
    {
        candidate == selected
    }
}

fn python_test_file_verification_spec_in_workspace(
    script: &Path,
    runtime_probe: &TesterRuntimeProbe,
    working_dir: &Path,
) -> Result<HostVerificationSpec, String> {
    let extension = script
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let has_test_intent = script.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        value == "test" || value == "tests" || value.contains("test") || value.contains("spec")
    });
    if !extension.eq_ignore_ascii_case("py") || !has_test_intent {
        return Err("Python host verification script must be a test/spec file".to_string());
    }
    if !script.is_absolute()
        && script.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err("Python host verification script must stay inside the workspace".to_string());
    }

    let workspace = working_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve verification workspace: {error}"))?;
    let resolved_script = if script.is_absolute() {
        script.to_path_buf()
    } else {
        working_dir.join(script)
    }
    .canonicalize()
    .map_err(|error| format!("failed to resolve Python verification script: {error}"))?;
    if !resolved_script.starts_with(&workspace) || !resolved_script.is_file() {
        return Err("Python host verification script escaped the workspace".to_string());
    }
    let relative_script = resolved_script
        .strip_prefix(&workspace)
        .map_err(|_| "Python host verification script escaped the workspace".to_string())?;

    runtime_probe.python_script_spec(relative_script)
}

fn node_script_verification_spec_in_workspace(
    command_line: &str,
    working_dir: &Path,
) -> Result<Option<HostVerificationSpec>, String> {
    let parts = shell_words::split(command_line)
        .map_err(|_| "host verification command has invalid quoting".to_string())?;
    let Some((executable, argv)) = parts.split_first() else {
        return Ok(None);
    };
    if !is_trusted_node_command(executable)? || argv.iter().any(|argument| argument == "--test") {
        return Ok(None);
    }
    if argv.len() != 1 {
        return Ok(None);
    }

    let script = Path::new(&argv[0]);
    let spec = node_test_file_verification_spec_in_workspace(script, working_dir)?;
    Ok(Some(spec))
}

fn is_trusted_node_command(executable: &str) -> Result<bool, String> {
    let path = Path::new(executable);
    let is_node = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("node") || name.eq_ignore_ascii_case("node.exe")
        });
    if !is_node {
        return Ok(false);
    }
    if path.components().count() == 1 {
        return Ok(true);
    }
    if !path.is_absolute() {
        return Ok(false);
    }

    let candidate = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve durable Node executable: {error}"))?;
    let trusted = resolve_trusted_executable("node")?
        .canonicalize()
        .map_err(|error| format!("failed to resolve selected Node executable: {error}"))?;
    Ok(candidate == trusted)
}

fn node_test_file_verification_spec_in_workspace(
    script: &Path,
    working_dir: &Path,
) -> Result<HostVerificationSpec, String> {
    let extension = script
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let has_test_intent = script.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        value == "test" || value == "tests" || value.contains("test") || value.contains("spec")
    });
    if !matches!(extension.as_str(), "js" | "cjs" | "mjs") || !has_test_intent {
        return Err(
            "Node host verification script must be a test/spec JavaScript file".to_string(),
        );
    }
    if !script.is_absolute()
        && script.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err("Node host verification script must stay inside the workspace".to_string());
    }

    let workspace = working_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve verification workspace: {error}"))?;
    let resolved_script = if script.is_absolute() {
        script.to_path_buf()
    } else {
        working_dir.join(script)
    }
    .canonicalize()
    .map_err(|error| format!("failed to resolve Node verification script: {error}"))?;
    if !resolved_script.starts_with(&workspace) || !resolved_script.is_file() {
        return Err("Node host verification script escaped the workspace".to_string());
    }

    let relative_script = resolved_script
        .strip_prefix(&workspace)
        .map_err(|_| "Node host verification script escaped the workspace".to_string())?;
    if relative_script.components().any(|component| {
        !matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        return Err("Node host verification script must stay inside the workspace".to_string());
    }

    HostVerificationSpec::new(
        resolve_trusted_executable("node")?,
        vec![relative_script.to_string_lossy().into_owned()],
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostVerificationOutcome {
    Passed,
    Failed,
    PrerequisiteUnavailable,
    LaunchFailed,
    TimedOut,
    Cancelled,
    TerminationFailed,
    CaptureFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostVerificationReceipt {
    pub(crate) assertion_id: String,
    pub(crate) exit_code: Option<i64>,
    pub(crate) outcome: HostVerificationOutcome,
    pub(crate) stdout_blake3: String,
    pub(crate) stderr_blake3: String,
    pub(crate) stdout_bytes: u64,
    pub(crate) stderr_bytes: u64,
    pub(crate) expected_summary: String,
    pub(crate) artifact_sha256: Option<String>,
    pub(crate) recorded_at: chrono::DateTime<chrono::Utc>,
}

impl HostVerificationReceipt {
    pub(crate) fn observed_summary(&self) -> String {
        bounded_text(&format!(
            "outcome:{:?};exit_code:{};stdout_bytes:{};stderr_bytes:{};stdout_blake3:{};stderr_blake3:{}",
            self.outcome,
            self.exit_code
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string()),
            self.stdout_bytes,
            self.stderr_bytes,
            self.stdout_blake3,
            self.stderr_blake3
        ))
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        assertion_id: &str,
        outcome: HostVerificationOutcome,
        exit_code: Option<i64>,
    ) -> Self {
        Self {
            assertion_id: assertion_id.to_string(),
            exit_code,
            outcome,
            stdout_blake3: blake3::hash(b"").to_hex().to_string(),
            stderr_blake3: blake3::hash(b"").to_hex().to_string(),
            stdout_bytes: 0,
            stderr_bytes: 0,
            expected_summary: "exit_code:0".to_string(),
            artifact_sha256: None,
            recorded_at: chrono::Utc::now(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TesterPythonRuntime {
    ProjectDotVenv(PathBuf),
    ProjectVenv(PathBuf),
    PathPython(PathBuf),
    UvRun(PathBuf),
    Unavailable,
}

#[derive(Clone, Debug)]
pub(crate) struct TesterRuntimeProbe {
    shell: String,
    python: TesterPythonRuntime,
}

impl TesterRuntimeProbe {
    pub(crate) async fn detect(working_dir: &std::path::Path, shell: impl Into<String>) -> Self {
        let dot_venv = project_python(working_dir, ".venv").await;
        let venv = if dot_venv.is_none() {
            project_python(working_dir, "venv").await
        } else {
            None
        };
        let path_python = if dot_venv.is_none() && venv.is_none() {
            path_python(working_dir).await
        } else {
            None
        };
        let uv = if dot_venv.is_none() && venv.is_none() && path_python.is_none() {
            path_uv(working_dir).await
        } else {
            None
        };

        Self::from_candidates(shell, dot_venv, venv, path_python, uv)
    }

    fn from_candidates(
        shell: impl Into<String>,
        dot_venv: Option<PathBuf>,
        venv: Option<PathBuf>,
        path_python: Option<PathBuf>,
        uv: Option<PathBuf>,
    ) -> Self {
        let python = if let Some(executable) = dot_venv {
            TesterPythonRuntime::ProjectDotVenv(executable)
        } else if let Some(executable) = venv {
            TesterPythonRuntime::ProjectVenv(executable)
        } else if let Some(executable) = path_python {
            TesterPythonRuntime::PathPython(executable)
        } else if let Some(executable) = uv {
            TesterPythonRuntime::UvRun(executable)
        } else {
            TesterPythonRuntime::Unavailable
        };

        Self {
            shell: shell.into(),
            python,
        }
    }

    #[cfg(test)]
    pub(crate) fn path_python_for_test(shell: impl Into<String>, executable: PathBuf) -> Self {
        Self::from_candidates(shell, None, None, Some(executable), None)
    }

    #[cfg(test)]
    pub(crate) fn unavailable_for_test(shell: impl Into<String>) -> Self {
        Self::from_candidates(shell, None, None, None, None)
    }

    pub(crate) fn python_unavailable(&self) -> bool {
        matches!(self.python, TesterPythonRuntime::Unavailable)
    }

    pub(crate) fn python_script_command(&self, script: &std::path::Path) -> Option<String> {
        let script = shell_argument(&self.shell, script);
        match &self.python {
            TesterPythonRuntime::ProjectDotVenv(executable)
            | TesterPythonRuntime::ProjectVenv(executable)
            | TesterPythonRuntime::PathPython(executable) => Some(format!(
                "{} {script}",
                shell_executable(&self.shell, executable)
            )),
            TesterPythonRuntime::UvRun(executable) => Some(format!(
                "{} run python {script}",
                shell_executable(&self.shell, executable)
            )),
            TesterPythonRuntime::Unavailable => None,
        }
    }

    #[cfg(test)]
    pub(crate) fn python_module_command(&self, module: &str, arguments: &str) -> Option<String> {
        let prefix = match &self.python {
            TesterPythonRuntime::ProjectDotVenv(executable)
            | TesterPythonRuntime::ProjectVenv(executable)
            | TesterPythonRuntime::PathPython(executable) => {
                format!("{} -m {module}", shell_executable(&self.shell, executable))
            }
            TesterPythonRuntime::UvRun(executable) => format!(
                "{} run python -m {module}",
                shell_executable(&self.shell, executable)
            ),
            TesterPythonRuntime::Unavailable => return None,
        };
        let arguments = arguments.trim();
        Some(if arguments.is_empty() {
            prefix
        } else {
            format!("{prefix} {arguments}")
        })
    }

    pub(crate) fn host_verification_spec(
        &self,
        command_line: &str,
    ) -> Result<HostVerificationSpec, String> {
        let selected_python = match &self.python {
            TesterPythonRuntime::ProjectDotVenv(path)
            | TesterPythonRuntime::ProjectVenv(path)
            | TesterPythonRuntime::PathPython(path) => Some(path.as_path()),
            _ => None,
        };
        parse_host_verification_spec(command_line, selected_python)
    }

    pub(crate) fn python_script_spec(&self, script: &Path) -> Result<HostVerificationSpec, String> {
        match &self.python {
            TesterPythonRuntime::ProjectDotVenv(executable)
            | TesterPythonRuntime::ProjectVenv(executable)
            | TesterPythonRuntime::PathPython(executable) => HostVerificationSpec::new(
                executable.clone(),
                vec![script.to_string_lossy().into_owned()],
            ),
            TesterPythonRuntime::UvRun(executable) => HostVerificationSpec::new(
                executable.clone(),
                vec![
                    "run".to_string(),
                    "python".to_string(),
                    script.to_string_lossy().into_owned(),
                ],
            ),
            TesterPythonRuntime::Unavailable => Err("Python runtime is unavailable".to_string()),
        }
    }

    pub(crate) fn python_module_spec(
        &self,
        module: &str,
        arguments: &str,
    ) -> Result<HostVerificationSpec, String> {
        if module != "pytest" {
            return Err("unsupported Python verification module".to_string());
        }
        let extra = shell_words::split(arguments)
            .map_err(|_| "Python verification arguments have invalid quoting".to_string())?;
        match &self.python {
            TesterPythonRuntime::ProjectDotVenv(executable)
            | TesterPythonRuntime::ProjectVenv(executable)
            | TesterPythonRuntime::PathPython(executable) => {
                let mut argv = vec!["-m".to_string(), module.to_string()];
                argv.extend(extra);
                HostVerificationSpec::new(executable.clone(), argv)
            }
            TesterPythonRuntime::UvRun(executable) => {
                let mut argv = vec![
                    "run".to_string(),
                    "python".to_string(),
                    "-m".to_string(),
                    module.to_string(),
                ];
                argv.extend(extra);
                HostVerificationSpec::new(executable.clone(), argv)
            }
            TesterPythonRuntime::Unavailable => Err("Python runtime is unavailable".to_string()),
        }
    }

    pub(crate) fn instructions(&self) -> String {
        match &self.python {
            TesterPythonRuntime::ProjectDotVenv(executable) => self
                .available_instructions("项目 .venv", &shell_executable(&self.shell, executable)),
            TesterPythonRuntime::ProjectVenv(executable) => {
                self.available_instructions("项目 venv", &shell_executable(&self.shell, executable))
            }
            TesterPythonRuntime::PathPython(executable) => self.available_instructions(
                "PATH 中真实 Python",
                &shell_executable(&self.shell, executable),
            ),
            TesterPythonRuntime::UvRun(executable) => self.available_instructions(
                "uv run",
                &format!("{} run python", shell_executable(&self.shell, executable)),
            ),
            TesterPythonRuntime::Unavailable => format!(
                "宿主运行时探测结果：\n- Shell：{}\n- Python：环境不可用\n不得为寻找 Python 执行诊断命令，也不得扫描工作目录之外的位置。若任务需要 Python，请直接把环境限制写入报告；仍可执行与任务相关的非 Python 验证。",
                self.shell
            ),
        }
    }

    fn available_instructions(&self, source: &str, command_prefix: &str) -> String {
        format!(
            "宿主运行时探测结果：\n- Shell：{}\n- Python 来源：{source}\n- Python 命令前缀：{command_prefix}\n必须原样使用这个前缀运行 Python 测试；不得自行探测、搜索或改用其他 Python。",
            self.shell
        )
    }
}

fn parse_host_verification_spec(
    command_line: &str,
    selected_python: Option<&Path>,
) -> Result<HostVerificationSpec, String> {
    let parts = shell_words::split(command_line)
        .map_err(|_| "host verification command has invalid quoting".to_string())?;
    let (executable, argv) = parts
        .split_first()
        .ok_or_else(|| "host verification command is empty".to_string())?;
    let executable_path = PathBuf::from(executable);
    let is_selected_python = selected_python
        .is_some_and(|path| same_selected_executable_path(executable_path.as_path(), path));
    if !is_selected_python
        && (executable.contains('/')
            || executable.contains('\\')
            || executable_path.components().count() != 1)
    {
        return Err("host verification executable must be an allowlisted command name".to_string());
    }
    let executable_name = executable.to_ascii_lowercase();
    if let Some(selected) = selected_python.filter(|_| {
        (is_selected_python
            || matches!(
                executable_name.as_str(),
                "python" | "python.exe" | "python3" | "python3.exe"
            ))
            && is_safe_python_verification_argv(argv)
    }) {
        if !selected.is_absolute() {
            return Err("host-selected Python executable must be absolute".to_string());
        }
        return HostVerificationSpec::new(selected.to_path_buf(), argv.to_vec());
    }
    let supported = match executable_name.as_str() {
        "cargo" | "cargo.exe" => argv.first().map(String::as_str) == Some("test"),
        "node" | "node.exe" => argv.iter().any(|argument| argument == "--test"),
        "npm" | "pnpm" | "yarn" => argv
            .iter()
            .any(|argument| matches!(argument.as_str(), "test" | "vitest")),
        "ruff" | "ruff.exe" => is_read_only_ruff_check(argv),
        _ => false,
    };
    if !supported {
        return Err("unsupported host verification executable or argv shape".to_string());
    }
    #[cfg(windows)]
    if executable_name == "npm" {
        return windows_npm_verification_spec(argv);
    }
    HostVerificationSpec::new(resolve_trusted_executable(executable)?, argv.to_vec())
}

pub(crate) fn is_bounded_absolute_python_validation_command(command_line: &str) -> bool {
    let command_line = normalize_host_verification_command_line(command_line);
    let Ok(parts) = shell_words::split(command_line.as_ref()) else {
        return false;
    };
    let Some(executable) = parts.first() else {
        return false;
    };
    let executable_path = PathBuf::from(executable);
    let executable_name = executable_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    executable_path.is_absolute()
        && matches!(
            executable_name.as_str(),
            "python" | "python.exe" | "python3" | "python3.exe"
        )
        && parse_host_verification_spec(command_line.as_ref(), Some(&executable_path)).is_ok()
}

fn normalize_host_verification_command_line(command_line: &str) -> std::borrow::Cow<'_, str> {
    if cfg!(windows) {
        let trimmed = command_line.trim();
        let executable_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        let (executable, remainder) = trimmed.split_at(executable_end);
        let bytes = executable.as_bytes();
        if !trimmed.starts_with('"')
            && !trimmed.starts_with('\'')
            && bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/')
        {
            std::borrow::Cow::Owned(format!("\"{executable}\"{remainder}"))
        } else {
            std::borrow::Cow::Borrowed(command_line)
        }
    } else {
        std::borrow::Cow::Borrowed(command_line)
    }
}

fn is_safe_python_verification_argv(argv: &[String]) -> bool {
    let Some((module_flag, remaining)) = argv.split_first() else {
        return false;
    };
    let Some((module, arguments)) = remaining.split_first() else {
        return false;
    };
    if module_flag != "-m" {
        return false;
    }

    match module.as_str() {
        "pytest" => true,
        "ruff" => is_read_only_ruff_check(arguments),
        "mypy" => is_bounded_mypy_check(arguments),
        "compileall" => is_bounded_compileall(arguments),
        "pip" => arguments == ["check"],
        _ => false,
    }
}

fn is_read_only_ruff_check(arguments: &[String]) -> bool {
    arguments.first().map(String::as_str) == Some("check")
        && !arguments.iter().skip(1).any(|argument| {
            matches!(
                argument.as_str(),
                "--fix"
                    | "--fix-only"
                    | "--unsafe-fixes"
                    | "--add-noqa"
                    | "--cache-dir"
                    | "--output-file"
            ) || argument.starts_with("--fix=")
                || argument.starts_with("--fix-only=")
                || argument.starts_with("--unsafe-fixes=")
                || argument.starts_with("--cache-dir=")
                || argument.starts_with("--output-file=")
        })
}

fn is_bounded_mypy_check(arguments: &[String]) -> bool {
    !arguments.iter().any(|argument| {
        matches!(
            argument.as_str(),
            "--cache-dir" | "--install-types" | "--junit-xml"
        ) || argument.starts_with("--cache-dir=")
            || argument.starts_with("--junit-xml=")
            || (argument.starts_with("--") && argument.ends_with("-report"))
            || (argument.starts_with("--") && argument.contains("-report="))
    })
}

fn is_bounded_compileall(arguments: &[String]) -> bool {
    let mut has_target = false;
    for argument in arguments {
        if argument == "-q" {
            continue;
        }
        if argument.starts_with('-') {
            return false;
        }
        let target = Path::new(argument);
        if target.as_os_str().is_empty()
            || target.is_absolute()
            || target.components().any(|component| {
                !matches!(
                    component,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            })
        {
            return false;
        }
        has_target = true;
    }
    has_target
}

#[cfg(windows)]
fn windows_npm_verification_spec(argv: &[String]) -> Result<HostVerificationSpec, String> {
    let node = resolve_trusted_executable("node")?;
    let node_dir = node
        .parent()
        .ok_or_else(|| "trusted Node executable has no parent directory".to_string())?
        .canonicalize()
        .map_err(|error| format!("failed to resolve trusted Node directory: {error}"))?;
    let npm_cli = node_dir
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js")
        .canonicalize()
        .map_err(|_| "npm CLI was not found beside the trusted Node executable".to_string())?;
    if !npm_cli.starts_with(&node_dir) || !npm_cli.is_file() {
        return Err("npm CLI escaped the trusted Node installation".to_string());
    }
    let node = ordinary_windows_process_path(node);
    let npm_cli = ordinary_windows_process_path(npm_cli);
    let mut node_argv = vec![npm_cli.to_string_lossy().into_owned()];
    node_argv.extend_from_slice(argv);
    HostVerificationSpec::new(node, node_argv)
}

#[cfg(windows)]
fn ordinary_windows_process_path(path: PathBuf) -> PathBuf {
    let display = path.to_string_lossy();
    if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    display
        .strip_prefix(r"\\?\")
        .map_or(path.clone(), PathBuf::from)
}

fn resolve_trusted_executable(executable: &str) -> Result<PathBuf, String> {
    if executable.is_empty()
        || executable.contains('/')
        || executable.contains('\\')
        || Path::new(executable).components().count() != 1
    {
        return Err("host verification executable must be an allowlisted command name".to_string());
    }
    let extension = Path::new(executable)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat") {
        return Err("Windows command scripts are not supported for host verification".to_string());
    }

    let search_path = std::env::var_os("PATH").unwrap_or_default();
    for directory in std::env::split_paths(&search_path).filter(|path| path.is_absolute()) {
        #[cfg(windows)]
        let candidates = if extension.is_empty() {
            vec![directory.join(format!("{executable}.exe"))]
        } else {
            vec![directory.join(executable)]
        };
        #[cfg(not(windows))]
        let candidates = vec![directory.join(executable)];

        for candidate in candidates {
            if !candidate.is_file() {
                continue;
            }
            let resolved = candidate.canonicalize().map_err(|error| {
                format!("failed to resolve host verification executable: {error}")
            })?;
            let resolved_extension = resolved
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if matches!(resolved_extension.as_str(), "cmd" | "bat") {
                return Err(
                    "Windows command scripts are not supported for host verification".to_string(),
                );
            }
            return Ok(resolved);
        }
    }
    Err("host verification executable was not found on the trusted host PATH".to_string())
}

#[derive(Clone, Debug)]
struct StreamDigest {
    blake3: String,
    bytes_seen: u64,
    tail: String,
    #[cfg(test)]
    peak_buffer_bytes: usize,
}

#[derive(Debug, thiserror::Error)]
enum StreamCaptureError {
    #[error("verification output drain timed out")]
    TimedOut,
    #[error("verification stdout reader failed: {0}")]
    Stdout(String),
    #[error("verification stderr reader failed: {0}")]
    Stderr(String),
}

async fn drain_and_hash(mut reader: impl AsyncRead + Unpin) -> std::io::Result<StreamDigest> {
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; STREAM_BUFFER_BYTES];
    let mut bytes_seen = 0_u64;
    let mut tail = String::new();
    #[cfg(test)]
    let mut peak_buffer_bytes = 0_usize;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes_seen = bytes_seen.saturating_add(count as u64);
        tail.push_str(&String::from_utf8_lossy(&buffer[..count]));
        bound_tail(&mut tail);
        #[cfg(test)]
        {
            peak_buffer_bytes = peak_buffer_bytes.max(count);
        }
    }
    Ok(StreamDigest {
        blake3: hasher.finalize().to_hex().to_string(),
        bytes_seen,
        tail,
        #[cfg(test)]
        peak_buffer_bytes,
    })
}

async fn drain_hash_and_observe(
    mut reader: impl AsyncRead + Unpin,
    stream: TestOutputStream,
    live: Arc<Mutex<LiveTestOutput>>,
) -> std::io::Result<StreamDigest> {
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; STREAM_BUFFER_BYTES];
    let mut bytes_seen = 0_u64;
    let mut tail = String::new();
    #[cfg(test)]
    let mut peak_buffer_bytes = 0_usize;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes_seen = bytes_seen.saturating_add(count as u64);
        tail.push_str(&String::from_utf8_lossy(&buffer[..count]));
        bound_tail(&mut tail);
        if let Ok(mut state) = live.lock() {
            state.observe(stream, &buffer[..count]);
        }
        #[cfg(test)]
        {
            peak_buffer_bytes = peak_buffer_bytes.max(count);
        }
    }
    Ok(StreamDigest {
        blake3: hasher.finalize().to_hex().to_string(),
        bytes_seen,
        tail,
        #[cfg(test)]
        peak_buffer_bytes,
    })
}

fn bound_tail(tail: &mut String) {
    if tail.len() <= TEST_PROGRESS_TAIL_BYTES {
        return;
    }
    let mut start = tail.len() - TEST_PROGRESS_TAIL_BYTES;
    while start < tail.len() && !tail.is_char_boundary(start) {
        start += 1;
    }
    tail.drain(..start);
}

fn classify_failed_process_output(stdout: &str, stderr: &str) -> HostVerificationOutcome {
    let output = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    if [
        "connection refused",
        "connectionrefusederror",
        "econnrefused",
        "winerror 10061",
        "actively refused it",
        "无法连接，因为目标计算机积极拒绝",
        "urlopen error timed out",
        "'python' is not recognized",
        "'py' is not recognized",
        "'python' 不是内部或外部命令",
        "'py' 不是内部或外部命令",
        "no module named",
        "modulenotfounderror",
        "could not find cmake",
        "cmake was not found",
        "unable to find libclang",
        "依赖未安装",
        "依赖缺失",
        "未找到所需的运行环境",
    ]
    .iter()
    .any(|marker| output.contains(marker))
    {
        HostVerificationOutcome::PrerequisiteUnavailable
    } else {
        HostVerificationOutcome::Failed
    }
}

fn prerequisite_recovery_prompt(stdout: &str, stderr: &str) -> String {
    let output = format!("{stdout}\n{stderr}");
    let normalized = output.to_ascii_lowercase();
    let resume = "已保存当前检查点；处理后会自动重跑同一测试命令。";
    if normalized.contains("no module named") || normalized.contains("modulenotfounderror") {
        let module = normalized
            .split_once("no module named")
            .map(|(_, remainder)| {
                remainder
                    .trim()
                    .trim_matches(|character: char| {
                        character == '\''
                            || character == '"'
                            || character == ':'
                            || character.is_whitespace()
                    })
                    .split_whitespace()
                    .next()
                    .unwrap_or("所需依赖")
                    .trim_matches(|character| character == '\'' || character == '"')
            })
            .filter(|module| !module.is_empty())
            .unwrap_or("所需依赖");
        return format!(
            "缺少 Python 依赖 {module}。请提供项目约定的安装命令，或确认是否允许安装该依赖。{resume}"
        );
    }
    if normalized.contains("python")
        && (normalized.contains("not recognized")
            || normalized.contains("不是内部或外部命令")
            || normalized.contains("系统找不到文件"))
    {
        return format!(
            "未找到 Python 3。请提供现有 python.exe 路径，或确认是否允许安装 Python 3。{resume}"
        );
    }
    if normalized.contains("cmake")
        && (normalized.contains("could not find") || normalized.contains("was not found"))
    {
        return format!(
            "未找到 CMake。请提供现有 cmake.exe 路径，或确认是否允许安装 CMake。{resume}"
        );
    }
    if normalized.contains("libclang") {
        return format!(
            "未找到 libclang。请提供 LIBCLANG_PATH，或确认是否允许安装匹配的 LLVM/Clang。{resume}"
        );
    }
    if [
        "connection refused",
        "connectionrefusederror",
        "econnrefused",
        "winerror 10061",
        "actively refused it",
        "无法连接，因为目标计算机积极拒绝",
        "urlopen error timed out",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return format!("测试依赖的本地服务尚未运行。请提供或确认该服务的启动命令。{resume}");
    }
    format!("测试前置环境不可用。请提供恢复或安装方式。{resume}")
}

#[allow(clippy::too_many_arguments)]
fn progress_snapshot(
    context: &TestExecutionProgressContext,
    spec: &HostVerificationSpec,
    working_dir: &Path,
    started_at: Instant,
    pid: Option<u32>,
    live: &LiveTestOutput,
    phase_override: Option<TestExecutionPhase>,
    outcome: Option<TestExecutionOutcome>,
) -> TestExecutionProgress {
    let last_output = if !live.stderr_tail.trim().is_empty() {
        Some(live.stderr_tail.trim().to_string())
    } else if !live.stdout_tail.trim().is_empty() {
        Some(live.stdout_tail.trim().to_string())
    } else {
        None
    };
    TestExecutionProgress {
        schema_version: TEST_EXECUTION_PROGRESS_SCHEMA_VERSION,
        session_id: context.session_id.clone(),
        run_id: context.run_id.clone(),
        task_id: context.task_id.clone(),
        attempt_id: context.attempt_id.clone(),
        phase: phase_override.unwrap_or(live.phase),
        outcome,
        command: spec.command_display(),
        cwd: working_dir.to_string_lossy().into_owned(),
        manifest_path: context
            .manifest_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        elapsed_ms: started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        current_crate: live.current_crate.clone(),
        current_test: live.current_test.clone(),
        completed: (live.completed > 0).then_some(live.completed),
        total: live.total,
        pid,
        last_output_at: live.last_output_at.map(|value| value.to_rfc3339()),
        heartbeat_at: chrono::Utc::now().to_rfc3339(),
        stdout_tail_ref: Some(format!(
            "test-progress://{}/{}/stdout",
            context.run_id, context.task_id
        )),
        stderr_tail_ref: Some(format!(
            "test-progress://{}/{}/stderr",
            context.run_id, context.task_id
        )),
        last_output,
        retry_attempt: context.retry_attempt,
        repair_attempt: context.repair_attempt,
        can_cancel: outcome.is_none(),
        required_path: None,
        required_permission: None,
        reason: None,
    }
}

async fn collect_stream_digests_with_timeout(
    mut stdout_task: tokio::task::JoinHandle<std::io::Result<StreamDigest>>,
    mut stderr_task: tokio::task::JoinHandle<std::io::Result<StreamDigest>>,
    timeout: Duration,
) -> Result<(StreamDigest, StreamDigest), StreamCaptureError> {
    let result = tokio::time::timeout(timeout, async {
        let (stdout, stderr) = tokio::join!(&mut stdout_task, &mut stderr_task);
        let stdout = stdout
            .map_err(|error| StreamCaptureError::Stdout(error.to_string()))?
            .map_err(|error| StreamCaptureError::Stdout(error.to_string()))?;
        let stderr = stderr
            .map_err(|error| StreamCaptureError::Stderr(error.to_string()))?
            .map_err(|error| StreamCaptureError::Stderr(error.to_string()))?;
        Ok((stdout, stderr))
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            stdout_task.abort();
            stderr_task.abort();
            Err(StreamCaptureError::TimedOut)
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn host_repair_path_lock(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "host repair path-lock registry is unavailable".to_string())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    Ok(lock)
}

fn apply_host_repair_with_hooks<B, P>(
    action: &HostRepairActionV1,
    contract: &HostVerificationContractV1,
    working_dir: &Path,
    cancellation_token: &CancellationToken,
    before_publish: B,
    persist: P,
) -> Result<HostVerificationSpec, String>
where
    B: FnOnce(&Path),
    P: FnOnce(tempfile::NamedTempFile, &Path) -> Result<(), String>,
{
    if cancellation_token.is_cancelled() {
        return Err("host repair was cancelled before execution".to_string());
    }
    action.validate_against(contract)?;
    let expected_bytes = contract.validate()?;
    let expected_precondition = action
        .precondition_sha256
        .as_deref()
        .ok_or_else(|| "host repair has no failed-receipt precondition".to_string())?;
    let workspace = std::fs::canonicalize(working_dir)
        .map_err(|error| format!("canonicalizing the workspace failed: {error}"))?;
    let joined_artifact = workspace.join(&action.artifact_relative_path);
    let link_metadata = std::fs::symlink_metadata(&joined_artifact)
        .map_err(|error| format!("reading repair artifact metadata failed: {error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("repair artifact must not be a symbolic link".to_string());
    }
    let artifact = std::fs::canonicalize(&joined_artifact)
        .map_err(|error| format!("canonicalizing the repair artifact failed: {error}"))?;
    if !artifact.starts_with(&workspace) {
        return Err("repair artifact resolves outside the workspace".to_string());
    }
    let path_lock = host_repair_path_lock(&artifact)?;
    let _path_guard = path_lock
        .lock()
        .map_err(|_| "host repair path lock is unavailable".to_string())?;
    let metadata = std::fs::metadata(&artifact)
        .map_err(|error| format!("reading repair artifact metadata failed: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_EXPECTED_FILE_BYTES as u64 {
        return Err("repair artifact is not a bounded regular file".to_string());
    }
    let current_bytes = std::fs::read(&artifact)
        .map_err(|error| format!("reading repair artifact failed: {error}"))?;
    if sha256_hex(&current_bytes) != expected_precondition {
        return Err("repair artifact changed after the failed host receipt".to_string());
    }

    let repaired_bytes = match &action.action {
        HostRepairActionKindV1::AppendBytes { bytes_base64 } => {
            let appended = base64::prelude::BASE64_STANDARD
                .decode(bytes_base64.as_bytes())
                .map_err(|_| "append_bytes must be canonical base64".to_string())?;
            let mut repaired = current_bytes.clone();
            repaired.extend_from_slice(&appended);
            repaired
        }
        HostRepairActionKindV1::ReplaceExact { bytes_base64 } => base64::prelude::BASE64_STANDARD
            .decode(bytes_base64.as_bytes())
            .map_err(|_| "replace_exact must be canonical base64".to_string())?,
    };
    if repaired_bytes != expected_bytes {
        return Err("repair action does not uniquely produce the expected bytes".to_string());
    }

    let parent = artifact
        .parent()
        .ok_or_else(|| "repair artifact has no parent directory".to_string())?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".codepro-host-repair-")
        .tempfile_in(parent)
        .map_err(|error| format!("creating repair staging file failed: {error}"))?;
    temporary
        .write_all(&repaired_bytes)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("durably staging repair bytes failed: {error}"))?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(|error| format!("preserving repair artifact permissions failed: {error}"))?;

    before_publish(&artifact);
    if cancellation_token.is_cancelled() {
        return Err("host repair was cancelled before atomic publish".to_string());
    }
    let current_before_publish = std::fs::read(&artifact)
        .map_err(|error| format!("rechecking repair artifact failed: {error}"))?;
    if sha256_hex(&current_before_publish) != expected_precondition {
        return Err("repair artifact changed while the atomic replacement was staged".to_string());
    }
    if cancellation_token.is_cancelled() {
        return Err("host repair was cancelled before atomic publish".to_string());
    }
    persist(temporary, &artifact)?;

    HostVerificationSpec::exact_file_bytes(
        PathBuf::from(&contract.artifact_relative_path),
        expected_bytes,
    )
}

fn persist_host_repair(
    temporary: tempfile::NamedTempFile,
    destination: &Path,
) -> Result<(), String> {
    temporary.persist(destination).map(|_| ()).map_err(|error| {
        format!(
            "atomically replacing the repair artifact failed: {}",
            error.error
        )
    })
}

pub(crate) async fn execute_host_repair_and_verify(
    action: &HostRepairActionV1,
    contract: &HostVerificationContractV1,
    working_dir: &Path,
    timeout: Duration,
    cancellation_token: CancellationToken,
) -> Result<HostVerificationReceipt, String> {
    if cancellation_token.is_cancelled() {
        return Err("host repair was cancelled before execution".to_string());
    }
    let action = action.clone();
    let contract = contract.clone();
    let working_dir = working_dir.to_path_buf();
    let repair_working_dir = working_dir.clone();
    let repair_cancellation_token = cancellation_token.clone();
    let spec = tokio::task::spawn_blocking(move || {
        apply_host_repair_with_hooks(
            &action,
            &contract,
            &repair_working_dir,
            &repair_cancellation_token,
            |_| {},
            persist_host_repair,
        )
    })
    .await
    .map_err(|error| format!("host repair task failed: {error}"))??;
    Ok(execute_host_verification(&spec, &working_dir, timeout, cancellation_token, None).await)
}

async fn execute_exact_file_verification(
    spec: &HostVerificationSpec,
    working_dir: &Path,
    relative_path: &Path,
    expected_bytes: &[u8],
    timeout: Duration,
    cancellation_token: CancellationToken,
) -> HostVerificationReceipt {
    struct FileDigest {
        matches: bool,
        bytes_seen: u64,
        blake3: String,
        sha256: String,
    }

    let verify = async {
        let canonical_root = tokio::fs::canonicalize(working_dir).await?;
        let canonical_target = tokio::fs::canonicalize(working_dir.join(relative_path)).await?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "exact-file verification target escaped the workspace",
            ));
        }
        let mut file = tokio::fs::File::open(canonical_target).await?;
        let mut buffer = [0u8; STREAM_BUFFER_BYTES];
        let mut actual_blake3 = blake3::Hasher::new();
        let mut actual_sha256 = Sha256::new();
        let mut bytes_seen = 0usize;
        let mut matches = true;
        loop {
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            actual_blake3.update(&buffer[..read]);
            actual_sha256.update(&buffer[..read]);
            let end = bytes_seen.saturating_add(read);
            if end > expected_bytes.len()
                || expected_bytes.get(bytes_seen..end) != Some(&buffer[..read])
            {
                matches = false;
            }
            bytes_seen = end;
        }
        matches &= bytes_seen == expected_bytes.len();
        Ok::<_, std::io::Error>(FileDigest {
            matches,
            bytes_seen: bytes_seen as u64,
            blake3: actual_blake3.finalize().to_hex().to_string(),
            sha256: actual_sha256
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        })
    };

    let completion = tokio::select! {
        result = tokio::time::timeout(timeout, verify) => match result {
            Ok(Ok(digest)) => Ok(digest),
            Ok(Err(error)) => Err((HostVerificationOutcome::CaptureFailed, error.to_string())),
            Err(_) => Err((HostVerificationOutcome::TimedOut, "exact-file verification timed out".to_string())),
        },
        _ = cancellation_token.cancelled() => {
            Err((HostVerificationOutcome::Cancelled, "exact-file verification cancelled".to_string()))
        }
    };

    match completion {
        Ok(digest) => HostVerificationReceipt {
            assertion_id: spec.assertion_id.clone(),
            exit_code: Some(if digest.matches { 0 } else { 1 }),
            outcome: if digest.matches {
                HostVerificationOutcome::Passed
            } else {
                HostVerificationOutcome::Failed
            },
            stdout_blake3: digest.blake3,
            stderr_blake3: blake3::hash(b"").to_hex().to_string(),
            stdout_bytes: digest.bytes_seen,
            stderr_bytes: 0,
            expected_summary: spec.expected_summary.clone(),
            artifact_sha256: Some(digest.sha256),
            recorded_at: chrono::Utc::now(),
        },
        Err((outcome, error)) => HostVerificationReceipt {
            assertion_id: spec.assertion_id.clone(),
            exit_code: None,
            outcome,
            stdout_blake3: blake3::hash(b"").to_hex().to_string(),
            stderr_blake3: blake3::hash(error.as_bytes()).to_hex().to_string(),
            stdout_bytes: 0,
            stderr_bytes: error.len() as u64,
            expected_summary: spec.expected_summary.clone(),
            artifact_sha256: None,
            recorded_at: chrono::Utc::now(),
        },
    }
}

pub(crate) async fn execute_host_verification(
    spec: &HostVerificationSpec,
    working_dir: &Path,
    timeout: Duration,
    cancellation_token: CancellationToken,
    process_tracker: Option<std::sync::Arc<dyn SessionProcessTracker>>,
) -> HostVerificationReceipt {
    execute_host_verification_observed(
        spec,
        working_dir,
        timeout,
        cancellation_token,
        process_tracker,
        None,
    )
    .await
}

pub(crate) async fn execute_host_verification_observed(
    spec: &HostVerificationSpec,
    working_dir: &Path,
    timeout: Duration,
    cancellation_token: CancellationToken,
    process_tracker: Option<std::sync::Arc<dyn SessionProcessTracker>>,
    progress_context: Option<TestExecutionProgressContext>,
) -> HostVerificationReceipt {
    if let Some((relative_path, expected_bytes)) = spec.exact_file_target() {
        let receipt = execute_exact_file_verification(
            spec,
            working_dir,
            relative_path,
            expected_bytes,
            timeout,
            cancellation_token,
        )
        .await;
        if let Some(context) = progress_context {
            let live = LiveTestOutput::new(context.initial_phase);
            context.sink.emit(progress_snapshot(
                &context,
                spec,
                working_dir,
                Instant::now(),
                None,
                &live,
                Some(TestExecutionPhase::Completed),
                Some(test_execution_outcome(receipt.outcome)),
            ));
        }
        return receipt;
    }
    execute_host_verification_with_terminator_inner(
        spec,
        working_dir,
        timeout,
        cancellation_token,
        process_tracker,
        &SystemProcessTreeTerminator,
        progress_context,
    )
    .await
}

#[cfg(test)]
async fn execute_host_verification_with_terminator(
    spec: &HostVerificationSpec,
    working_dir: &Path,
    timeout: Duration,
    cancellation_token: CancellationToken,
    process_tracker: Option<std::sync::Arc<dyn SessionProcessTracker>>,
    terminator: &dyn ProcessTreeTerminator,
) -> HostVerificationReceipt {
    execute_host_verification_with_terminator_inner(
        spec,
        working_dir,
        timeout,
        cancellation_token,
        process_tracker,
        terminator,
        None,
    )
    .await
}

async fn execute_host_verification_with_terminator_inner(
    spec: &HostVerificationSpec,
    working_dir: &Path,
    timeout: Duration,
    cancellation_token: CancellationToken,
    process_tracker: Option<std::sync::Arc<dyn SessionProcessTracker>>,
    terminator: &dyn ProcessTreeTerminator,
    progress_context: Option<TestExecutionProgressContext>,
) -> HostVerificationReceipt {
    let progress_started_at = Instant::now();
    let empty_digest = || StreamDigest {
        blake3: blake3::hash(b"").to_hex().to_string(),
        bytes_seen: 0,
        tail: String::new(),
        #[cfg(test)]
        peak_buffer_bytes: 0,
    };
    let receipt =
        |outcome, exit_code, stdout: StreamDigest, stderr: StreamDigest| HostVerificationReceipt {
            assertion_id: spec.assertion_id.clone(),
            exit_code,
            outcome,
            stdout_blake3: stdout.blake3,
            stderr_blake3: stderr.blake3,
            stdout_bytes: stdout.bytes_seen,
            stderr_bytes: stderr.bytes_seen,
            expected_summary: spec.expected_summary.clone(),
            artifact_sha256: None,
            recorded_at: chrono::Utc::now(),
        };

    let mut command = tokio::process::Command::new(spec.executable());
    let process_group = match SystemProcessGroupOwner::new() {
        Ok(owner) => owner,
        Err(error) => {
            return receipt(
                HostVerificationOutcome::TerminationFailed,
                None,
                empty_digest(),
                StreamDigest {
                    blake3: blake3::hash(error.to_string().as_bytes())
                        .to_hex()
                        .to_string(),
                    bytes_seen: error.to_string().len() as u64,
                    tail: error.to_string(),
                    #[cfg(test)]
                    peak_buffer_bytes: 0,
                },
            );
        }
    };
    command
        .args(spec.argv())
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .set_no_window();
    process_group.configure_command(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return HostVerificationReceipt {
                assertion_id: spec.assertion_id.clone(),
                exit_code: None,
                outcome: HostVerificationOutcome::LaunchFailed,
                stdout_blake3: empty_digest().blake3,
                stderr_blake3: blake3::hash(error.to_string().as_bytes())
                    .to_hex()
                    .to_string(),
                stdout_bytes: 0,
                stderr_bytes: error.to_string().len() as u64,
                expected_summary: spec.expected_summary.clone(),
                artifact_sha256: None,
                recorded_at: chrono::Utc::now(),
            };
        }
    };
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let live_output = Arc::new(Mutex::new(LiveTestOutput::new(
        progress_context
            .as_ref()
            .map_or(TestExecutionPhase::RunningTests, |context| {
                context.initial_phase
            }),
    )));
    let stdout_task = if progress_context.is_some() {
        tokio::spawn(drain_hash_and_observe(
            stdout,
            TestOutputStream::Stdout,
            live_output.clone(),
        ))
    } else {
        tokio::spawn(drain_and_hash(stdout))
    };
    let stderr_task = if progress_context.is_some() {
        tokio::spawn(drain_hash_and_observe(
            stderr,
            TestOutputStream::Stderr,
            live_output.clone(),
        ))
    } else {
        tokio::spawn(drain_and_hash(stderr))
    };
    let process_id = child.id();
    let mut process_registered = false;
    if let Err(error) = process_group.attach(&child) {
        let _ = process_group.terminate_group();
        let _ = process_group.wait_empty(TERMINATION_CONFIRM_TIMEOUT).await;
        stdout_task.abort();
        stderr_task.abort();
        return receipt(
            HostVerificationOutcome::TerminationFailed,
            None,
            empty_digest(),
            StreamDigest {
                blake3: blake3::hash(error.to_string().as_bytes())
                    .to_hex()
                    .to_string(),
                bytes_seen: error.to_string().len() as u64,
                tail: error.to_string(),
                #[cfg(test)]
                peak_buffer_bytes: 0,
            },
        );
    }
    if let (Some(tracker), Some(process_id)) = (&process_tracker, process_id) {
        if tracker
            .register_process_owner(process_id, process_group.clone())
            .is_err()
        {
            let _ = process_group.terminate_group();
            let _ = process_group.wait_empty(TERMINATION_CONFIRM_TIMEOUT).await;
            stdout_task.abort();
            stderr_task.abort();
            return receipt(
                HostVerificationOutcome::TerminationFailed,
                None,
                empty_digest(),
                StreamDigest {
                    blake3: blake3::hash(b"tracker registration failed")
                        .to_hex()
                        .to_string(),
                    bytes_seen: "tracker registration failed".len() as u64,
                    tail: "tracker registration failed".to_string(),
                    #[cfg(test)]
                    peak_buffer_bytes: 0,
                },
            );
        }
        process_registered = true;
    }
    if let Err(error) = process_group.resume(&child) {
        let _ = process_group.terminate_group();
        let _ = process_group.wait_empty(TERMINATION_CONFIRM_TIMEOUT).await;
        if process_registered {
            if let (Some(tracker), Some(process_id)) = (&process_tracker, process_id) {
                let _ = tracker.unregister_process(process_id);
            }
        }
        stdout_task.abort();
        stderr_task.abort();
        return receipt(
            HostVerificationOutcome::TerminationFailed,
            None,
            empty_digest(),
            StreamDigest {
                blake3: blake3::hash(error.to_string().as_bytes())
                    .to_hex()
                    .to_string(),
                bytes_seen: error.to_string().len() as u64,
                tail: error.to_string(),
                #[cfg(test)]
                peak_buffer_bytes: 0,
            },
        );
    }

    if let (Some(context), Ok(live)) = (&progress_context, live_output.lock()) {
        context.sink.emit(progress_snapshot(
            context,
            spec,
            working_dir,
            progress_started_at,
            process_id,
            &live,
            None,
            None,
        ));
    }

    enum Completion {
        Exited(std::io::Result<std::process::ExitStatus>),
        Interrupted(HostVerificationOutcome),
    }
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut heartbeat = tokio::time::interval(TEST_PROGRESS_HEARTBEAT);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let completion = loop {
        tokio::select! {
            status = child.wait() => break Completion::Exited(status),
            _ = cancellation_token.cancelled() => break Completion::Interrupted(HostVerificationOutcome::Cancelled),
            _ = &mut deadline => break Completion::Interrupted(HostVerificationOutcome::TimedOut),
            _ = heartbeat.tick(), if progress_context.is_some() => {
                if let (Some(context), Ok(live)) = (&progress_context, live_output.lock()) {
                    context.sink.emit(progress_snapshot(
                        context,
                        spec,
                        working_dir,
                        progress_started_at,
                        process_id,
                        &live,
                        None,
                        None,
                    ));
                }
            }
        }
    };
    let (outcome, exit_code, exit_confirmed) = match completion {
        Completion::Exited(Ok(status)) => (
            if status.success() {
                HostVerificationOutcome::Passed
            } else {
                HostVerificationOutcome::Failed
            },
            status.code().map(i64::from),
            true,
        ),
        Completion::Exited(Err(_)) => (HostVerificationOutcome::TerminationFailed, None, false),
        Completion::Interrupted(forced_outcome) => {
            let terminated = terminate_and_confirm(
                &mut child,
                process_id,
                terminator,
                process_group.as_ref(),
                process_tracker.as_deref(),
            )
            .await;
            (
                if terminated {
                    forced_outcome
                } else {
                    HostVerificationOutcome::TerminationFailed
                },
                None,
                terminated,
            )
        }
    };

    let mut outcome = outcome;
    let mut group_empty_confirmed = false;
    let (stdout, stderr) = if exit_confirmed {
        match collect_stream_digests_with_timeout(stdout_task, stderr_task, STREAM_DRAIN_TIMEOUT)
            .await
        {
            Ok(digests) => {
                group_empty_confirmed = process_group.wait_empty(TERMINATION_CONFIRM_TIMEOUT).await;
                if !group_empty_confirmed {
                    group_empty_confirmed = unregister_after_confirmed_group_cleanup(
                        process_group.as_ref(),
                        process_tracker.as_deref(),
                        process_id,
                    )
                    .await;
                    if group_empty_confirmed {
                        process_registered = false;
                    }
                    outcome = HostVerificationOutcome::CaptureFailed;
                }
                digests
            }
            Err(_) => {
                group_empty_confirmed = unregister_after_confirmed_group_cleanup(
                    process_group.as_ref(),
                    process_tracker.as_deref(),
                    process_id,
                )
                .await;
                if group_empty_confirmed {
                    process_registered = false;
                }
                outcome = HostVerificationOutcome::CaptureFailed;
                (empty_digest(), empty_digest())
            }
        }
    } else {
        stdout_task.abort();
        stderr_task.abort();
        (empty_digest(), empty_digest())
    };
    if outcome == HostVerificationOutcome::Failed {
        outcome = classify_failed_process_output(&stdout.tail, &stderr.tail);
    }
    if process_registered && exit_confirmed && group_empty_confirmed {
        if let (Some(tracker), Some(process_id)) = (&process_tracker, process_id) {
            let _ = tracker.unregister_process(process_id);
        }
    } else if process_registered {
        let tracker = process_tracker.clone();
        let process_group = process_group.clone();
        tokio::spawn(async move {
            let _ = child.wait().await;
            if process_group.wait_empty(Duration::from_secs(30)).await {
                if let (Some(tracker), Some(process_id)) = (tracker, process_id) {
                    let _ = tracker.unregister_process(process_id);
                }
            }
        });
    }
    if let (Some(context), Ok(live)) = (&progress_context, live_output.lock()) {
        let mut terminal_progress = progress_snapshot(
            context,
            spec,
            working_dir,
            progress_started_at,
            process_id,
            &live,
            Some(
                if outcome == HostVerificationOutcome::PrerequisiteUnavailable {
                    TestExecutionPhase::WaitingForUser
                } else {
                    TestExecutionPhase::Completed
                },
            ),
            Some(test_execution_outcome(outcome)),
        );
        if outcome == HostVerificationOutcome::PrerequisiteUnavailable {
            terminal_progress.reason =
                Some(prerequisite_recovery_prompt(&stdout.tail, &stderr.tail));
        }
        context.sink.emit(terminal_progress);
    }
    receipt(outcome, exit_code, stdout, stderr)
}

fn test_execution_outcome(outcome: HostVerificationOutcome) -> TestExecutionOutcome {
    match outcome {
        HostVerificationOutcome::Passed => TestExecutionOutcome::Succeeded,
        HostVerificationOutcome::Failed => TestExecutionOutcome::VerificationFailed,
        HostVerificationOutcome::PrerequisiteUnavailable => {
            TestExecutionOutcome::PrerequisiteUnavailable
        }
        HostVerificationOutcome::Cancelled => TestExecutionOutcome::Cancelled,
        HostVerificationOutcome::LaunchFailed
        | HostVerificationOutcome::TimedOut
        | HostVerificationOutcome::TerminationFailed
        | HostVerificationOutcome::CaptureFailed => TestExecutionOutcome::InfrastructureFailed,
    }
}

async fn terminate_and_confirm(
    child: &mut tokio::process::Child,
    process_id: Option<u32>,
    terminator: &dyn ProcessTreeTerminator,
    process_group: &SystemProcessGroupOwner,
    process_tracker: Option<&dyn SessionProcessTracker>,
) -> bool {
    #[cfg(windows)]
    {
        let _ = process_group;
        let Some(process_id) = process_id else {
            return false;
        };
        match process_tracker.map(|tracker| tracker.terminate_process_owner(process_id)) {
            Some(Ok(true)) => {}
            Some(Err(_)) => return false,
            Some(Ok(false)) | None => {
                if terminator.terminate_tree(process_id).await.is_err() {
                    return child.try_wait().ok().flatten().is_some();
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = process_id;
        let _ = terminator;
        let _ = process_tracker;
        if process_group.terminate_group().is_err() {
            return child.try_wait().ok().flatten().is_some();
        }
    }

    matches!(
        tokio::time::timeout(TERMINATION_CONFIRM_TIMEOUT, child.wait()).await,
        Ok(Ok(_))
    )
}

async fn terminate_group_and_confirm(group: &dyn HostProcessGroupLifecycle) -> bool {
    group.terminate_group().is_ok() && group.wait_empty(TERMINATION_CONFIRM_TIMEOUT).await
}

async fn unregister_after_confirmed_group_cleanup(
    group: &dyn HostProcessGroupLifecycle,
    process_tracker: Option<&dyn SessionProcessTracker>,
    process_id: Option<u32>,
) -> bool {
    if !terminate_group_and_confirm(group).await {
        return false;
    }
    if let (Some(tracker), Some(process_id)) = (process_tracker, process_id) {
        tracker.unregister_process(process_id).is_ok()
    } else {
        true
    }
}

fn bounded_text(value: &str) -> String {
    value.chars().take(MAX_RECEIPT_TEXT).collect()
}

async fn project_python(working_dir: &std::path::Path, environment: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let relative = PathBuf::from(environment)
        .join("Scripts")
        .join("python.exe");
    #[cfg(not(windows))]
    let relative = PathBuf::from(environment).join("bin").join("python");

    let executable = working_dir.join(&relative);
    command_succeeds(&executable, &["--version"], working_dir)
        .await
        .then_some(executable)
}

async fn path_python(working_dir: &std::path::Path) -> Option<PathBuf> {
    #[cfg(windows)]
    const NAMES: &[&str] = &["python.exe", "python3.exe", "py.exe"];
    #[cfg(not(windows))]
    const NAMES: &[&str] = &["python3", "python"];

    for name in NAMES {
        let Ok(executable) = which::which(name) else {
            continue;
        };
        if command_succeeds(&executable, &["--version"], working_dir).await {
            return Some(executable);
        }
    }
    None
}

async fn path_uv(working_dir: &std::path::Path) -> Option<PathBuf> {
    let executable = which::which("uv").ok()?;
    command_succeeds(&executable, &["--version"], working_dir)
        .await
        .then_some(executable)
}

async fn command_succeeds(
    executable: &std::path::Path,
    args: &[&str],
    working_dir: &std::path::Path,
) -> bool {
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .set_no_window();

    matches!(
        tokio::time::timeout(RUNTIME_PROBE_TIMEOUT, command.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

fn shell_executable(shell: &str, executable: &std::path::Path) -> String {
    let shell = shell.to_ascii_lowercase();
    if shell.contains("powershell") || shell == "pwsh" {
        format!("& {}", shell_argument(&shell, executable))
    } else {
        shell_argument(&shell, executable)
    }
}

fn shell_argument(shell: &str, value: &std::path::Path) -> String {
    let value = value.to_string_lossy();
    let shell = shell.to_ascii_lowercase();
    if shell.contains("powershell") || shell == "pwsh" {
        format!("'{}'", value.replace('\'', "''"))
    } else if shell == "cmd" {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_host_repair_with_hooks, execute_host_repair_and_verify, HostVerificationOutcome,
        HostVerificationSpec, TesterPythonRuntime, TesterRuntimeProbe,
    };
    use crate::agents::task_dag::{
        HostRepairActionKindV1, HostRepairActionV1, HostVerificationContractV1,
        HostVerificationMatchModeV1, HOST_REPAIR_ACTION_SCHEMA_VERSION,
        HOST_VERIFICATION_CONTRACT_SCHEMA_VERSION,
    };
    use crate::session::SessionProcessTracker;
    use base64::Engine;
    use goose_sdk_types::custom_notifications::{
        TestExecutionOutcome, TestExecutionPhase, TestExecutionProgress,
        TEST_EXECUTION_PROGRESS_SCHEMA_VERSION,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn path(value: &str) -> Option<PathBuf> {
        Some(PathBuf::from(value))
    }

    fn exact_contract(path: &str, expected: &[u8]) -> HostVerificationContractV1 {
        HostVerificationContractV1 {
            schema_version: HOST_VERIFICATION_CONTRACT_SCHEMA_VERSION,
            match_mode: HostVerificationMatchModeV1::ExactBytes,
            artifact_relative_path: path.to_string(),
            expected_bytes_base64: base64::prelude::BASE64_STANDARD.encode(expected),
            expected_sha256: super::sha256_hex(expected),
        }
    }

    fn repair_action(
        path: &str,
        current: &[u8],
        action: HostRepairActionKindV1,
    ) -> HostRepairActionV1 {
        HostRepairActionV1 {
            schema_version: HOST_REPAIR_ACTION_SCHEMA_VERSION,
            artifact_relative_path: path.to_string(),
            action,
            precondition_sha256: Some(super::sha256_hex(current)),
        }
    }

    #[tokio::test]
    async fn host_atomic_repair_append_writes_and_retests_exact_bytes() {
        let workspace = tempfile::tempdir().unwrap();
        let current = b"generic payload\n";
        let expected = b"generic payload\n\n";
        std::fs::write(workspace.path().join("artifact.bin"), current).unwrap();
        let contract = exact_contract("artifact.bin", expected);
        let action = repair_action(
            "artifact.bin",
            current,
            HostRepairActionKindV1::AppendBytes {
                bytes_base64: base64::prelude::BASE64_STANDARD.encode(b"\n"),
            },
        );

        let receipt = execute_host_repair_and_verify(
            &action,
            &contract,
            workspace.path(),
            Duration::from_secs(5),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(receipt.outcome, HostVerificationOutcome::Passed);
        assert_eq!(receipt.exit_code, Some(0));
        assert_eq!(receipt.stdout_bytes, expected.len() as u64);
        assert_eq!(
            receipt.artifact_sha256.as_deref(),
            Some(contract.expected_sha256.as_str())
        );
        assert_eq!(
            std::fs::read(workspace.path().join("artifact.bin")).unwrap(),
            expected
        );
    }

    #[tokio::test]
    async fn host_atomic_repair_replace_exact_writes_only_the_declared_bytes() {
        let workspace = tempfile::tempdir().unwrap();
        let current = b"old bounded payload";
        let expected = b"new bounded payload\n";
        std::fs::write(workspace.path().join("artifact.bin"), current).unwrap();
        let contract = exact_contract("artifact.bin", expected);
        let action = repair_action(
            "artifact.bin",
            current,
            HostRepairActionKindV1::ReplaceExact {
                bytes_base64: contract.expected_bytes_base64.clone(),
            },
        );

        let receipt = execute_host_repair_and_verify(
            &action,
            &contract,
            workspace.path(),
            Duration::from_secs(5),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(receipt.outcome, HostVerificationOutcome::Passed);
        assert_eq!(
            std::fs::read(workspace.path().join("artifact.bin")).unwrap(),
            expected
        );
    }

    #[test]
    fn host_atomic_repair_publish_failure_preserves_the_original_file() {
        let workspace = tempfile::tempdir().unwrap();
        let current = b"original bytes";
        let expected = b"replacement bytes";
        let artifact = workspace.path().join("artifact.bin");
        std::fs::write(&artifact, current).unwrap();
        let contract = exact_contract("artifact.bin", expected);
        let action = repair_action(
            "artifact.bin",
            current,
            HostRepairActionKindV1::ReplaceExact {
                bytes_base64: contract.expected_bytes_base64.clone(),
            },
        );

        let error = apply_host_repair_with_hooks(
            &action,
            &contract,
            workspace.path(),
            &tokio_util::sync::CancellationToken::new(),
            |_| {},
            |_temporary, _destination| Err("injected atomic publish failure".to_string()),
        )
        .unwrap_err();

        assert!(error.contains("injected atomic publish failure"));
        assert_eq!(std::fs::read(artifact).unwrap(), current);
    }

    #[test]
    fn host_atomic_repair_cancellation_before_publish_preserves_the_original_file() {
        let workspace = tempfile::tempdir().unwrap();
        let current = b"original bytes";
        let expected = b"replacement bytes";
        let artifact = workspace.path().join("artifact.bin");
        std::fs::write(&artifact, current).unwrap();
        let contract = exact_contract("artifact.bin", expected);
        let action = repair_action(
            "artifact.bin",
            current,
            HostRepairActionKindV1::ReplaceExact {
                bytes_base64: contract.expected_bytes_base64.clone(),
            },
        );
        let cancellation_token = tokio_util::sync::CancellationToken::new();
        let worker_token = cancellation_token.clone();
        let staged = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let worker_staged = Arc::clone(&staged);
        let worker_release = Arc::clone(&release);
        let workspace_path = workspace.path().to_path_buf();

        let worker = std::thread::spawn(move || {
            apply_host_repair_with_hooks(
                &action,
                &contract,
                &workspace_path,
                &worker_token,
                move |_| {
                    worker_staged.wait();
                    worker_release.wait();
                },
                super::persist_host_repair,
            )
        });
        staged.wait();
        cancellation_token.cancel();
        release.wait();
        let error = worker.join().unwrap().unwrap_err();

        assert!(error.contains("cancelled before atomic publish"));
        assert_eq!(std::fs::read(artifact).unwrap(), current);
    }

    #[test]
    fn host_atomic_repair_rejects_a_concurrent_change_before_publish() {
        let workspace = tempfile::tempdir().unwrap();
        let current = b"original bytes";
        let concurrent = b"concurrent bytes";
        let expected = b"replacement bytes";
        let artifact = workspace.path().join("artifact.bin");
        std::fs::write(&artifact, current).unwrap();
        let contract = exact_contract("artifact.bin", expected);
        let action = repair_action(
            "artifact.bin",
            current,
            HostRepairActionKindV1::ReplaceExact {
                bytes_base64: contract.expected_bytes_base64.clone(),
            },
        );

        let error = apply_host_repair_with_hooks(
            &action,
            &contract,
            workspace.path(),
            &tokio_util::sync::CancellationToken::new(),
            |destination| std::fs::write(destination, concurrent).unwrap(),
            super::persist_host_repair,
        )
        .unwrap_err();

        assert!(error.contains("changed while"));
        assert_eq!(std::fs::read(artifact).unwrap(), concurrent);
    }

    #[test]
    fn host_atomic_repair_rejects_changed_sensitive_and_escaping_artifacts() {
        let workspace = tempfile::tempdir().unwrap();
        let current = b"current bytes";
        let expected = b"expected bytes";
        std::fs::write(workspace.path().join("artifact.bin"), b"changed bytes").unwrap();
        let contract = exact_contract("artifact.bin", expected);
        let action = repair_action(
            "artifact.bin",
            current,
            HostRepairActionKindV1::ReplaceExact {
                bytes_base64: contract.expected_bytes_base64.clone(),
            },
        );
        assert!(apply_host_repair_with_hooks(
            &action,
            &contract,
            workspace.path(),
            &tokio_util::sync::CancellationToken::new(),
            |_| {},
            |_temporary, _destination| Ok(())
        )
        .unwrap_err()
        .contains("changed after"));

        for unsafe_path in [".env", "../outside.bin"] {
            let unsafe_contract = exact_contract(unsafe_path, expected);
            let unsafe_action = repair_action(
                unsafe_path,
                current,
                HostRepairActionKindV1::ReplaceExact {
                    bytes_base64: unsafe_contract.expected_bytes_base64.clone(),
                },
            );
            assert!(apply_host_repair_with_hooks(
                &unsafe_action,
                &unsafe_contract,
                workspace.path(),
                &tokio_util::sync::CancellationToken::new(),
                |_| {},
                |_temporary, _destination| Ok(())
            )
            .is_err());
        }

        let oversized = vec![b'x'; super::MAX_EXPECTED_FILE_BYTES + 1];
        let oversized_contract = exact_contract("artifact.bin", &oversized);
        let oversized_action = repair_action(
            "artifact.bin",
            current,
            HostRepairActionKindV1::ReplaceExact {
                bytes_base64: oversized_contract.expected_bytes_base64.clone(),
            },
        );
        assert!(apply_host_repair_with_hooks(
            &oversized_action,
            &oversized_contract,
            workspace.path(),
            &tokio_util::sync::CancellationToken::new(),
            |_| {},
            |_temporary, _destination| Ok(())
        )
        .is_err());
    }

    #[derive(Default)]
    struct CountingTracker {
        registered: AtomicUsize,
        unregistered: AtomicUsize,
        last_process_id: AtomicU32,
        fail_owner_termination: std::sync::atomic::AtomicBool,
        owner_termination_calls: AtomicUsize,
        owners: std::sync::Mutex<
            std::collections::HashMap<u32, Arc<dyn crate::session::SessionProcessOwner>>,
        >,
    }

    impl crate::session::SessionProcessTracker for CountingTracker {
        fn register_process(&self, process_id: u32) -> Result<(), String> {
            self.registered.fetch_add(1, Ordering::SeqCst);
            self.last_process_id.store(process_id, Ordering::SeqCst);
            Ok(())
        }

        fn unregister_process(&self, _process_id: u32) -> Result<(), String> {
            self.unregistered.fetch_add(1, Ordering::SeqCst);
            self.owners
                .lock()
                .map_err(|_| "owner registry lock poisoned".to_string())?
                .remove(&_process_id);
            Ok(())
        }

        fn register_process_owner(
            &self,
            process_id: u32,
            owner: Arc<dyn crate::session::SessionProcessOwner>,
        ) -> Result<(), String> {
            self.register_process(process_id)?;
            self.owners
                .lock()
                .map_err(|_| "owner registry lock poisoned".to_string())?
                .insert(process_id, owner);
            Ok(())
        }

        fn terminate_process_owner(&self, process_id: u32) -> Result<bool, String> {
            self.owner_termination_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_owner_termination.load(Ordering::SeqCst) {
                return Err("synthetic owner termination failure".to_string());
            }
            let owner = self
                .owners
                .lock()
                .map_err(|_| "owner registry lock poisoned".to_string())?
                .get(&process_id)
                .cloned();
            let Some(owner) = owner else {
                return Ok(false);
            };
            owner.terminate()?;
            Ok(true)
        }
    }

    struct FakeProcessGroupLifecycle {
        terminate_succeeds: bool,
        empty: bool,
        terminate_calls: AtomicUsize,
        wait_calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl super::HostProcessGroupLifecycle for FakeProcessGroupLifecycle {
        fn terminate_group(&self) -> Result<(), String> {
            self.terminate_calls.fetch_add(1, Ordering::SeqCst);
            if self.terminate_succeeds {
                Ok(())
            } else {
                Err("synthetic group termination failure".to_string())
            }
        }

        async fn wait_empty(&self, _timeout: Duration) -> bool {
            self.wait_calls.fetch_add(1, Ordering::SeqCst);
            self.empty
        }
    }

    #[tokio::test]
    async fn capture_cleanup_termination_failure_keeps_process_registered() {
        let tracker = CountingTracker::default();
        tracker.register_process(41).unwrap();
        let group = FakeProcessGroupLifecycle {
            terminate_succeeds: false,
            empty: false,
            terminate_calls: AtomicUsize::new(0),
            wait_calls: AtomicUsize::new(0),
        };

        let confirmed =
            super::unregister_after_confirmed_group_cleanup(&group, Some(&tracker), Some(41)).await;

        assert!(!confirmed);
        assert_eq!(group.terminate_calls.load(Ordering::SeqCst), 1);
        assert_eq!(group.wait_calls.load(Ordering::SeqCst), 0);
        assert_eq!(tracker.unregistered.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn capture_cleanup_wait_timeout_keeps_process_registered() {
        let tracker = CountingTracker::default();
        tracker.register_process(42).unwrap();
        let group = FakeProcessGroupLifecycle {
            terminate_succeeds: true,
            empty: false,
            terminate_calls: AtomicUsize::new(0),
            wait_calls: AtomicUsize::new(0),
        };

        let confirmed =
            super::unregister_after_confirmed_group_cleanup(&group, Some(&tracker), Some(42)).await;

        assert!(!confirmed);
        assert_eq!(group.terminate_calls.load(Ordering::SeqCst), 1);
        assert_eq!(group.wait_calls.load(Ordering::SeqCst), 1);
        assert_eq!(tracker.unregistered.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn project_dot_venv_has_highest_priority() {
        let probe = TesterRuntimeProbe::from_candidates(
            "cmd",
            path(".venv/python"),
            path("venv/python"),
            path("C:/Python/python.exe"),
            path("C:/Tools/uv.exe"),
        );

        assert_eq!(
            probe.python,
            TesterPythonRuntime::ProjectDotVenv(PathBuf::from(".venv/python"))
        );
    }

    #[test]
    fn falls_back_in_documented_order() {
        let venv = TesterRuntimeProbe::from_candidates(
            "cmd",
            None,
            path("venv/python"),
            path("C:/Python/python.exe"),
            path("C:/Tools/uv.exe"),
        );
        let path_python = TesterRuntimeProbe::from_candidates(
            "cmd",
            None,
            None,
            path("C:/Python/python.exe"),
            path("C:/Tools/uv.exe"),
        );
        let uv =
            TesterRuntimeProbe::from_candidates("cmd", None, None, None, path("C:/Tools/uv.exe"));
        let unavailable = TesterRuntimeProbe::from_candidates("cmd", None, None, None, None);

        assert!(matches!(venv.python, TesterPythonRuntime::ProjectVenv(_)));
        assert!(matches!(
            path_python.python,
            TesterPythonRuntime::PathPython(_)
        ));
        assert!(matches!(uv.python, TesterPythonRuntime::UvRun(_)));
        assert_eq!(unavailable.python, TesterPythonRuntime::Unavailable);
    }

    #[test]
    fn instructions_pin_the_host_selected_runtime() {
        let probe = TesterRuntimeProbe::from_candidates(
            "cmd",
            None,
            None,
            path("C:/Program Files/Python/python.exe"),
            None,
        );

        let instructions = probe.instructions();

        assert!(instructions.contains("宿主运行时探测结果"));
        assert!(instructions.contains("\"C:/Program Files/Python/python.exe\""));
        assert!(instructions.contains("不得自行探测、搜索或改用其他 Python"));
    }

    #[test]
    fn unavailable_runtime_is_explicit_and_forbids_model_probing() {
        let probe = TesterRuntimeProbe::from_candidates("powershell", None, None, None, None);

        let instructions = probe.instructions();

        assert!(instructions.contains("环境不可用"));
        assert!(instructions.contains("不得为寻找 Python 执行诊断命令"));
    }

    #[test]
    fn python_script_command_uses_only_the_host_selected_shell_dialect() {
        let executable = PathBuf::from("C:/Program Files/Python/python.exe");
        let script = std::path::Path::new("tests/my smoke_test.py");

        let cmd = TesterRuntimeProbe::path_python_for_test("cmd", executable.clone());
        let powershell = TesterRuntimeProbe::path_python_for_test("powershell", executable.clone());
        let posix = TesterRuntimeProbe::path_python_for_test("bash", executable);

        assert_eq!(
            cmd.python_script_command(script).as_deref(),
            Some("\"C:/Program Files/Python/python.exe\" \"tests/my smoke_test.py\"")
        );
        assert_eq!(
            powershell.python_script_command(script).as_deref(),
            Some("& 'C:/Program Files/Python/python.exe' 'tests/my smoke_test.py'")
        );
        assert_eq!(
            posix.python_script_command(script).as_deref(),
            Some("'C:/Program Files/Python/python.exe' 'tests/my smoke_test.py'")
        );
    }

    #[test]
    fn uv_script_command_and_unavailable_runtime_are_explicit() {
        let uv = TesterRuntimeProbe::from_candidates(
            "powershell",
            None,
            None,
            None,
            path("C:/Program Files/uv/uv.exe"),
        );
        let unavailable = TesterRuntimeProbe::unavailable_for_test("cmd");
        let script = std::path::Path::new("tests/_import_test.py");

        assert_eq!(
            uv.python_script_command(script).as_deref(),
            Some("& 'C:/Program Files/uv/uv.exe' run python 'tests/_import_test.py'")
        );
        assert_eq!(unavailable.python_script_command(script), None);
    }

    #[test]
    fn host_verification_specs_are_fixed_argv_and_unknown_commands_fail_closed() {
        let probe = TesterRuntimeProbe::path_python_for_test(
            "cmd",
            PathBuf::from(if cfg!(windows) {
                "C:/Program Files/Python/python.exe"
            } else {
                "/opt/Project Python/bin/python3"
            }),
        );
        let python = probe
            .host_verification_spec("python -m pytest tests/widget_test.py -q")
            .expect("supported Python test");
        assert_eq!(
            python.executable(),
            std::path::Path::new(if cfg!(windows) {
                "C:/Program Files/Python/python.exe"
            } else {
                "/opt/Project Python/bin/python3"
            })
        );
        assert_eq!(
            python.argv(),
            ["-m", "pytest", "tests/widget_test.py", "-q"]
        );

        let cargo = probe
            .host_verification_spec(r#"cargo test "& | ; > $()""#)
            .expect("metacharacters remain one argv value");
        assert!(cargo.executable().is_absolute());
        assert_eq!(cargo.argv()[1], "& | ; > $()");

        assert!(probe.host_verification_spec("./tools/cargo test").is_err());
        assert!(probe
            .host_verification_spec("C:\\tools\\cargo.exe test")
            .is_err());
        #[cfg(windows)]
        {
            let npm = probe
                .host_verification_spec("npm test")
                .expect("bare npm uses the trusted Node npm CLI on Windows");
            assert_eq!(
                npm.executable()
                    .extension()
                    .and_then(|value| value.to_str()),
                Some("exe")
            );
            assert!(npm.argv()[0]
                .replace('\\', "/")
                .ends_with("/node_modules/npm/bin/npm-cli.js"));
            assert_eq!(npm.argv()[1], "test");
        }
        assert!(probe.host_verification_spec("npm.cmd test").is_err());
        assert!(probe.host_verification_spec("pnpm.cmd test").is_err());
        assert!(probe.host_verification_spec("yarn.cmd test").is_err());

        assert!(probe
            .host_verification_spec("powershell -Command Remove-Item outside.txt")
            .is_err());
        assert!(probe
            .host_verification_spec("unknown-test-runner --all")
            .is_err());
    }

    #[test]
    fn host_selected_python_test_script_is_a_bounded_workspace_verification() {
        let workspace = tempfile::tempdir().unwrap();
        let script = workspace.path().join("_import_test.py");
        std::fs::write(&script, "print('ok')\n").unwrap();
        let selected_python = PathBuf::from(if cfg!(windows) {
            "C:/Program Files/Python/python.exe"
        } else {
            "/opt/Project Python/bin/python3"
        });
        let probe = TesterRuntimeProbe::path_python_for_test("cmd", selected_python.clone());

        let spec = HostVerificationSpec::from_command_in_workspace(
            &format!(r#""{}" "_import_test.py""#, selected_python.display()),
            Some(&probe),
            workspace.path(),
        )
        .expect("an existing workspace test script should be host-verifiable");

        assert_eq!(spec.executable(), selected_python);
        assert_eq!(spec.argv(), &["_import_test.py"]);

        std::fs::write(workspace.path().join("app.py"), "print('app')\n").unwrap();
        assert!(HostVerificationSpec::from_command_in_workspace(
            &format!(r#""{}" app.py"#, selected_python.display()),
            Some(&probe),
            workspace.path(),
        )
        .is_err());
        assert!(HostVerificationSpec::from_command_in_workspace(
            &format!(r#""{}" ../outside_test.py"#, selected_python.display()),
            Some(&probe),
            workspace.path(),
        )
        .is_err());
    }

    #[tokio::test]
    async fn host_selected_python_test_script_executes_through_the_real_host_entry() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("_import_test.py"),
            "print('IMPORT_TEST_OK')\n",
        )
        .unwrap();
        let python = which::which(if cfg!(windows) {
            "python.exe"
        } else {
            "python3"
        })
        .expect("test requires host Python");
        let runtime = TesterRuntimeProbe::path_python_for_test(
            crate::agents::platform_extensions::developer::shell::shell_display_name(),
            python,
        );
        let command = runtime
            .python_script_command(std::path::Path::new("_import_test.py"))
            .expect("host Python command");
        let spec = HostVerificationSpec::from_command_in_workspace(
            &command,
            Some(&runtime),
            workspace.path(),
        )
        .expect("host-selected test script spec");

        let receipt = super::execute_host_verification(
            &spec,
            workspace.path(),
            Duration::from_secs(10),
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::Passed);
        assert_eq!(receipt.exit_code, Some(0));
        assert!(receipt.stdout_bytes > 0);
    }

    #[test]
    fn host_selected_python_accepts_safe_quality_checks_and_rejects_mutating_shapes() {
        let selected_python = PathBuf::from(if cfg!(windows) {
            "C:/Program Files/Python/python.exe"
        } else {
            "/opt/Project Python/bin/python3"
        });
        let probe = TesterRuntimeProbe::path_python_for_test("cmd", selected_python.clone());

        for command in [
            &format!(
                r#""{}" -m ruff check . --no-cache"#,
                selected_python.display()
            ),
            &format!(r#""{}" -m mypy src"#, selected_python.display()),
            &format!(
                r#""{}" -m compileall -q src tests"#,
                selected_python.display()
            ),
            &format!(r#""{}" -m pip check"#, selected_python.display()),
        ] {
            let spec = probe
                .host_verification_spec(command)
                .unwrap_or_else(|error| {
                    panic!("safe quality check was rejected: {command}: {error}")
                });
            assert_eq!(spec.executable(), selected_python);
        }

        for command in [
            &format!(r#""{}" -m ruff check . --fix"#, selected_python.display()),
            &format!(
                r#""{}" -m mypy src --cache-dir C:/outside"#,
                selected_python.display()
            ),
            &format!(
                r#""{}" -m compileall -q ../outside"#,
                selected_python.display()
            ),
            &format!(r#""{}" -m pip install example"#, selected_python.display()),
            &format!(r#""{}" -c "print('unsafe')""#, selected_python.display()),
        ] {
            assert!(
                probe.host_verification_spec(command).is_err(),
                "mutating or unbounded Python command was accepted: {command}"
            );
        }
    }

    #[test]
    fn durable_node_test_replay_preserves_the_selected_executable_and_arguments() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("test")).unwrap();
        std::fs::write(
            workspace.path().join("test/channel.test.cjs"),
            "require('node:test')('channel', () => {});\n",
        )
        .unwrap();
        let original = HostVerificationSpec::from_command_in_workspace(
            "node --test test/channel.test.cjs",
            None,
            workspace.path(),
        )
        .unwrap();
        let replayed = HostVerificationSpec::from_durable_direct_command_in_workspace(
            &original.command_display(),
            None,
            workspace.path(),
        )
        .expect("the host's own quoted absolute Node receipt must be replayable");
        assert_eq!(replayed, original);
        assert_eq!(replayed.argv(), ["--test", "test/channel.test.cjs"]);
        assert_eq!(
            shell_words::split(&replayed.command_display()).unwrap()[0],
            original.executable().to_string_lossy()
        );
        #[cfg(windows)]
        assert!(original.executable().to_string_lossy().starts_with(r"\\?\"));

        for suffix in [
            " && echo unsafe",
            " ; echo unsafe",
            " --require app.cjs",
            " ../outside.test.cjs",
        ] {
            assert!(
                HostVerificationSpec::from_durable_direct_command_in_workspace(
                    &format!("{}{suffix}", original.command_display()),
                    None,
                    workspace.path(),
                )
                .is_err(),
                "an appended operation or outside target must not be replayed"
            );
        }

        let fake_node = workspace
            .path()
            .join(original.executable().file_name().unwrap());
        std::fs::write(&fake_node, "not the selected runtime").unwrap();
        let fake_command = shell_words::join(
            std::iter::once(fake_node.to_string_lossy().into_owned())
                .chain(original.argv().iter().cloned()),
        );
        assert!(
            HostVerificationSpec::from_durable_direct_command_in_workspace(
                &fake_command,
                None,
                workspace.path(),
            )
            .is_err()
        );
        assert!(
            HostVerificationSpec::from_command_in_workspace(
                &original.command_display(),
                None,
                workspace.path(),
            )
            .is_err(),
            "ordinary input must not gain the durable receipt exception"
        );
    }

    #[test]
    fn durable_node_test_replay_rejects_changed_path_selection() {
        const INPUT: &str = "CODEPRO_DURABLE_NODE_REPLAY_TEST_COMMAND";
        if let Ok(input) = std::env::var(INPUT) {
            let (command, workspace): (String, PathBuf) = serde_json::from_str(&input).unwrap();
            assert!(
                HostVerificationSpec::from_durable_direct_command_in_workspace(
                    &command, None, &workspace,
                )
                .is_err()
            );
            return;
        }

        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("tests.cjs"), "process.exit(0);\n").unwrap();
        let original = HostVerificationSpec::from_command("node --test tests.cjs", None).unwrap();
        let replacement = tempfile::tempdir().unwrap();
        std::fs::write(
            replacement
                .path()
                .join(original.executable().file_name().unwrap()),
            "unselected runtime; this file must never execute",
        )
        .unwrap();
        let mut search_path = vec![replacement.path().to_path_buf()];
        search_path.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agents::tester_runtime::tests::durable_node_test_replay_rejects_changed_path_selection",
                "--nocapture",
            ])
            .env("PATH", std::env::join_paths(search_path).unwrap())
            .env(INPUT, serde_json::to_string(&(original.command_display(), workspace.path())).unwrap())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[cfg(windows)]
    #[test]
    fn durable_python_replay_accepts_only_the_same_windows_path_identity() {
        let selected = PathBuf::from(r"\\?\D:\test\.venv\Scripts\python.exe");
        let probe = TesterRuntimeProbe::path_python_for_test("cmd", selected.clone());

        let replayed = probe
            .host_verification_spec(r#""D:\test\.venv\Scripts\python.exe" -m pip check"#)
            .expect("ordinary and verbatim forms of the selected Python must match");
        assert_eq!(replayed.executable(), selected);

        assert!(probe
            .host_verification_spec(r#""D:\other\.venv\Scripts\python.exe" -m pip check"#)
            .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn durable_python_script_replay_accepts_legacy_unquoted_windows_path() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("test_api.py"), "print('ok')\n").unwrap();
        let selected = workspace
            .path()
            .join(".venv")
            .join("Scripts")
            .join("python.exe");
        let probe = TesterRuntimeProbe::path_python_for_test("cmd", selected.clone());
        let legacy_command = format!(r"{} test_api.py", selected.display());

        let replayed = HostVerificationSpec::from_durable_direct_command_in_workspace(
            &legacy_command,
            Some(&probe),
            workspace.path(),
        )
        .expect("legacy direct receipts must preserve a selected Windows Python path");

        assert_eq!(replayed.executable(), selected);
        assert_eq!(replayed.argv(), ["test_api.py"]);
        assert_eq!(
            shell_words::split(&replayed.command_display()).unwrap(),
            vec![
                replayed.executable().to_string_lossy().into_owned(),
                "test_api.py".to_string()
            ]
        );
    }

    #[test]
    fn connection_refused_output_is_a_missing_prerequisite_not_a_test_assertion_failure() {
        assert_eq!(
            super::classify_failed_process_output(
                "FAIL: api request",
                "urllib.error.URLError: <urlopen error [WinError 10061] No connection could be made>"
            ),
            HostVerificationOutcome::PrerequisiteUnavailable
        );
        assert_eq!(
            super::classify_failed_process_output("assertion failed", "expected 2, got 3"),
            HostVerificationOutcome::Failed
        );
    }

    #[test]
    fn missing_runtime_prompt_names_the_runtime_and_requests_install_permission() {
        let stderr = "'python' is not recognized as an internal or external command";

        assert_eq!(
            super::classify_failed_process_output("", stderr),
            HostVerificationOutcome::PrerequisiteUnavailable
        );
        let prompt = super::prerequisite_recovery_prompt("", stderr);
        assert!(prompt.contains("Python 3"), "{prompt}");
        assert!(prompt.contains("python.exe"), "{prompt}");
        assert!(prompt.contains("是否允许安装"), "{prompt}");
        assert!(prompt.contains("同一测试命令"), "{prompt}");
    }

    #[test]
    fn missing_dependency_prompt_names_the_package_and_preserves_resume_semantics() {
        let stderr = "ModuleNotFoundError: No module named 'pytest'";

        assert_eq!(
            super::classify_failed_process_output("", stderr),
            HostVerificationOutcome::PrerequisiteUnavailable
        );
        let prompt = super::prerequisite_recovery_prompt("", stderr);
        assert!(prompt.contains("pytest"), "{prompt}");
        assert!(prompt.contains("安装命令"), "{prompt}");
        assert!(prompt.contains("当前检查点"), "{prompt}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn real_python_connection_refusal_waits_for_the_missing_prerequisite() {
        let workspace = tempfile::tempdir().unwrap();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let published = observed.clone();
        let sink = super::TestExecutionProgressSink::new(
            workspace.path().join("progress.jsonl"),
            move |progress| published.lock().unwrap().push(progress),
        );
        let progress_context = super::TestExecutionProgressContext {
            session_id: "session-prerequisite".to_string(),
            run_id: "run-prerequisite".to_string(),
            task_id: "tester-prerequisite".to_string(),
            attempt_id: "tester-prerequisite:1".to_string(),
            manifest_path: None,
            retry_attempt: 0,
            repair_attempt: 0,
            initial_phase: TestExecutionPhase::RunningTests,
            sink,
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        std::fs::write(
            workspace.path().join("test_api.py"),
            format!(
                "import urllib.request\nurllib.request.urlopen('http://127.0.0.1:{port}', timeout=1)\n"
            ),
        )
        .unwrap();
        let python = which::which("python.exe").expect("test requires host Python");
        let runtime = TesterRuntimeProbe::path_python_for_test("cmd", python);
        let spec = HostVerificationSpec::from_command_in_workspace(
            "python test_api.py",
            Some(&runtime),
            workspace.path(),
        )
        .expect("bounded Python test script");

        let receipt = super::execute_host_verification_observed(
            &spec,
            workspace.path(),
            Duration::from_secs(5),
            tokio_util::sync::CancellationToken::new(),
            None,
            Some(progress_context),
        )
        .await;

        assert_eq!(
            receipt.outcome,
            HostVerificationOutcome::PrerequisiteUnavailable
        );
        assert_eq!(receipt.exit_code, Some(1));
        let progress = observed.lock().unwrap();
        let terminal = progress.last().expect("terminal progress");
        assert_eq!(terminal.phase, TestExecutionPhase::WaitingForUser);
        assert_eq!(
            terminal.outcome,
            Some(TestExecutionOutcome::PrerequisiteUnavailable)
        );
        let reason = terminal.reason.as_deref().expect("actionable wait reason");
        assert!(reason.contains("启动命令"), "{reason}");
        assert!(reason.contains("同一测试命令"), "{reason}");
    }

    #[cfg(windows)]
    #[test]
    fn workspace_node_test_script_is_direct_and_cannot_escape_or_execute_code_strings() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("tests.js"), "process.exit(0);\n").unwrap();
        std::fs::write(workspace.path().join("app.js"), "process.exit(0);\n").unwrap();

        let spec = HostVerificationSpec::from_command_in_workspace(
            "node tests.js",
            None,
            workspace.path(),
        )
        .expect("an existing workspace test script is a bounded direct Node verification");
        assert_eq!(
            spec.executable()
                .file_name()
                .and_then(|value| value.to_str()),
            Some("node.exe")
        );
        assert_eq!(spec.argv(), ["tests.js"]);

        for unsafe_command in [
            "node -e process.exit(0)",
            "node ../tests.js",
            "node app.js",
            "node tests.js --eval process.exit(0)",
        ] {
            assert!(
                HostVerificationSpec::from_command_in_workspace(
                    unsafe_command,
                    None,
                    workspace.path(),
                )
                .is_err(),
                "unsafe Node verification must fail closed: {unsafe_command}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn npm_test_uses_a_shell_free_allowlisted_package_script_when_available() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("package.json"),
            r#"{"scripts":{"test":"node --test"}}"#,
        )
        .unwrap();

        let spec =
            HostVerificationSpec::from_command_in_workspace("npm test", None, workspace.path())
                .expect("the package test script is itself a supported fixed command");

        assert_eq!(
            spec.executable()
                .file_name()
                .and_then(|value| value.to_str()),
            Some("node.exe")
        );
        assert_eq!(spec.argv(), ["--test"]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn npm_cli_executes_with_an_ordinary_windows_script_path() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("package.json"),
            r#"{"scripts":{"test":"echo npm-cli-ok"}}"#,
        )
        .unwrap();

        let spec =
            HostVerificationSpec::from_command_in_workspace("npm test", None, workspace.path())
                .expect("npm test must resolve to the trusted npm CLI");

        assert!(!spec.argv()[0].starts_with(r"\\?\"));
        let receipt = super::execute_host_verification(
            &spec,
            workspace.path(),
            Duration::from_secs(10),
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await;
        assert_eq!(receipt.outcome, HostVerificationOutcome::Passed);
        assert_eq!(receipt.exit_code, Some(0));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_verification_executes_without_a_shell_and_returns_a_hashed_receipt() {
        let workspace = tempfile::tempdir().unwrap();
        let sentinel = workspace.path().join("must-not-exist.txt");
        let spec = HostVerificationSpec::for_test(
            PathBuf::from("where.exe"),
            vec![format!("& echo escaped > {}", sentinel.display())],
        );

        let tracker = Arc::new(CountingTracker::default());
        let receipt = super::execute_host_verification(
            &spec,
            workspace.path(),
            Duration::from_secs(5),
            tokio_util::sync::CancellationToken::new(),
            Some(tracker.clone()),
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::Failed);
        assert!(!sentinel.exists());
        assert_eq!(receipt.stdout_blake3.len(), 64);
        assert_eq!(receipt.stderr_blake3.len(), 64);
        assert!(receipt.observed_summary().len() <= 1_024);
        assert_eq!(tracker.registered.load(Ordering::SeqCst), 1);
        assert_eq!(tracker.unregistered.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn host_verification_distinguishes_launch_failure_from_test_failure() {
        let workspace = tempfile::tempdir().unwrap();
        let missing = workspace
            .path()
            .join("definitely-missing-codepro-test-command.exe");
        let spec = HostVerificationSpec::for_test(missing, Vec::new());

        let receipt = super::execute_host_verification(
            &spec,
            workspace.path(),
            Duration::from_secs(5),
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::LaunchFailed);
        assert_eq!(receipt.exit_code, None);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_verification_timeout_and_cancel_each_converge_once() {
        let workspace = tempfile::tempdir().unwrap();
        let slow = HostVerificationSpec::for_test(
            PathBuf::from("ping.exe"),
            vec!["127.0.0.1".to_string(), "-n".to_string(), "30".to_string()],
        );
        let timed_out = super::execute_host_verification(
            &slow,
            workspace.path(),
            Duration::from_millis(30),
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await;
        assert_eq!(timed_out.outcome, HostVerificationOutcome::TimedOut);

        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        let cancelled = super::execute_host_verification(
            &slow,
            workspace.path(),
            Duration::from_secs(5),
            cancellation,
            None,
        )
        .await;
        assert_eq!(cancelled.outcome, HostVerificationOutcome::Cancelled);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_verification_uses_registered_owner_before_raw_pid_fallback() {
        use crate::agents::workers::{ProcessTreeError, ProcessTreeStop, ProcessTreeTerminator};

        struct FailingTerminator(AtomicUsize);

        #[async_trait::async_trait]
        impl ProcessTreeTerminator for FailingTerminator {
            async fn terminate_tree(
                &self,
                process_id: u32,
            ) -> Result<ProcessTreeStop, ProcessTreeError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(ProcessTreeError::StillRunning(process_id))
            }
        }

        let workspace = tempfile::tempdir().unwrap();
        let slow = HostVerificationSpec::for_test(
            PathBuf::from("ping.exe"),
            vec!["127.0.0.1".to_string(), "-n".to_string(), "30".to_string()],
        );
        let tracker = Arc::new(CountingTracker::default());
        let fallback = FailingTerminator(AtomicUsize::new(0));

        let receipt = super::execute_host_verification_with_terminator(
            &slow,
            workspace.path(),
            Duration::from_millis(30),
            tokio_util::sync::CancellationToken::new(),
            Some(tracker.clone()),
            &fallback,
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::TimedOut);
        assert_eq!(tracker.registered.load(Ordering::SeqCst), 1);
        assert_eq!(tracker.owner_termination_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fallback.0.load(Ordering::SeqCst), 0);
        assert_eq!(tracker.unregistered.load(Ordering::SeqCst), 1);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_verification_owner_error_never_falls_back_to_raw_pid() {
        use crate::agents::workers::{ProcessTreeStop, ProcessTreeTerminator};

        struct SuccessfulRawPidTerminator(AtomicUsize);

        #[async_trait::async_trait]
        impl ProcessTreeTerminator for SuccessfulRawPidTerminator {
            async fn terminate_tree(
                &self,
                process_id: u32,
            ) -> Result<ProcessTreeStop, crate::agents::workers::ProcessTreeError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                crate::agents::workers::SystemProcessTreeTerminator
                    .terminate_tree(process_id)
                    .await
            }
        }

        let workspace = tempfile::tempdir().unwrap();
        let slow = HostVerificationSpec::for_test(
            PathBuf::from("ping.exe"),
            vec!["127.0.0.1".to_string(), "-n".to_string(), "30".to_string()],
        );
        let tracker = Arc::new(CountingTracker::default());
        tracker.fail_owner_termination.store(true, Ordering::SeqCst);
        let raw_pid = SuccessfulRawPidTerminator(AtomicUsize::new(0));

        let receipt = super::execute_host_verification_with_terminator(
            &slow,
            workspace.path(),
            Duration::from_millis(30),
            tokio_util::sync::CancellationToken::new(),
            Some(tracker.clone()),
            &raw_pid,
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::TerminationFailed);
        assert_eq!(raw_pid.0.load(Ordering::SeqCst), 0);
        assert_eq!(tracker.unregistered.load(Ordering::SeqCst), 0);

        tracker
            .fail_owner_termination
            .store(false, Ordering::SeqCst);
        assert!(tracker
            .terminate_process_owner(tracker.last_process_id.load(Ordering::SeqCst))
            .unwrap());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_verification_late_natural_exit_clears_the_original_tracked_pid() {
        use crate::agents::workers::{ProcessTreeError, ProcessTreeStop, ProcessTreeTerminator};

        struct FailingTerminator;

        #[async_trait::async_trait]
        impl ProcessTreeTerminator for FailingTerminator {
            async fn terminate_tree(
                &self,
                process_id: u32,
            ) -> Result<ProcessTreeStop, ProcessTreeError> {
                Err(ProcessTreeError::StillRunning(process_id))
            }
        }

        let workspace = tempfile::tempdir().unwrap();
        let short_lived = HostVerificationSpec::for_test(
            PathBuf::from("ping.exe"),
            vec!["127.0.0.1".to_string(), "-n".to_string(), "2".to_string()],
        );
        let tracker = Arc::new(CountingTracker::default());
        tracker.fail_owner_termination.store(true, Ordering::SeqCst);
        let receipt = super::execute_host_verification_with_terminator(
            &short_lived,
            workspace.path(),
            Duration::from_millis(30),
            tokio_util::sync::CancellationToken::new(),
            Some(tracker.clone()),
            &FailingTerminator,
        )
        .await;
        assert_eq!(receipt.outcome, HostVerificationOutcome::TerminationFailed);
        assert_eq!(tracker.unregistered.load(Ordering::SeqCst), 0);

        tokio::time::timeout(Duration::from_secs(3), async {
            while tracker.unregistered.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("late natural exit must clear the tracked PID");
        assert_eq!(tracker.unregistered.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn host_verification_large_output_is_streamed_into_a_complete_hash() {
        use tokio::io::AsyncWriteExt;

        let payload = vec![b'x'; 4 * 1024 * 1024 + 37];
        let expected_hash = blake3::hash(&payload).to_hex().to_string();
        let (mut writer, reader) = tokio::io::duplex(8 * 1024);
        let writer_payload = payload.clone();
        let writer_task = tokio::spawn(async move {
            writer.write_all(&writer_payload).await.unwrap();
            writer.shutdown().await.unwrap();
        });

        let digest = super::drain_and_hash(reader).await.unwrap();
        writer_task.await.unwrap();

        assert_eq!(digest.bytes_seen, payload.len() as u64);
        assert_eq!(digest.blake3, expected_hash);
        assert!(digest.peak_buffer_bytes <= 8 * 1024);
    }

    #[tokio::test]
    async fn host_verification_pipe_drain_has_a_separate_deadline() {
        let (_writer, reader) = tokio::io::duplex(8 * 1024);
        let reader_task = tokio::spawn(super::drain_and_hash(reader));
        let empty_task = tokio::spawn(super::drain_and_hash(tokio::io::empty()));

        let result = super::collect_stream_digests_with_timeout(
            reader_task,
            empty_task,
            Duration::from_millis(10),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn host_verification_reader_failure_cannot_become_a_passed_receipt() {
        let failed_task =
            tokio::spawn(async { Err(std::io::Error::other("synthetic reader failure")) });
        let empty_task = tokio::spawn(super::drain_and_hash(tokio::io::empty()));

        let result = super::collect_stream_digests_with_timeout(
            failed_task,
            empty_task,
            Duration::from_secs(1),
        )
        .await;

        assert!(result.is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_verification_registration_failure_leaves_no_untracked_process() {
        struct RejectingTracker;

        impl crate::session::SessionProcessTracker for RejectingTracker {
            fn register_process(&self, _process_id: u32) -> Result<(), String> {
                Err("synthetic registration failure".to_string())
            }

            fn unregister_process(&self, _process_id: u32) -> Result<(), String> {
                panic!("an unregistered process must not be unregistered")
            }
        }

        struct FailingTerminator;

        #[async_trait::async_trait]
        impl crate::agents::workers::ProcessTreeTerminator for FailingTerminator {
            async fn terminate_tree(
                &self,
                process_id: u32,
            ) -> Result<
                crate::agents::workers::ProcessTreeStop,
                crate::agents::workers::ProcessTreeError,
            > {
                Err(crate::agents::workers::ProcessTreeError::StillRunning(
                    process_id,
                ))
            }
        }

        let workspace = tempfile::tempdir().unwrap();
        let slow = HostVerificationSpec::for_test(
            PathBuf::from("ping.exe"),
            vec!["127.0.0.1".to_string(), "-n".to_string(), "30".to_string()],
        );
        let receipt = super::execute_host_verification_with_terminator(
            &slow,
            workspace.path(),
            Duration::from_secs(5),
            tokio_util::sync::CancellationToken::new(),
            Some(Arc::new(RejectingTracker)),
            &FailingTerminator,
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::TerminationFailed);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_verification_registration_failure_never_resumes_a_descendant_capable_parent() {
        struct RejectingTracker;

        impl crate::session::SessionProcessTracker for RejectingTracker {
            fn register_process(&self, _process_id: u32) -> Result<(), String> {
                Err("synthetic registration failure".to_string())
            }

            fn unregister_process(&self, _process_id: u32) -> Result<(), String> {
                panic!("registration never succeeded")
            }
        }

        let workspace = tempfile::tempdir().unwrap();
        let sentinel = workspace.path().join("registration-escape.txt");
        let python = which::which("python.exe").expect("test requires host Python");
        let descendant = format!(
            "import pathlib;pathlib.Path({:?}).write_text('escaped')",
            sentinel.to_string_lossy()
        );
        let parent = format!(
            "import subprocess,sys;subprocess.Popen([sys.executable,'-c',{:?}])",
            descendant
        );
        let spec = HostVerificationSpec::for_test(python, vec!["-c".to_string(), parent]);

        let receipt = super::execute_host_verification(
            &spec,
            workspace.path(),
            Duration::from_secs(5),
            tokio_util::sync::CancellationToken::new(),
            Some(Arc::new(RejectingTracker)),
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::TerminationFailed);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !sentinel.exists(),
            "the suspended parent was resumed before registration"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_verification_kills_pipe_inheriting_descendants_after_parent_exit() {
        let workspace = tempfile::tempdir().unwrap();
        let sentinel = workspace.path().join("descendant-must-not-write.txt");
        let python = which::which("python.exe").expect("test requires host Python");
        let descendant = format!(
            "import time,pathlib;time.sleep(7);pathlib.Path({:?}).write_text('escaped')",
            sentinel.to_string_lossy()
        );
        let parent = format!(
            "import subprocess,sys;subprocess.Popen([sys.executable,'-c',{:?}])",
            descendant
        );
        let spec = HostVerificationSpec::for_test(python, vec!["-c".to_string(), parent]);
        let tracker = Arc::new(CountingTracker::default());

        let receipt = super::execute_host_verification(
            &spec,
            workspace.path(),
            Duration::from_secs(10),
            tokio_util::sync::CancellationToken::new(),
            Some(tracker.clone()),
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::CaptureFailed);
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(
            !sentinel.exists(),
            "the descendant escaped lifecycle ownership"
        );
        assert_eq!(tracker.registered.load(Ordering::SeqCst), 1);
        assert_eq!(tracker.unregistered.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cargo_output_updates_lock_compile_and_test_progress_without_string_status_guessing() {
        let mut live = super::LiveTestOutput::new(TestExecutionPhase::ResolvingDependencies);
        live.observe(
            super::TestOutputStream::Stderr,
            b"Blocking waiting for file lock on build directory\n",
        );
        assert_eq!(live.phase, TestExecutionPhase::WaitingForCargoLock);
        live.observe(super::TestOutputStream::Stderr, b"Compiling goose v1.0.0\n");
        assert_eq!(live.phase, TestExecutionPhase::Compiling);
        assert_eq!(live.current_crate.as_deref(), Some("goose"));
        live.observe(
            super::TestOutputStream::Stdout,
            b"running 2 tests\ntest first_case ... ok\n",
        );
        assert_eq!(live.phase, TestExecutionPhase::RunningTests);
        assert_eq!(live.total, Some(2));
        assert_eq!(live.completed, 1);
        assert_eq!(live.current_test.as_deref(), Some("first_case"));
    }

    #[test]
    fn progress_sink_persists_append_only_jsonl_before_publishing() {
        let directory = tempfile::tempdir().unwrap();
        let log_path = directory.path().join("test-progress.jsonl");
        let published = Arc::new(Mutex::new(Vec::new()));
        let observed = published.clone();
        let sink = super::TestExecutionProgressSink::new(log_path.clone(), move |progress| {
            observed.lock().unwrap().push(progress);
        });
        let progress = TestExecutionProgress {
            schema_version: TEST_EXECUTION_PROGRESS_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            task_id: "tester-1".to_string(),
            attempt_id: "tester-1:1".to_string(),
            phase: TestExecutionPhase::Compiling,
            outcome: None,
            command: "cargo test --jobs 1".to_string(),
            cwd: directory.path().to_string_lossy().into_owned(),
            manifest_path: None,
            elapsed_ms: 1,
            current_crate: Some("goose".to_string()),
            current_test: None,
            completed: None,
            total: None,
            pid: Some(42),
            last_output_at: None,
            heartbeat_at: chrono::Utc::now().to_rfc3339(),
            stdout_tail_ref: None,
            stderr_tail_ref: None,
            last_output: None,
            retry_attempt: 0,
            repair_attempt: 0,
            can_cancel: true,
            required_path: None,
            required_permission: None,
            reason: None,
        };

        sink.emit(progress.clone());

        let lines = std::fs::read_to_string(log_path).unwrap();
        let stored: TestExecutionProgress = serde_json::from_str(lines.trim()).unwrap();
        assert_eq!(stored, progress);
        assert_eq!(published.lock().unwrap().as_slice(), &[progress]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn observed_host_verification_emits_heartbeats_and_cancelled_terminal_state() {
        let workspace = tempfile::tempdir().unwrap();
        let log_path = workspace.path().join("progress.jsonl");
        let observed = Arc::new(Mutex::new(Vec::new()));
        let published = observed.clone();
        let sink = super::TestExecutionProgressSink::new(log_path, move |progress| {
            published.lock().unwrap().push(progress);
        });
        let context = super::TestExecutionProgressContext {
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            task_id: "tester-1".to_string(),
            attempt_id: "tester-1:1".to_string(),
            manifest_path: None,
            retry_attempt: 0,
            repair_attempt: 0,
            initial_phase: TestExecutionPhase::Compiling,
            sink,
        };
        let spec = HostVerificationSpec::for_test(
            PathBuf::from("ping.exe"),
            vec!["127.0.0.1".to_string(), "-n".to_string(), "30".to_string()],
        );
        let cancellation = tokio_util::sync::CancellationToken::new();
        let cancel_later = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(2_200)).await;
            cancel_later.cancel();
        });

        let receipt = super::execute_host_verification_observed(
            &spec,
            workspace.path(),
            Duration::from_secs(10),
            cancellation,
            None,
            Some(context),
        )
        .await;

        assert_eq!(receipt.outcome, HostVerificationOutcome::Cancelled);
        let progress = observed.lock().unwrap();
        assert!(
            progress.len() >= 3,
            "start, heartbeat, and terminal updates are required"
        );
        assert_eq!(
            progress.last().and_then(|item| item.outcome),
            Some(TestExecutionOutcome::Cancelled)
        );
        assert!(!progress.last().unwrap().can_cancel);
    }
}
