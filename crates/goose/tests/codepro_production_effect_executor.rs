use async_trait::async_trait;
use goose::agents::control_plane::{
    CommittedControlEffect, ControlEffect, ControlEffectExecutor, ProductionControlEffectExecutor,
    SchedulerGateError, SchedulerGateRegistry, WorkerStopMode,
};
use goose::agents::protocol::{AgentId, EventId, RunId, TaskId};
use goose::agents::workers::{
    ProcessTreeError, ProcessTreeStop, ProcessTreeTerminator, WorkerRegistry, WorkerRuntimeState,
};
use std::future::pending;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
struct NoopProcessTerminator;

#[async_trait]
impl ProcessTreeTerminator for NoopProcessTerminator {
    async fn terminate_tree(&self, process_id: u32) -> Result<ProcessTreeStop, ProcessTreeError> {
        panic!("test worker has no registered process tree: {process_id}")
    }
}

fn committed(effect_id: &str, effect: ControlEffect) -> CommittedControlEffect {
    CommittedControlEffect {
        effect_id: effect_id.to_string(),
        trigger_event_id: EventId::new(format!("event-{effect_id}")).unwrap(),
        effect,
    }
}

#[tokio::test]
async fn dispatch_pause_and_recover_control_exact_scheduler_leases() {
    let run_id = RunId::new("production-gate-run").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let gates = SchedulerGateRegistry::new();
    gates.ensure_run(run_id.clone()).unwrap();
    let executor = ProductionControlEffectExecutor::new(
        gates.clone(),
        WorkerRegistry::new(),
        NoopProcessTerminator,
        Duration::from_millis(10),
    );

    executor
        .execute(&committed(
            "dispatch-1",
            ControlEffect::DispatchTask {
                run_id: run_id.clone(),
                task_id: task_id.clone(),
            },
        ))
        .await
        .unwrap();
    executor
        .execute(&committed(
            "pause-1",
            ControlEffect::PauseScheduling {
                run_id: run_id.clone(),
            },
        ))
        .await
        .unwrap();
    assert!(matches!(
        gates.try_claim(&run_id, &task_id),
        Err(SchedulerGateError::Paused(_))
    ));

    executor
        .execute(&committed(
            "recover-1",
            ControlEffect::RecoverRun {
                run_id: run_id.clone(),
            },
        ))
        .await
        .unwrap();
    let lease = gates.try_claim(&run_id, &task_id).unwrap().unwrap();
    assert_eq!(lease.effect_id, "dispatch-1");
    assert!(gates.try_claim(&run_id, &task_id).unwrap().is_none());
}

#[tokio::test]
async fn stop_worker_cancels_the_registered_generation_and_aborts_its_runner() {
    let run_id = RunId::new("production-stop-run").unwrap();
    let task_id = TaskId::new("task-stop").unwrap();
    let agent_id = AgentId::new("worker-stop").unwrap();
    let gates = SchedulerGateRegistry::new();
    gates.ensure_run(run_id.clone()).unwrap();
    let registry = WorkerRegistry::new();
    let handle = registry
        .register(run_id.clone(), Some(task_id), agent_id.clone())
        .unwrap();
    let cancellation = registry.cancellation_token(&handle).unwrap();
    let runner = tokio::spawn(pending::<()>());
    registry
        .attach_abort_handle(&handle, runner.abort_handle())
        .unwrap();
    let executor = ProductionControlEffectExecutor::new(
        gates,
        registry.clone(),
        NoopProcessTerminator,
        Duration::from_millis(10),
    );

    executor
        .execute(&committed(
            "stop-1",
            ControlEffect::StopWorkers {
                run_id,
                agent_ids: vec![agent_id],
                mode: WorkerStopMode::Immediate,
            },
        ))
        .await
        .unwrap();

    assert!(cancellation.is_cancelled());
    assert_eq!(
        registry.state(&handle).unwrap(),
        WorkerRuntimeState::Stopped
    );
    assert!(runner.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn emergency_stop_is_idempotent_without_and_cancels_a_prompt_root_token() {
    let run_id = RunId::new("production-emergency-run").unwrap();
    let gates = SchedulerGateRegistry::new();
    gates.ensure_run(run_id.clone()).unwrap();
    let executor = ProductionControlEffectExecutor::new(
        gates.clone(),
        WorkerRegistry::new(),
        NoopProcessTerminator,
        Duration::from_millis(10),
    );
    let emergency = committed(
        "emergency-1",
        ControlEffect::EmergencyStop {
            run_id: run_id.clone(),
            agent_ids: vec![],
        },
    );

    executor.execute(&emergency).await.unwrap();
    assert!(!gates.is_open(&run_id).unwrap());

    gates.recover(&run_id).unwrap();
    let root = CancellationToken::new();
    gates.register_prompt(&run_id, root.clone()).unwrap();
    let cancellation_started = Instant::now();
    executor.execute(&emergency).await.unwrap();
    let cancellation_elapsed = cancellation_started.elapsed();
    println!(
        "CODEPRO_USER_STOP_TO_CANCELLATION_SIGNAL_MS={}",
        cancellation_elapsed.as_secs_f64() * 1000.0
    );
    assert!(cancellation_elapsed < Duration::from_secs(1));
    assert!(root.is_cancelled());
    assert!(!gates.is_open(&run_id).unwrap());
}
