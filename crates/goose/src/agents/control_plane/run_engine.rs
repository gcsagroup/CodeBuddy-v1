use super::{
    reduce, AppendReceipt, CommittedControlEffect, EffectLedgerError, EffectOutbox, EventIntent,
    EventStoreError, NoopEffectOutbox, ReducerError, RunEventStore,
};
use crate::agents::protocol::{
    ControlCommand, EventId, ProtocolError, ProtocolVersion, RunEvent, RunId,
};
use crate::agents::reporting::{ProjectionError, RunProjection};
use chrono::{DateTime, Utc};
use std::collections::HashSet;

pub trait RunClock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemRunClock;

impl RunClock for SystemRunClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandReceipt {
    append: AppendReceipt,
    committed_events: Vec<RunEvent>,
    projection: RunProjection,
    effects: Vec<CommittedControlEffect>,
}

impl CommandReceipt {
    pub fn append(&self) -> &AppendReceipt {
        &self.append
    }

    pub fn committed_events(&self) -> &[RunEvent] {
        &self.committed_events
    }

    pub fn projection(&self) -> &RunProjection {
        &self.projection
    }

    pub fn effects(&self) -> &[CommittedControlEffect] {
        &self.effects
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RunEngineError {
    #[error("control command validation failed: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("event store operation failed: {0}")]
    Store(#[from] EventStoreError),
    #[error("run projection failed: {0}")]
    Projection(#[from] ProjectionError),
    #[error("control command reduction failed: {0}")]
    Reducer(#[from] ReducerError),
    #[error("effect outbox operation failed: {0}")]
    EffectOutbox(#[from] EffectLedgerError),
    #[error("run engine invariant failed: {0}")]
    Invariant(String),
}

pub struct RunEngine<S, C, O = NoopEffectOutbox> {
    store: S,
    clock: C,
    outbox: O,
}

impl<S, C> RunEngine<S, C, NoopEffectOutbox>
where
    S: RunEventStore,
    C: RunClock,
{
    pub fn new(store: S, clock: C) -> Self {
        Self {
            store,
            clock,
            outbox: NoopEffectOutbox,
        }
    }
}

impl<S, C, O> RunEngine<S, C, O>
where
    S: RunEventStore,
    C: RunClock,
    O: EffectOutbox,
{
    pub fn with_effect_outbox(store: S, clock: C, outbox: O) -> Self {
        Self {
            store,
            clock,
            outbox,
        }
    }

    pub async fn load_projection(
        &self,
        run_id: &RunId,
    ) -> Result<Option<RunProjection>, RunEngineError> {
        let events = self.store.load(run_id).await?;
        if events.is_empty() {
            Ok(None)
        } else {
            Ok(Some(RunProjection::rebuild(&events)?))
        }
    }

    pub async fn apply(&self, command: ControlCommand) -> Result<CommandReceipt, RunEngineError> {
        command.validate()?;
        let run_id = command.run_id().clone();
        let command_kind = command.kind();
        tracing::info!(
            run_id = %run_id,
            command = command_kind,
            "CodePro run engine is loading committed events"
        );
        let loaded = self.store.load(&run_id).await?;
        tracing::info!(
            run_id = %run_id,
            command = command_kind,
            event_count = loaded.len(),
            "CodePro run engine loaded committed events"
        );
        let current = if loaded.is_empty() {
            None
        } else {
            Some(RunProjection::rebuild(&loaded)?)
        };
        if let Some(projection) = current.as_ref() {
            if super::reducer::verified_user_input_replay(projection, &command)? {
                // A verified committed answer is a receipt lookup, not another mutation.
                return Ok(CommandReceipt {
                    append: AppendReceipt {
                        previous_sequence: projection.last_sequence,
                        last_sequence: projection.last_sequence,
                        appended: 0,
                    },
                    committed_events: vec![],
                    projection: projection.clone(),
                    effects: vec![],
                });
            }
        }
        let reduction = reduce(current.as_ref(), &command)?;
        tracing::info!(
            run_id = %run_id,
            command = command_kind,
            event_count = reduction.events.len(),
            effect_count = reduction.effects.len(),
            "CodePro run engine reduced the control command"
        );
        let expected_sequence = current
            .as_ref()
            .map_or(0, |projection| projection.last_sequence);
        let occurred_at = self.clock.now();
        let committed_events = materialize_events(
            &run_id,
            expected_sequence,
            occurred_at,
            &loaded,
            &reduction.events,
        )?;
        for event in &committed_events {
            event.validate()?;
        }

        let projection = preview_projection(current, &committed_events)?;
        let effects = bind_effects(&reduction.effects, &committed_events)?;
        tracing::info!(
            run_id = %run_id,
            command = command_kind,
            "CodePro run engine is preparing the effect outbox"
        );
        self.outbox.prepare(&committed_events, &effects)?;
        tracing::info!(
            run_id = %run_id,
            command = command_kind,
            "CodePro run engine is appending committed events"
        );
        let append = self
            .store
            .append(&run_id, expected_sequence, &committed_events)
            .await?;
        tracing::info!(
            run_id = %run_id,
            command = command_kind,
            "CodePro run engine appended committed events"
        );
        verify_append_receipt(&append, expected_sequence, &committed_events)?;
        self.outbox.commit_prepared(&effects)?;

        Ok(CommandReceipt {
            append,
            committed_events,
            projection,
            effects,
        })
    }

    /// Only runtime supplies these IDs, after consulting its lifecycle registry.
    /// No model-facing command can manufacture a confirmed stop.
    pub(super) async fn record_confirmed_stops(
        &self,
        mut receipt: CommandReceipt,
        agent_ids: &[crate::agents::protocol::AgentId],
    ) -> Result<CommandReceipt, RunEngineError> {
        if agent_ids.is_empty() {
            return Ok(receipt);
        }
        let run_id = &receipt.projection.run_id;
        let loaded = self.store.load(run_id).await?;
        let reduction = super::reducer::confirm_stopped_workers(&receipt.projection, agent_ids)?;
        reduction.validate()?;
        let events = materialize_events(
            run_id,
            receipt.projection.last_sequence,
            self.clock.now(),
            &loaded,
            &reduction.events,
        )?;
        for event in &events {
            event.validate()?;
        }
        let projection = preview_projection(Some(receipt.projection.clone()), &events)?;
        let append = self
            .store
            .append(run_id, receipt.projection.last_sequence, &events)
            .await?;
        verify_append_receipt(&append, receipt.projection.last_sequence, &events)?;
        receipt.append.last_sequence = append.last_sequence;
        receipt.append.appended += append.appended;
        receipt.committed_events.extend(events);
        receipt.projection = projection;
        Ok(receipt)
    }
}

fn materialize_events(
    run_id: &RunId,
    expected_sequence: u64,
    occurred_at: DateTime<Utc>,
    loaded: &[RunEvent],
    intents: &[EventIntent],
) -> Result<Vec<RunEvent>, RunEngineError> {
    let mut known_ids = loaded
        .iter()
        .map(|event| event.event_id.clone())
        .collect::<HashSet<_>>();
    let mut event_ids = Vec::with_capacity(intents.len());
    for index in 0..intents.len() {
        let offset = u64::try_from(index)
            .map_err(|_| RunEngineError::Invariant("event batch index exceeds u64".to_string()))?;
        let sequence = expected_sequence
            .checked_add(offset)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| RunEngineError::Invariant("event sequence overflow".to_string()))?;
        event_ids.push(unique_event_id(sequence, &mut known_ids)?);
    }
    let correlation_id = event_ids.first().cloned().ok_or_else(|| {
        RunEngineError::Invariant("a reduced command produced no event IDs".to_string())
    })?;

    intents
        .iter()
        .zip(event_ids.iter())
        .enumerate()
        .map(|(index, (intent, event_id))| {
            let offset = u64::try_from(index).map_err(|_| {
                RunEngineError::Invariant("event batch index exceeds u64".to_string())
            })?;
            let sequence = expected_sequence
                .checked_add(offset)
                .and_then(|value| value.checked_add(1))
                .ok_or_else(|| RunEngineError::Invariant("event sequence overflow".to_string()))?;
            let causation_id = if index == 0 {
                loaded.last().map(|event| event.event_id.clone())
            } else {
                Some(event_ids[index - 1].clone())
            };
            Ok(RunEvent {
                protocol_version: ProtocolVersion::CURRENT,
                run_id: run_id.clone(),
                event_id: event_id.clone(),
                sequence,
                task_id: intent.task_id.clone(),
                agent_id: intent.agent_id.clone(),
                causation_id,
                correlation_id: correlation_id.clone(),
                occurred_at,
                payload: intent.payload.clone(),
                evidence_refs: intent.evidence_refs.clone(),
            })
        })
        .collect()
}

fn unique_event_id(
    sequence: u64,
    known_ids: &mut HashSet<EventId>,
) -> Result<EventId, RunEngineError> {
    let mut attempt = 0_u64;
    loop {
        let candidate = if attempt == 0 {
            format!("event:{sequence}")
        } else {
            format!("event:{sequence}:{attempt}")
        };
        let event_id = EventId::new(candidate).map_err(|error| {
            RunEngineError::Invariant(format!("generated event ID is invalid: {error}"))
        })?;
        if known_ids.insert(event_id.clone()) {
            return Ok(event_id);
        }
        attempt = attempt
            .checked_add(1)
            .ok_or_else(|| RunEngineError::Invariant("event ID attempts overflowed".to_string()))?;
    }
}

fn preview_projection(
    current: Option<RunProjection>,
    events: &[RunEvent],
) -> Result<RunProjection, ProjectionError> {
    if let Some(mut projection) = current {
        for event in events {
            projection.apply(event)?;
        }
        Ok(projection)
    } else {
        RunProjection::rebuild(events)
    }
}

fn verify_append_receipt(
    receipt: &AppendReceipt,
    expected_sequence: u64,
    events: &[RunEvent],
) -> Result<(), RunEngineError> {
    let last_sequence = events
        .last()
        .map_or(expected_sequence, |event| event.sequence);
    if receipt.previous_sequence != expected_sequence
        || receipt.last_sequence != last_sequence
        || receipt.appended != events.len()
    {
        return Err(RunEngineError::Invariant(format!(
            "append receipt mismatch: previous={}, last={}, appended={}",
            receipt.previous_sequence, receipt.last_sequence, receipt.appended
        )));
    }
    Ok(())
}

fn bind_effects(
    intents: &[super::EffectIntent],
    events: &[RunEvent],
) -> Result<Vec<CommittedControlEffect>, RunEngineError> {
    intents
        .iter()
        .enumerate()
        .map(|(effect_index, intent)| {
            let trigger = events.get(intent.trigger_event_index).ok_or_else(|| {
                RunEngineError::Invariant(format!(
                    "effect {effect_index} refers to missing event {}",
                    intent.trigger_event_index
                ))
            })?;
            let effect_id = format!("effect:{}:{effect_index}", trigger.sequence);
            EventId::new(effect_id.clone()).map_err(|error| {
                RunEngineError::Invariant(format!("generated effect ID is invalid: {error}"))
            })?;
            Ok(CommittedControlEffect {
                effect_id,
                trigger_event_id: trigger.event_id.clone(),
                effect: intent.effect.clone(),
            })
        })
        .collect()
}
