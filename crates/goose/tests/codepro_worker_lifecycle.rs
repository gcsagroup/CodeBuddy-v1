use async_trait::async_trait;
use goose::agents::control_plane::{
    CommittedControlEffect, ControlEffect, LifecycleController, WorkerStopMode,
};
use goose::agents::protocol::{AgentId, EventId, RunId, TaskId};
use goose::agents::workers::{
    ProcessTreeError, ProcessTreeStop, ProcessTreeStopOutcome, ProcessTreeTerminator,
    SystemProcessTreeTerminator, WorkerRegistry, WorkerRuntimeState,
};
#[cfg(windows)]
use goose::subprocess::SubprocessExt;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[tokio::test]
async fn process_tree_terminator_rejects_zero_pid() {
    let error = SystemProcessTreeTerminator
        .terminate_tree(0)
        .await
        .unwrap_err();
    assert!(matches!(error, ProcessTreeError::InvalidProcessId));
}

#[derive(Clone, Default)]
struct FakeTerminator {
    calls: Arc<Mutex<Vec<u32>>>,
    failures: Arc<BTreeSet<u32>>,
}

impl FakeTerminator {
    fn failing(process_ids: impl IntoIterator<Item = u32>) -> Self {
        Self {
            calls: Arc::default(),
            failures: Arc::new(process_ids.into_iter().collect()),
        }
    }

    fn calls(&self) -> Vec<u32> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl ProcessTreeTerminator for FakeTerminator {
    async fn terminate_tree(&self, process_id: u32) -> Result<ProcessTreeStop, ProcessTreeError> {
        self.calls.lock().unwrap().push(process_id);
        if self.failures.contains(&process_id) {
            Err(ProcessTreeError::StillRunning(process_id))
        } else {
            Ok(ProcessTreeStop {
                process_id,
                outcome: ProcessTreeStopOutcome::Terminated,
            })
        }
    }
}

fn committed_stop(run_id: &RunId, agent_ids: Vec<AgentId>) -> CommittedControlEffect {
    CommittedControlEffect {
        effect_id: "effect:10:0".to_string(),
        trigger_event_id: EventId::new("event:10").unwrap(),
        effect: ControlEffect::StopWorkers {
            run_id: run_id.clone(),
            agent_ids,
            mode: WorkerStopMode::CooperativeThenForce,
        },
    }
}

#[tokio::test(start_paused = true)]
async fn cooperative_worker_stop_finishes_without_force() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-lifecycle").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let handle = registry
        .register(
            run_id.clone(),
            Some(TaskId::new("task-1").unwrap()),
            agent_id.clone(),
        )
        .unwrap();
    let cancellation = registry.cancellation_token(&handle).unwrap();
    let completion_registry = registry.clone();
    let completion_handle = handle.clone();
    let runner = tokio::spawn(async move {
        cancellation.cancelled().await;
        completion_registry
            .mark_terminal(
                &completion_handle,
                goose::agents::workers::WorkerTerminalState::Stopped,
            )
            .unwrap();
    });
    registry
        .attach_abort_handle(&handle, runner.abort_handle())
        .unwrap();
    let terminator = FakeTerminator::default();
    let controller =
        LifecycleController::new(registry.clone(), terminator.clone(), Duration::from_secs(5));

    let receipts = controller
        .apply(&committed_stop(&run_id, vec![agent_id]))
        .await
        .unwrap();

    assert_eq!(receipts.len(), 1);
    assert!(receipts[0].cooperative);
    assert!(!receipts[0].forced);
    assert!(receipts[0].confirmed_stopped);
    assert!(!receipts[0].runner_aborted);
    assert!(receipts[0].process_trees.is_empty());
    assert!(receipts[0].failures.is_empty());
    assert!(terminator.calls().is_empty());
    runner.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn uncooperative_worker_escalates_with_fresh_process_snapshot() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-lifecycle-force").unwrap();
    let agent_id = AgentId::new("agent-force").unwrap();
    let handle = registry
        .register(run_id.clone(), None, agent_id.clone())
        .unwrap();
    registry.register_process(&handle, 3101).unwrap();
    registry.register_process(&handle, 3102).unwrap();
    let runner = tokio::spawn(std::future::pending::<()>());
    registry
        .attach_abort_handle(&handle, runner.abort_handle())
        .unwrap();
    let terminator = FakeTerminator::default();
    let controller =
        LifecycleController::new(registry.clone(), terminator.clone(), Duration::from_secs(5));

    let receipts = controller
        .apply(&committed_stop(&run_id, vec![agent_id]))
        .await
        .unwrap();

    assert!(!receipts[0].cooperative);
    assert!(receipts[0].forced);
    assert!(receipts[0].confirmed_stopped);
    assert!(receipts[0].runner_aborted);
    assert_eq!(terminator.calls(), vec![3101, 3102]);
    assert_eq!(receipts[0].process_trees.len(), 2);
    assert!(receipts[0].failures.is_empty());
    assert_eq!(
        registry.state(&handle).unwrap(),
        WorkerRuntimeState::Stopped
    );
    assert!(runner.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn partial_process_cleanup_remains_stopping_and_auditable() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-lifecycle-partial").unwrap();
    let agent_id = AgentId::new("agent-partial").unwrap();
    let handle = registry
        .register(run_id.clone(), None, agent_id.clone())
        .unwrap();
    registry.register_process(&handle, 3201).unwrap();
    registry.register_process(&handle, 3202).unwrap();
    let runner = tokio::spawn(std::future::pending::<()>());
    registry
        .attach_abort_handle(&handle, runner.abort_handle())
        .unwrap();
    let terminator = FakeTerminator::failing([3202]);
    let controller = LifecycleController::new(registry.clone(), terminator, Duration::from_secs(5));

    let receipts = controller
        .apply(&committed_stop(&run_id, vec![agent_id]))
        .await
        .unwrap();

    assert!(receipts[0].forced);
    assert!(!receipts[0].confirmed_stopped);
    assert!(receipts[0].runner_aborted);
    assert_eq!(receipts[0].process_trees.len(), 1);
    assert_eq!(receipts[0].failures.len(), 1);
    assert_eq!(receipts[0].failures[0].process_id, 3202);
    assert_eq!(
        registry.state(&handle).unwrap(),
        WorkerRuntimeState::Stopping
    );
    assert!(runner.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn emergency_stop_immediately_covers_every_registered_run_worker() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-emergency").unwrap();
    let first = registry
        .register(run_id.clone(), None, AgentId::new("agent-1").unwrap())
        .unwrap();
    let second = registry
        .register(run_id.clone(), None, AgentId::new("agent-2").unwrap())
        .unwrap();
    let foreign = registry
        .register(
            RunId::new("run-foreign").unwrap(),
            None,
            AgentId::new("agent-foreign").unwrap(),
        )
        .unwrap();
    let first_runner = tokio::spawn(std::future::pending::<()>());
    let second_runner = tokio::spawn(std::future::pending::<()>());
    registry
        .attach_abort_handle(&first, first_runner.abort_handle())
        .unwrap();
    registry
        .attach_abort_handle(&second, second_runner.abort_handle())
        .unwrap();
    let controller = LifecycleController::new(
        registry.clone(),
        FakeTerminator::default(),
        Duration::from_secs(60),
    );
    let effect = CommittedControlEffect {
        effect_id: "effect:20:0".to_string(),
        trigger_event_id: EventId::new("event:20").unwrap(),
        effect: ControlEffect::EmergencyStop {
            run_id,
            agent_ids: vec![first.agent_id().clone()],
        },
    };

    let receipts = controller.apply(&effect).await.unwrap();

    assert_eq!(receipts.len(), 2);
    assert!(receipts.iter().all(|receipt| receipt.forced));
    assert!(receipts.iter().all(|receipt| receipt.confirmed_stopped));
    assert_eq!(registry.state(&first).unwrap(), WorkerRuntimeState::Stopped);
    assert_eq!(
        registry.state(&second).unwrap(),
        WorkerRuntimeState::Stopped
    );
    assert_eq!(
        registry.state(&foreign).unwrap(),
        WorkerRuntimeState::Active
    );
    assert!(first_runner.await.unwrap_err().is_cancelled());
    assert!(second_runner.await.unwrap_err().is_cancelled());
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::path::Path;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    struct ProcessTreeCleanup {
        parent_pid: u32,
    }

    impl Drop for ProcessTreeCleanup {
        fn drop(&mut self) {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &self.parent_pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .set_no_window()
                .status();
        }
    }

    async fn wait_for_child_pid(path: &Path) -> u32 {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(value) = tokio::fs::read_to_string(path).await {
                    if let Ok(pid) = value.trim().parse::<u32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("fixture child PID must be published")
    }

    #[tokio::test]
    async fn windows_terminates_parent_and_descendant_process_tree() {
        let directory = tempfile::tempdir().unwrap();
        let child_pid_path = directory.path().join("child.pid");
        let escaped_path = child_pid_path.to_string_lossy().replace("'", "''");
        let script = format!(
            "$child = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60'; Set-Content -LiteralPath '{escaped_path}' -Value $child.Id; Start-Sleep -Seconds 60"
        );
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .set_no_window();
        let mut parent = command.spawn().unwrap();
        let parent_pid = parent.id().unwrap();
        let cleanup = ProcessTreeCleanup { parent_pid };
        let child_pid = wait_for_child_pid(&child_pid_path).await;

        let stop_started = Instant::now();
        let stopped = SystemProcessTreeTerminator
            .terminate_tree(parent_pid)
            .await
            .unwrap();
        let stop_elapsed = stop_started.elapsed();
        println!(
            "CODEPRO_WINDOWS_PROCESS_TREE_STOP_MS={}",
            stop_elapsed.as_secs_f64() * 1000.0
        );
        assert!(stop_elapsed < Duration::from_secs(4));
        assert_eq!(stopped.process_id, parent_pid);
        assert_eq!(stopped.outcome, ProcessTreeStopOutcome::Terminated);
        tokio::time::timeout(Duration::from_secs(3), parent.wait())
            .await
            .expect("terminated parent must be reapable")
            .unwrap();

        let descendant = SystemProcessTreeTerminator
            .terminate_tree(child_pid)
            .await
            .unwrap();
        assert_eq!(descendant.process_id, child_pid);
        assert_eq!(descendant.outcome, ProcessTreeStopOutcome::AlreadyExited);
        std::mem::forget(cleanup);
    }

    #[tokio::test]
    async fn missing_process_is_reported_as_already_exited() {
        let result = SystemProcessTreeTerminator
            .terminate_tree(u32::MAX - 1)
            .await
            .unwrap();
        assert_eq!(result.outcome, ProcessTreeStopOutcome::AlreadyExited);
    }
}

#[cfg(not(windows))]
#[tokio::test]
async fn non_windows_tree_termination_is_explicitly_unsupported() {
    let error = SystemProcessTreeTerminator
        .terminate_tree(1)
        .await
        .unwrap_err();
    assert!(matches!(error, ProcessTreeError::UnsupportedPlatform));
}

#[derive(Default)]
struct ConfirmableOwner {
    calls: std::sync::atomic::AtomicUsize,
    empty: std::sync::atomic::AtomicBool,
    fail_termination: std::sync::atomic::AtomicBool,
}

impl goose::session::SessionProcessOwner for ConfirmableOwner {
    fn terminate(&self) -> Result<(), String> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self
            .fail_termination
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            Err("synthetic owner termination failure".to_string())
        } else {
            Ok(())
        }
    }
    fn is_empty(&self) -> Result<bool, String> {
        Ok(self.empty.load(std::sync::atomic::Ordering::SeqCst))
    }
}

#[tokio::test(start_paused = true)]
async fn owned_process_failure_is_retained_across_runner_drop_and_retry() {
    use std::sync::atomic::Ordering;
    let registry = WorkerRegistry::new();
    let run = RunId::new("run-owned-retry").unwrap();
    let agent = AgentId::new("owned-retry").unwrap();
    let handle = registry.register(run.clone(), None, agent.clone()).unwrap();
    let owner = Arc::new(ConfirmableOwner::default());
    registry
        .register_process_owner(&handle, 4101, owner.clone())
        .unwrap();
    let completed_owner = Arc::new(ConfirmableOwner::default());
    completed_owner.empty.store(true, Ordering::SeqCst);
    registry
        .register_process_owner(&handle, 4103, completed_owner.clone())
        .unwrap();
    let runner = tokio::spawn(std::future::pending::<()>());
    registry
        .attach_abort_handle(&handle, runner.abort_handle())
        .unwrap();
    let fallback = FakeTerminator::default();
    let controller = LifecycleController::new(registry.clone(), fallback.clone(), Duration::ZERO);
    let effect = committed_stop(&run, vec![agent]);
    for _ in 0..2 {
        let receipt = controller.apply(&effect).await.unwrap().remove(0);
        assert!(!receipt.confirmed_stopped);
        assert_eq!(receipt.failures.len(), 1);
        assert_eq!(
            registry.state(&handle).unwrap(),
            WorkerRuntimeState::Stopping
        );
        assert!(!registry.unregister_process(&handle, 4101).unwrap());
        assert!(registry.process_owner(&handle, 4101).unwrap().is_some());
        assert!(registry.register_process(&handle, 4102).is_err());
    }
    owner.empty.store(true, Ordering::SeqCst);
    let receipt = controller.apply(&effect).await.unwrap().remove(0);
    assert!(receipt.confirmed_stopped);
    assert!(registry.process_ids(&handle).unwrap().is_empty());
    assert!(registry.process_owner(&handle, 4101).unwrap().is_none());
    assert!(fallback.calls().is_empty());
    assert_eq!(owner.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        completed_owner.calls.load(Ordering::SeqCst),
        1,
        "confirmed process must not be terminated again on retry"
    );
    assert!(controller.apply(&effect).await.unwrap()[0].cooperative);
    assert_eq!(owner.calls.load(Ordering::SeqCst), 3);
    assert!(runner.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn owner_error_does_not_fall_back_to_pid_or_report_success() {
    use std::sync::atomic::Ordering;
    let registry = WorkerRegistry::new();
    let run = RunId::new("run-owner-error").unwrap();
    let agent = AgentId::new("owner-error").unwrap();
    let handle = registry.register(run.clone(), None, agent.clone()).unwrap();
    let owner = Arc::new(ConfirmableOwner::default());
    owner.empty.store(true, Ordering::SeqCst);
    owner.fail_termination.store(true, Ordering::SeqCst);
    registry
        .register_process_owner(&handle, 4201, owner)
        .unwrap();
    let fallback = FakeTerminator::default();
    let controller = LifecycleController::new(registry.clone(), fallback.clone(), Duration::ZERO);
    let receipt = controller
        .apply(&committed_stop(&run, vec![agent]))
        .await
        .unwrap()
        .remove(0);
    assert!(!receipt.confirmed_stopped);
    assert!(receipt.failures[0]
        .message
        .contains("synthetic owner termination failure"));
    assert!(fallback.calls().is_empty());
    assert!(registry.process_owner(&handle, 4201).unwrap().is_some());
}

#[tokio::test(start_paused = true)]
async fn owner_registered_during_cooperative_grace_is_in_force_snapshot() {
    use std::sync::atomic::Ordering;
    let registry = WorkerRegistry::new();
    let run = RunId::new("run-late-owner").unwrap();
    let agent = AgentId::new("late-owner").unwrap();
    let handle = registry.register(run.clone(), None, agent.clone()).unwrap();
    let owner = Arc::new(ConfirmableOwner::default());
    owner.empty.store(true, Ordering::SeqCst);
    let cancel = registry.cancellation_token(&handle).unwrap();
    let late_registry = registry.clone();
    let late_handle = handle.clone();
    let late_owner = owner.clone();
    let runner = tokio::spawn(async move {
        cancel.cancelled().await;
        late_registry
            .register_process_owner(&late_handle, 4301, late_owner)
            .unwrap();
        std::future::pending::<()>().await;
    });
    registry
        .attach_abort_handle(&handle, runner.abort_handle())
        .unwrap();
    let fallback = FakeTerminator::default();
    let controller = LifecycleController::new(registry, fallback.clone(), Duration::from_secs(1));
    let receipt = controller
        .apply(&committed_stop(&run, vec![agent]))
        .await
        .unwrap()
        .remove(0);
    assert!(receipt.confirmed_stopped);
    assert_eq!(receipt.process_trees[0].process_id, 4301);
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
    assert!(fallback.calls().is_empty());
    assert!(runner.await.unwrap_err().is_cancelled());
}

#[test]
fn owner_registration_preserves_identity_and_rejects_stale_generations() {
    use goose::agents::workers::{RegistryError, WorkerTerminalState};
    let registry = WorkerRegistry::new();
    let run = RunId::new("run-owner-generation").unwrap();
    let agent = AgentId::new("owner-generation").unwrap();
    let handle = registry.register(run.clone(), None, agent.clone()).unwrap();
    let owner: Arc<dyn goose::session::SessionProcessOwner> = Arc::new(ConfirmableOwner::default());
    registry
        .register_process_owner(&handle, 4401, owner.clone())
        .unwrap();
    registry
        .register_process_owner(&handle, 4401, owner.clone())
        .unwrap();
    assert!(matches!(
        registry.register_process_owner(&handle, 4401, Arc::new(ConfirmableOwner::default())),
        Err(RegistryError::ProcessOwnerConflict(4401))
    ));
    assert!(Arc::ptr_eq(
        &registry.process_owner(&handle, 4401).unwrap().unwrap(),
        &owner
    ));
    registry
        .mark_terminal(&handle, WorkerTerminalState::Stopped)
        .unwrap();
    let new_handle = registry.register(run, None, agent).unwrap();
    assert!(matches!(
        registry.register_process_owner(&handle, 4402, owner),
        Err(RegistryError::StaleGeneration { .. })
    ));
    assert!(registry.process_ids(&new_handle).unwrap().is_empty());
}

#[cfg(target_os = "macos")]
mod macos_owned {
    use super::*;
    use goose::agents::workers::SystemProcessGroupOwner;
    use std::process::Stdio;

    async fn native_stop(parent_exits: bool) {
        let temp = tempfile::tempdir().unwrap();
        let pid_file = temp.path().join("child.pid");
        let owner = SystemProcessGroupOwner::new().unwrap();
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args([
                "-c",
                if parent_exits {
                    "sleep 30 & echo $! > child.pid; exit 0"
                } else {
                    "sleep 30 & echo $! > child.pid; wait"
                },
            ])
            .current_dir(temp.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        owner.configure_command(&mut command);
        let mut child = command.spawn().unwrap();
        let parent_pid = child.id().unwrap();
        owner.attach(&child).unwrap();
        let descendant: i32 = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = pid.trim().parse() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(unsafe { libc::kill(descendant, 0) }, 0);
        if parent_exits {
            child.wait().await.unwrap();
        }
        let mut sibling = tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let registry = WorkerRegistry::new();
        let run = RunId::new("run-native-owned").unwrap();
        let agent = AgentId::new("native-owned").unwrap();
        let handle = registry.register(run.clone(), None, agent.clone()).unwrap();
        registry
            .register_process_owner(&handle, parent_pid, owner.clone())
            .unwrap();
        let runner = tokio::spawn(async move {
            let _child = child;
            std::future::pending::<()>().await;
        });
        registry
            .attach_abort_handle(&handle, runner.abort_handle())
            .unwrap();
        let controller = LifecycleController::new(
            registry.clone(),
            SystemProcessTreeTerminator,
            Duration::ZERO,
        );
        let receipt = controller
            .apply(&committed_stop(&run, vec![agent]))
            .await
            .unwrap()
            .remove(0);
        let gone = unsafe { libc::kill(descendant, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        let sibling_alive = sibling.try_wait().unwrap().is_none();
        sibling.kill().await.unwrap();
        assert!(receipt.confirmed_stopped, "{receipt:?}");
        assert!(receipt.failures.is_empty());
        assert_eq!(
            registry.state(&handle).unwrap(),
            WorkerRuntimeState::Stopped
        );
        assert!(gone, "recorded fixture descendant survived");
        assert!(sibling_alive, "foreign sibling must remain alive");
        assert!(runner.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn macos_force_stop_uses_owned_group_and_confirms_descendants() {
        native_stop(false).await;
    }

    #[tokio::test]
    async fn macos_force_stop_handles_exited_parent_with_live_descendant() {
        native_stop(true).await;
    }
}
