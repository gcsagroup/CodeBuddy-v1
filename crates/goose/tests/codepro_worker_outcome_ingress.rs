use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use goose::agents::control_plane::{
    CommandReceipt, CoordinatorDecisionHook, CoordinatorHookError, CoordinatorHookStatus,
    FileRunEventStore, OutcomeIngress, OutcomeIngressError, OutcomeRuntimeSync, OutcomeSubmission,
    RunClock, RunEngine, RunEventStore,
};
use goose::agents::protocol::{
    AgentId, AgentState, AssistanceRequest, CoordinatorDecisionPoint, EventId, ProtocolVersion,
    RunEvent, RunEventPayload, RunId, RunState, TaskId, TaskResult, TaskState, WorkerOutcome,
};
use goose::agents::workers::{OutcomeSuppression, WorkerRegistry, WorkerRuntimeState};
use goose::agents::AgentRole;
use std::sync::Mutex;

#[derive(Clone)]
struct FixedClock(DateTime<Utc>);

impl RunClock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn event(
    run_id: &RunId,
    sequence: u64,
    task_id: Option<&TaskId>,
    agent_id: Option<&AgentId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(format!("ingress-seed-{sequence}")).unwrap();
    RunEvent {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: task_id.cloned(),
        agent_id: agent_id.cloned(),
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc
            .with_ymd_and_hms(2026, 8, 6, 0, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn running_task(run_id: &RunId, task_id: &TaskId, agent_id: &AgentId) -> Vec<RunEvent> {
    vec![
        event(
            run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "accept only current worker results".to_string(),
            },
        ),
        event(
            run_id,
            2,
            None,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            run_id,
            3,
            Some(task_id),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "generation-safe task".to_string(),
                role: None,
            },
        ),
        event(
            run_id,
            4,
            Some(task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        event(
            run_id,
            5,
            Some(task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ),
        event(
            run_id,
            6,
            Some(task_id),
            Some(agent_id),
            RunEventPayload::AgentSpawned {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                role: AgentRole::Coder,
            },
        ),
        event(
            run_id,
            7,
            Some(task_id),
            Some(agent_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Starting,
                to: AgentState::Running,
            },
        ),
    ]
}

fn success() -> WorkerOutcome {
    WorkerOutcome::Succeeded(TaskResult {
        summary: "completed and verified".to_string(),
        evidence_refs: vec![],
    })
}

#[derive(Default)]
struct RecordingHook {
    points: Mutex<Vec<CoordinatorDecisionPoint>>,
    fail: bool,
}

#[async_trait]
impl CoordinatorDecisionHook for RecordingHook {
    async fn observe(
        &self,
        point: CoordinatorDecisionPoint,
        receipt: &CommandReceipt,
    ) -> Result<(), CoordinatorHookError> {
        assert!(receipt.append().appended > 0, "outcome must commit first");
        self.points.lock().unwrap().push(point);
        if self.fail {
            Err(CoordinatorHookError::new("shadow observation failed"))
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn current_generation_commits_then_terminalizes_runtime() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-outcome-ingress").unwrap();
    let task_id = TaskId::new("task-outcome-ingress").unwrap();
    let agent_id = AgentId::new("agent-outcome-ingress").unwrap();
    store
        .append(&run_id, 0, &running_task(&run_id, &task_id, &agent_id))
        .await
        .unwrap();
    let registry = WorkerRegistry::new();
    let handle = registry
        .register(run_id.clone(), Some(task_id.clone()), agent_id.clone())
        .unwrap();
    let engine = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 6, 0, 30, 0).unwrap()),
    );

    let submission = OutcomeIngress::new(&engine, &registry)
        .submit(&handle, success())
        .await
        .unwrap();
    let OutcomeSubmission::Committed {
        receipt,
        runtime_sync,
    } = submission
    else {
        panic!("current generation must commit");
    };
    assert_eq!(runtime_sync, OutcomeRuntimeSync::Synchronized);
    assert_eq!(
        receipt.projection().tasks[&task_id].state,
        TaskState::Succeeded
    );
    assert_eq!(
        registry.state(&handle).unwrap(),
        WorkerRuntimeState::Stopped
    );
    assert_eq!(store.load(&run_id).await.unwrap().len(), 11);

    assert_eq!(
        OutcomeIngress::new(&engine, &registry)
            .submit(&handle, success())
            .await
            .unwrap(),
        OutcomeSubmission::Suppressed(OutcomeSuppression::WorkerTerminal)
    );
}

#[tokio::test]
async fn stale_generation_is_suppressed_without_appending() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-stale-ingress").unwrap();
    let task_id = TaskId::new("task-stale-ingress").unwrap();
    let agent_id = AgentId::new("agent-stale-ingress").unwrap();
    store
        .append(&run_id, 0, &running_task(&run_id, &task_id, &agent_id))
        .await
        .unwrap();
    let registry = WorkerRegistry::new();
    let stale = registry
        .register(run_id.clone(), Some(task_id.clone()), agent_id.clone())
        .unwrap();
    registry
        .mark_terminal(&stale, goose::agents::workers::WorkerTerminalState::Stopped)
        .unwrap();
    let _current = registry
        .register(run_id.clone(), Some(task_id), agent_id)
        .unwrap();
    let engine = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 6, 0, 45, 0).unwrap()),
    );

    assert_eq!(
        OutcomeIngress::new(&engine, &registry)
            .submit(&stale, success())
            .await
            .unwrap(),
        OutcomeSubmission::Suppressed(OutcomeSuppression::StaleGeneration)
    );
    assert_eq!(store.load(&run_id).await.unwrap().len(), 7);
}

#[tokio::test]
async fn assistance_request_commits_but_keeps_worker_available() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-help-ingress").unwrap();
    let task_id = TaskId::new("task-help-ingress").unwrap();
    let agent_id = AgentId::new("agent-help-ingress").unwrap();
    store
        .append(&run_id, 0, &running_task(&run_id, &task_id, &agent_id))
        .await
        .unwrap();
    let registry = WorkerRegistry::new();
    let handle = registry
        .register(run_id.clone(), Some(task_id.clone()), agent_id)
        .unwrap();
    let engine = RunEngine::new(
        store,
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 6, 0, 50, 0).unwrap()),
    );

    let submission = OutcomeIngress::new(&engine, &registry)
        .submit(
            &handle,
            WorkerOutcome::NeedsHelp(AssistanceRequest {
                reason: "need a reviewer".to_string(),
                required_capabilities: vec!["review".to_string()],
                evidence_refs: vec![],
            }),
        )
        .await
        .unwrap();
    let OutcomeSubmission::Committed { receipt, .. } = submission else {
        panic!("assistance must commit");
    };
    assert_eq!(
        receipt.projection().tasks[&task_id].state,
        TaskState::WaitingForCoordinator
    );
    assert_eq!(registry.state(&handle).unwrap(), WorkerRuntimeState::Active);
}

#[tokio::test]
async fn reducer_rejection_releases_claim_for_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-rejected-ingress").unwrap();
    let task_id = TaskId::new("task-rejected-ingress").unwrap();
    let agent_id = AgentId::new("agent-rejected-ingress").unwrap();
    let mut seed = running_task(&run_id, &task_id, &agent_id);
    seed.pop();
    store.append(&run_id, 0, &seed).await.unwrap();
    let registry = WorkerRegistry::new();
    let handle = registry
        .register(run_id.clone(), Some(task_id), agent_id)
        .unwrap();
    let engine = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 6, 1, 0, 0).unwrap()),
    );

    assert!(matches!(
        OutcomeIngress::new(&engine, &registry)
            .submit(&handle, success())
            .await,
        Err(OutcomeIngressError::Engine(_))
    ));
    assert_eq!(registry.state(&handle).unwrap(), WorkerRuntimeState::Active);
    assert_eq!(store.load(&run_id).await.unwrap().len(), 6);
}

#[tokio::test]
async fn semantic_hook_runs_after_commit_and_failure_does_not_undo_legacy_outcome() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-hook-ingress").unwrap();
    let task_id = TaskId::new("task-hook-ingress").unwrap();
    let agent_id = AgentId::new("agent-hook-ingress").unwrap();
    store
        .append(&run_id, 0, &running_task(&run_id, &task_id, &agent_id))
        .await
        .unwrap();
    let registry = WorkerRegistry::new();
    let handle = registry
        .register(run_id.clone(), Some(task_id.clone()), agent_id)
        .unwrap();
    let engine = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 6, 1, 5, 0).unwrap()),
    );
    let hook = RecordingHook {
        fail: true,
        ..Default::default()
    };

    let coordinated = OutcomeIngress::new(&engine, &registry)
        .submit_with_coordinator(&handle, success(), &hook)
        .await
        .unwrap();
    assert_eq!(coordinated.coordinator, CoordinatorHookStatus::Failed);
    let OutcomeSubmission::Committed { receipt, .. } = coordinated.submission else {
        panic!("legacy outcome must remain committed");
    };
    assert_eq!(
        receipt.projection().tasks[&task_id].state,
        TaskState::Succeeded
    );
    assert_eq!(
        *hook.points.lock().unwrap(),
        vec![CoordinatorDecisionPoint::CompletionCheck]
    );
    assert_eq!(store.load(&run_id).await.unwrap().len(), 11);
}
