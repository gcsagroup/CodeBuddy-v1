//! Session-bound owners for long-running commands. A start is not readiness.
use crate::agents::workers::SystemProcessGroupOwner;
use crate::session::SessionProcessTracker;
#[cfg(windows)]
use crate::subprocess::SubprocessExt;
use rmcp::model::{CallToolResult, Content};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ProcessAction {
    Start,
    Status,
    Stop,
}

#[derive(Deserialize)]
pub(super) struct ProcessParams {
    pub command: String,
    pub process_action: ProcessAction,
    pub process_handle: Option<String>,
    pub port: Option<u16>,
}

struct OwnedProcess {
    child: tokio::process::Child,
    owner: Arc<SystemProcessGroupOwner>,
    pid: u32,
    session: String,
    cwd: PathBuf,
    command: String,
    stdout: PathBuf,
    stderr: PathBuf,
    registration: Option<super::shell::TrackedProcess>,
    stopped: bool,
    port: Option<u16>,
}

#[derive(Default)]
pub(super) struct ProcessRegistry(Mutex<HashMap<String, OwnedProcess>>);

impl ProcessRegistry {
    pub(super) async fn execute(
        &self,
        params: ProcessParams,
        cwd: &Path,
        session: &str,
        directory: &Path,
        cancel: CancellationToken,
        tracker: Option<Arc<dyn SessionProcessTracker>>,
    ) -> CallToolResult {
        match self
            .run(params, cwd, session, directory, cancel, tracker)
            .await
        {
            Ok(value) => {
                let mut result = CallToolResult::success(vec![Content::text(value.to_string())]);
                result.is_error = Some(value["outcome"] == "unknown");
                result.structured_content = Some(value);
                result
            }
            Err(error) => super::shell::ShellTool::error_result(&error, None),
        }
    }

    async fn run(
        &self,
        params: ProcessParams,
        cwd: &Path,
        session: &str,
        directory: &Path,
        cancel: CancellationToken,
        tracker: Option<Arc<dyn SessionProcessTracker>>,
    ) -> Result<serde_json::Value, String> {
        let cwd = std::fs::canonicalize(cwd).map_err(|error| error.to_string())?;
        if cancel.is_cancelled() {
            return Err("Process request cancelled before execution".into());
        }
        let mut processes = self.0.lock().await;
        let handle = match params.process_action {
            ProcessAction::Start => {
                if params.process_handle.is_some() || params.command.trim().is_empty() {
                    return Err(
                        "Start needs a nonempty foreground command and no process_handle".into(),
                    );
                }
                for (handle, owned) in processes.iter_mut() {
                    if owned.session == session
                        && owned.cwd == cwd
                        && owned.command == params.command
                        && !owned.owner.is_empty().map_err(|error| error.to_string())?
                    {
                        return Self::snapshot(handle, owned).await;
                    }
                }
                // Never evict a live owner or silently create another copy.
                if processes.len() >= 32 {
                    return Err("Managed process history is full; continue with existing handles rather than starting more copies".into());
                }
                if let Some(port) = params.port {
                    if port == 0 {
                        return Err("Choose a concrete nonzero port".into());
                    }
                    let _available = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                        .map_err(|_| "Requested local port is occupied; choose another port without stopping its owner".to_string())?;
                }
                let handle = uuid::Uuid::new_v4().to_string();
                let stdout = directory.join(format!("{handle}.stdout.log"));
                let stderr = directory.join(format!("{handle}.stderr.log"));
                let out = std::fs::File::create(&stdout).map_err(|error| error.to_string())?;
                let err = std::fs::File::create(&stderr).map_err(|error| error.to_string())?;
                let mut command = super::shell::build_shell_command(
                    &params.command,
                    Some(&cwd),
                    None,
                    Some(session),
                );
                command
                    .stdin(Stdio::null())
                    .stdout(Stdio::from(out))
                    .stderr(Stdio::from(err));
                let owner = SystemProcessGroupOwner::new().map_err(|error| error.to_string())?;
                owner.configure_command(&mut command);
                let mut child = command.spawn().map_err(|error| error.to_string())?;
                let pid = child.id().ok_or("Started process has no PID")?;
                if let Err(error) = owner.attach(&child) {
                    let _ = child.kill().await;
                    return Err(error.to_string());
                }
                let registration = match tracker {
                    Some(tracker) => match super::shell::TrackedProcess::register_owned(
                        tracker,
                        pid,
                        owner.clone(),
                    ) {
                        Ok(registration) => Some(registration),
                        Err(error) => {
                            super::shell::terminate_shell_process(&mut child).await;
                            return Err(error);
                        }
                    },
                    None => None,
                };
                if let Err(error) = owner.resume(&child) {
                    let _ = owner.terminate_group();
                    return Err(error.to_string());
                }
                if cancel.is_cancelled() {
                    let _ = owner.terminate_group();
                    return Err(
                        "Process start cancelled; inspect the workspace before retrying".into(),
                    );
                }
                processes.insert(
                    handle.clone(),
                    OwnedProcess {
                        child,
                        owner,
                        pid,
                        session: session.into(),
                        cwd: cwd.clone(),
                        command: params.command.clone(),
                        stdout,
                        stderr,
                        registration,
                        stopped: false,
                        port: params.port,
                    },
                );
                handle
            }
            ProcessAction::Status | ProcessAction::Stop => params.process_handle.clone().ok_or(
                "A session-owned process_handle is required; an arbitrary PID is not accepted",
            )?,
        };
        let owned = processes.get_mut(&handle).ok_or("Process handle unavailable (possibly from an older backend). No process was queried or stopped; do not substitute a PID or assume the old process stopped.")?;
        if owned.session != session || owned.cwd != cwd || owned.command != params.command {
            return Err(
                "Process handle does not belong to this session, workspace and command".into(),
            );
        }
        if matches!(params.process_action, ProcessAction::Stop) {
            owned.stopped = owned.owner.terminate_group().is_ok()
                && owned
                    .owner
                    .wait_empty(std::time::Duration::from_secs(3))
                    .await;
            if !owned.stopped {
                let mut snapshot = Self::snapshot(&handle, owned).await?;
                snapshot["outcome"] = serde_json::json!("unknown");
                snapshot["instructions"] = serde_json::json!("Could not confirm owned process-tree termination. Do not launch a conflicting replacement or claim the process tree stopped.");
                return Ok(snapshot);
            }
        }
        Self::snapshot(&handle, owned).await
    }

    async fn snapshot(handle: &str, owned: &mut OwnedProcess) -> Result<serde_json::Value, String> {
        let status = owned.child.try_wait().map_err(|error| error.to_string())?;
        let empty = owned.owner.is_empty().map_err(|error| error.to_string())?;
        if empty {
            owned.registration.take();
        }
        let state = if owned.stopped {
            "stopped"
        } else if empty {
            "exited"
        } else {
            "running"
        };
        let listener_owned = if let Some(port) = owned.port {
            Self::owns_listener(&owned.owner, port).await
        } else {
            None
        };
        Ok(serde_json::json!({
            "managed_process": {"schema_version":1, "handle":handle, "pid":owned.pid,
                "state":state, "command":owned.command, "cwd":owned.cwd,
                "port":owned.port, "listener_owned":listener_owned,
                "stdout_path":owned.stdout, "stderr_path":owned.stderr,
                "exit_code":status.and_then(|value| value.code())},
            "cwd":owned.cwd,
            "stdout": Self::tail(&owned.stdout)?, "stderr": Self::tail(&owned.stderr)?,
            "instructions":"This is the owned process group's state, NOT application readiness. listener_owned=true binds this port to the launched group; null means unavailable, false means not owned/ready. Verify this project's route and content before offering its URL. Use this handle and exact command for status/stop; never kill by port/name. Keep the service running for the user; closing this backend releases and stops managed process groups."
        }))
    }

    async fn owns_listener(owner: &SystemProcessGroupOwner, port: u16) -> Option<bool> {
        #[cfg(windows)]
        {
            let mut command = tokio::process::Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", &format!("Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess")]);
            command.set_no_window();
            command.kill_on_drop(true);
            let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
                .await
                .ok()?
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let pids = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|line| line.trim().parse::<u32>())
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            if pids.is_empty() {
                return Some(false);
            }
            for pid in pids {
                if !owner.contains_process(pid).ok()? {
                    return Some(false);
                }
            }
            Some(true)
        }
        #[cfg(target_os = "macos")]
        {
            let mut command = tokio::process::Command::new("/usr/sbin/lsof");
            command
                .args(["-nP", "-a", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fp"])
                .stdin(Stdio::null())
                .kill_on_drop(true);
            let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
                .await
                .ok()?
                .ok()?;
            // lsof returns 1 for an empty selection as well as errors. Only an
            // empty, diagnostic-free result establishes that no listener was found.
            if !output.stderr.is_empty() {
                return None;
            }
            if !output.status.success() {
                return (output.status.code() == Some(1) && output.stdout.is_empty())
                    .then_some(false);
            }
            let pids = parse_macos_listener_pids(&output.stdout)?;
            if pids.is_empty() {
                return Some(false);
            }
            for pid in pids {
                if !owner.contains_process(pid).ok()? {
                    return Some(false);
                }
            }
            Some(true)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (owner, port);
            None
        }
    }

    fn tail(path: &Path) -> Result<String, String> {
        let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let length = file.metadata().map_err(|error| error.to_string())?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(8192)))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(8192)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(target_os = "macos")]
fn parse_macos_listener_pids(bytes: &[u8]) -> Option<Vec<u32>> {
    let mut process = None;
    let mut listeners = Vec::new();
    // lsof includes an f (file descriptor) record even when only p is selected.
    // Count a PID only when its socket record follows the process header.
    for line in std::str::from_utf8(bytes).ok()?.lines() {
        if let Some(text) = line.strip_prefix('p') {
            if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let pid: u32 = text.parse().ok()?;
            if pid == 0 || pid > i32::MAX as u32 {
                return None;
            }
            process = Some(pid);
        } else if let Some(fd) = line.strip_prefix('f') {
            if fd.is_empty() || !fd.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            listeners.push(process?);
        } else {
            return None;
        }
    }
    Some(listeners)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn macos_listener_output_rejects_ambiguous_or_invalid_process_ids() {
        assert_eq!(
            parse_macos_listener_pids(b"p123\nf3\np456\nf4\n"),
            Some(vec![123, 456])
        );
        assert_eq!(parse_macos_listener_pids(b""), Some(vec![]));
        assert_eq!(parse_macos_listener_pids(b"p123\n"), Some(vec![]));
        assert_eq!(parse_macos_listener_pids(b"f3\n"), None);
        assert_eq!(parse_macos_listener_pids(b"p123\nf?\n"), None);
        for invalid in [
            b"p0\n".as_slice(),
            b"p-1\n",
            b"p2147483648\n",
            b"p+1\n",
            b"123\n",
            b"p123\nwarning\n",
            b"p 123\n",
            b"\xff",
        ] {
            assert_eq!(parse_macos_listener_pids(invalid), None, "{invalid:?}");
        }
    }

    // Launched only by the test below in a dedicated owned process group.
    #[test]
    #[ignore]
    fn macos_listener_fixture() {
        let path = std::env::var_os("CODEPRO_MAC_LISTENER_FIXTURE").expect("fixture path");
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        std::fs::write(path, listener.local_addr().unwrap().port().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(30));
        drop(listener);
    }

    #[tokio::test]
    async fn macos_listener_belongs_to_only_the_launched_group() {
        let dir = tempfile::tempdir().unwrap();
        let port_file = dir.path().join("listener.port");
        let owner = SystemProcessGroupOwner::new().unwrap();
        let unrelated_owner = SystemProcessGroupOwner::new().unwrap();
        let mut sibling_command = tokio::process::Command::new("/bin/sleep");
        sibling_command.arg("30").kill_on_drop(true);
        unrelated_owner.configure_command(&mut sibling_command);
        let mut sibling = sibling_command.spawn().unwrap();
        unrelated_owner.attach(&sibling).unwrap();
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                &format!(
                    "{}::macos_listener_fixture",
                    module_path!().split_once("::").unwrap().1
                ),
                "--ignored",
            ])
            .env("CODEPRO_MAC_LISTENER_FIXTURE", &port_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        owner.configure_command(&mut command);
        let mut child = command.spawn().unwrap();
        owner.attach(&child).unwrap();
        let port = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&port_file) {
                    if let Ok(port) = text.parse::<u16>() {
                        break port;
                    }
                }
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "listener fixture exited before ready"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let owned = ProcessRegistry::owns_listener(&owner, port).await;
        let unrelated = ProcessRegistry::owns_listener(&unrelated_owner, port).await;
        owner.terminate_group().unwrap();
        tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(owner.wait_empty(Duration::from_secs(3)).await);
        let stopped = ProcessRegistry::owns_listener(&owner, port).await;
        let sibling_alive = sibling.try_wait().unwrap().is_none();
        unrelated_owner.terminate_group().unwrap();
        sibling.wait().await.unwrap();
        assert!(
            sibling_alive,
            "listener inspection must not stop an unrelated group"
        );
        assert_eq!(
            owned,
            Some(true),
            "live listener must belong to its retained owner"
        );
        assert_eq!(
            unrelated,
            Some(false),
            "another owner must not claim the listener"
        );
        assert_eq!(
            stopped,
            Some(false),
            "closed listener must not be reported as owned"
        );
    }
}
