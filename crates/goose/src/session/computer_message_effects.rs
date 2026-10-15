use anyhow::{bail, ensure, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnection, SqliteRow};
use sqlx::{Connection, Pool, Row, Sqlite};

const MAX_IDENTITY_FIELD_BYTES: usize = 512;
const MAX_BASELINE_BYTES: usize = 64 * 1024;
const UNRESOLVED_INDEX_NAME: &str = "ux_computer_message_effects_unresolved_fence";
const EFFECTS_TABLE_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS computer_message_effects (
        checkpoint_id TEXT PRIMARY KEY NOT NULL,
        effect_key TEXT NOT NULL UNIQUE,
        replay_key TEXT NOT NULL,
        unresolved_fence_key TEXT,
        origin_session_id TEXT NOT NULL,
        intent_occurrence_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        account_hash TEXT,
        identity_strength TEXT NOT NULL CHECK(identity_strength IN ('strong','weak')),
        conversation_hash TEXT,
        recipient_hash TEXT,
        message_hash TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','dispatching','sent','undeliverable','unknown','abandoned')),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        backend_owner_id TEXT,
        attempt_id TEXT,
        adapter_id TEXT,
        adapter_version TEXT,
        baseline_json TEXT,
        proof_digest TEXT,
        evidence_digest TEXT,
        resolution_source TEXT CHECK(resolution_source IS NULL OR resolution_source IN ('adapter','human')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(
            (identity_strength = 'strong' AND conversation_hash IS NOT NULL AND recipient_hash IS NOT NULL)
            OR (identity_strength = 'weak' AND conversation_hash IS NULL AND recipient_hash IS NULL)
        ),
        CHECK(
            (state IN ('prepared','abandoned') AND unresolved_fence_key IS NULL
                AND backend_owner_id IS NOT NULL AND attempt_id IS NULL
                AND adapter_id IS NULL AND adapter_version IS NULL
                AND baseline_json IS NULL)
            OR (state IN ('dispatching','unknown') AND unresolved_fence_key IS NOT NULL
                AND backend_owner_id IS NOT NULL AND attempt_id IS NOT NULL
                AND adapter_id IS NOT NULL AND adapter_version IS NOT NULL
                AND baseline_json IS NOT NULL)
            OR (state IN ('sent','undeliverable') AND unresolved_fence_key IS NULL
                AND proof_digest IS NOT NULL AND evidence_digest IS NOT NULL
                AND resolution_source IS NOT NULL)
        )
    )
"#;
const EVENTS_TABLE_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS computer_message_effect_events (
        event_id INTEGER PRIMARY KEY,
        checkpoint_id TEXT NOT NULL REFERENCES computer_message_effects(checkpoint_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision >= 0),
        from_state TEXT CHECK(from_state IS NULL OR from_state IN ('prepared','dispatching','sent','undeliverable','unknown','abandoned')),
        to_state TEXT NOT NULL CHECK(to_state IN ('prepared','dispatching','sent','undeliverable','unknown','abandoned')),
        actor_id TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        evidence_digest TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(checkpoint_id, revision)
    )
"#;
const UNRESOLVED_INDEX_SQL: &str =
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_computer_message_effects_unresolved_fence \
     ON computer_message_effects(unresolved_fence_key) \
     WHERE unresolved_fence_key IS NOT NULL AND state IN ('dispatching','unknown')";

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "awaiting ComputerClient persistence consumer; remove with that integration"
    )
)]
pub(crate) enum MessageTargetIdentity {
    Strong {
        conversation_hash: String,
        recipient_hash: String,
    },
    Weak {
        lane_hash: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MessageEffectIntent {
    pub(crate) origin_session_id: String,
    pub(crate) intent_occurrence_id: String,
    pub(crate) backend_owner_id: String,
    pub(crate) app_id: String,
    pub(crate) account_hash: Option<String>,
    pub(crate) target: MessageTargetIdentity,
    pub(crate) message_hash: String,
    pub(crate) source_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MessageEffectKeys {
    pub(crate) effect_key: String,
    pub(crate) replay_key: String,
    pub(crate) unresolved_fence_key: String,
}

impl MessageEffectIntent {
    pub(crate) fn derive_keys(&self) -> Result<MessageEffectKeys> {
        validate_field("origin session", &self.origin_session_id)?;
        validate_field("intent occurrence", &self.intent_occurrence_id)?;
        validate_field("backend owner id", &self.backend_owner_id)?;
        validate_field("app id", &self.app_id)?;
        validate_optional_field("account hash", self.account_hash.as_deref())?;
        validate_field("message hash", &self.message_hash)?;
        validate_field("source hash", &self.source_hash)?;

        let mut replay_parts = vec![
            "message-replay-v1",
            self.app_id.as_str(),
            self.account_hash.as_deref().unwrap_or("<unknown-account>"),
        ];
        match &self.target {
            MessageTargetIdentity::Strong {
                conversation_hash,
                recipient_hash,
            } => {
                validate_field("conversation hash", conversation_hash)?;
                validate_field("recipient hash", recipient_hash)?;
                replay_parts.extend([conversation_hash.as_str(), recipient_hash.as_str()]);
            }
            MessageTargetIdentity::Weak { lane_hash } => {
                validate_field("weak lane hash", lane_hash)?;
                replay_parts.extend(["<weak-conversation>", "<weak-recipient>"]);
            }
        }
        replay_parts.extend([self.message_hash.as_str(), self.source_hash.as_str()]);
        let content_replay_key = digest_parts(&replay_parts);
        let replay_key = match &self.target {
            MessageTargetIdentity::Strong { .. } => content_replay_key.clone(),
            MessageTargetIdentity::Weak { .. } => digest_parts(&[
                "message-weak-fence-v1",
                self.app_id.as_str(),
                self.account_hash.as_deref().unwrap_or("<unknown-account>"),
            ]),
        };
        let effect_key = digest_parts(&[
            "message-effect-v1",
            content_replay_key.as_str(),
            self.intent_occurrence_id.as_str(),
        ]);
        let unresolved_fence_key = replay_key.clone();
        Ok(MessageEffectKeys {
            effect_key,
            replay_key,
            unresolved_fence_key,
        })
    }
}

fn validate_field(name: &str, value: &str) -> Result<()> {
    ensure!(!value.trim().is_empty(), "{name} must not be empty");
    ensure!(
        value.len() <= MAX_IDENTITY_FIELD_BYTES,
        "{name} exceeds {MAX_IDENTITY_FIELD_BYTES} bytes"
    );
    Ok(())
}

fn validate_optional_field(name: &str, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        validate_field(name, value)?;
    }
    Ok(())
}

fn digest_parts(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.len().to_be_bytes());
        digest.update(part.as_bytes());
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MessageEffectState {
    Prepared,
    Dispatching,
    Sent,
    Undeliverable,
    Unknown,
    Abandoned,
}

impl MessageEffectState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Dispatching => "dispatching",
            Self::Sent => "sent",
            Self::Undeliverable => "undeliverable",
            Self::Unknown => "unknown",
            Self::Abandoned => "abandoned",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "prepared" => Ok(Self::Prepared),
            "dispatching" => Ok(Self::Dispatching),
            "sent" => Ok(Self::Sent),
            "undeliverable" => Ok(Self::Undeliverable),
            "unknown" => Ok(Self::Unknown),
            "abandoned" => Ok(Self::Abandoned),
            _ => bail!("invalid message effect state: {value}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum DispatchBaseline {
    MonotonicCursor {
        adapter_id: String,
        adapter_version: String,
        cursor: String,
    },
    CompleteMessageIds {
        adapter_id: String,
        adapter_version: String,
        message_ids: Vec<String>,
    },
}

impl DispatchBaseline {
    fn adapter(&self) -> (&str, &str) {
        match self {
            Self::MonotonicCursor {
                adapter_id,
                adapter_version,
                ..
            }
            | Self::CompleteMessageIds {
                adapter_id,
                adapter_version,
                ..
            } => (adapter_id, adapter_version),
        }
    }

    fn to_bounded_json(&self) -> Result<String> {
        let (adapter_id, adapter_version) = self.adapter();
        validate_field("adapter id", adapter_id)?;
        validate_field("adapter version", adapter_version)?;
        if let Self::CompleteMessageIds { message_ids, .. } = self {
            ensure!(
                message_ids.len() <= 4096,
                "baseline message id set is too large"
            );
            for message_id in message_ids {
                validate_field("baseline message id", message_id)?;
            }
        }
        let json = serde_json::to_string(self)?;
        ensure!(
            json.len() <= MAX_BASELINE_BYTES,
            "baseline JSON is too large"
        );
        Ok(json)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MessageEffectSnapshot {
    pub(crate) checkpoint_id: String,
    pub(crate) effect_key: String,
    pub(crate) replay_key: String,
    pub(crate) unresolved_fence_key: Option<String>,
    pub(crate) origin_session_id: String,
    pub(crate) app_id: String,
    pub(crate) message_hash: String,
    pub(crate) source_hash: String,
    pub(crate) state: MessageEffectState,
    pub(crate) revision: i64,
    pub(crate) backend_owner_id: Option<String>,
    pub(crate) attempt_id: Option<String>,
}

pub(crate) enum PreparedMessageEffect {
    Created(MessageEffectSnapshot),
    Blocked(MessageEffectSnapshot),
}

pub(crate) struct BeginDispatch {
    pub(crate) checkpoint_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) backend_owner_id: String,
    pub(crate) attempt_id: String,
    pub(crate) baseline: DispatchBaseline,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "awaiting ComputerClient persistence consumer; remove with that integration"
    )
)]
pub(crate) enum BeginDispatchOutcome {
    Ready {
        permit: DispatchExecutionPermit,
        effect: MessageEffectSnapshot,
    },
    Blocked(MessageEffectSnapshot),
}

pub(crate) struct DispatchExecutionPermit {
    authorization: DispatchExecutionAuthorization,
}

impl DispatchExecutionPermit {
    pub(crate) fn consume(self) -> DispatchExecutionAuthorization {
        self.authorization
    }
}

pub(crate) struct DispatchExecutionAuthorization {
    checkpoint_id: String,
    revision: i64,
}

impl DispatchExecutionAuthorization {
    pub(crate) fn checkpoint_id(&self) -> &str {
        &self.checkpoint_id
    }

    pub(crate) fn revision(&self) -> i64 {
        self.revision
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "awaiting ComputerClient persistence consumer; remove with that integration"
    )
)]
pub(crate) enum ResolutionSource {
    Adapter,
    Human,
}

impl ResolutionSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Adapter => "adapter",
            Self::Human => "human",
        }
    }
}

pub(crate) enum TerminalResolution {
    Sent {
        proof_digest: String,
        evidence_digest: String,
        source: ResolutionSource,
    },
    Undeliverable {
        proof_digest: String,
        evidence_digest: String,
        source: ResolutionSource,
    },
}

pub(crate) struct MessageEffectStore {
    pool: Pool<Sqlite>,
}

impl MessageEffectStore {
    pub(crate) fn new(pool: Pool<Sqlite>) -> Self {
        Self { pool }
    }

    pub(crate) async fn prepare(
        &self,
        intent: MessageEffectIntent,
    ) -> Result<PreparedMessageEffect> {
        let keys = intent.derive_keys()?;
        let mut connection = self.pool.acquire().await?;
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) =
            find_unresolved(&mut transaction, &keys.unresolved_fence_key).await?
        {
            transaction.commit().await?;
            return Ok(PreparedMessageEffect::Blocked(existing));
        }
        if let Some(existing) = find_by_effect_key(&mut transaction, &keys.effect_key).await? {
            if existing.state == MessageEffectState::Abandoned {
                let revision = existing.revision + 1;
                sqlx::query(
                    "UPDATE computer_message_effects SET state = 'prepared', revision = ?, \
                     backend_owner_id = ?, attempt_id = NULL, adapter_id = NULL, \
                     adapter_version = NULL, baseline_json = NULL, proof_digest = NULL, \
                     evidence_digest = NULL, resolution_source = NULL, updated_at = ? \
                     WHERE checkpoint_id = ? AND revision = ? AND state = 'abandoned'",
                )
                .bind(revision)
                .bind(&intent.backend_owner_id)
                .bind(Utc::now().timestamp_millis())
                .bind(&existing.checkpoint_id)
                .bind(existing.revision)
                .execute(&mut *transaction)
                .await?;
                insert_event(
                    &mut transaction,
                    MessageEffectEvent {
                        checkpoint_id: &existing.checkpoint_id,
                        revision,
                        from_state: Some(MessageEffectState::Abandoned),
                        to_state: MessageEffectState::Prepared,
                        actor_id: &intent.backend_owner_id,
                        reason_code: "reprepared_after_observation",
                        evidence_digest: None,
                    },
                )
                .await?;
                transaction.commit().await?;
                drop(connection);
                return Ok(PreparedMessageEffect::Created(
                    self.inspect(&existing.checkpoint_id)
                        .await?
                        .context("reprepared message effect disappeared after commit")?,
                ));
            }
            transaction.commit().await?;
            return Ok(PreparedMessageEffect::Blocked(existing));
        }

        let checkpoint_id = uuid::Uuid::now_v7().to_string();
        let now = Utc::now().timestamp_millis();
        let (identity_strength, conversation_hash, recipient_hash) = match intent.target {
            MessageTargetIdentity::Strong {
                conversation_hash,
                recipient_hash,
            } => ("strong", Some(conversation_hash), Some(recipient_hash)),
            MessageTargetIdentity::Weak { .. } => ("weak", None, None),
        };
        sqlx::query(
            r#"
            INSERT INTO computer_message_effects (
                checkpoint_id, effect_key, replay_key, unresolved_fence_key,
                origin_session_id, intent_occurrence_id, app_id, account_hash,
                identity_strength, conversation_hash, recipient_hash, message_hash,
                source_hash, state, revision, backend_owner_id, attempt_id,
                adapter_id, adapter_version, baseline_json, proof_digest,
                evidence_digest, resolution_source, created_at, updated_at
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0,
                      ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
            "#,
        )
        .bind(&checkpoint_id)
        .bind(&keys.effect_key)
        .bind(&keys.replay_key)
        .bind(&intent.origin_session_id)
        .bind(&intent.intent_occurrence_id)
        .bind(&intent.app_id)
        .bind(&intent.account_hash)
        .bind(identity_strength)
        .bind(conversation_hash)
        .bind(recipient_hash)
        .bind(&intent.message_hash)
        .bind(&intent.source_hash)
        .bind(&intent.backend_owner_id)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        insert_event(
            &mut transaction,
            MessageEffectEvent {
                checkpoint_id: &checkpoint_id,
                revision: 0,
                from_state: None,
                to_state: MessageEffectState::Prepared,
                actor_id: "host",
                reason_code: "prepared",
                evidence_digest: None,
            },
        )
        .await?;
        transaction.commit().await?;
        drop(connection);
        Ok(PreparedMessageEffect::Created(
            self.inspect(&checkpoint_id)
                .await?
                .context("prepared message effect disappeared after commit")?,
        ))
    }

    pub(crate) async fn begin_dispatch(
        &self,
        request: BeginDispatch,
    ) -> Result<BeginDispatchOutcome> {
        validate_field("backend owner id", &request.backend_owner_id)?;
        validate_field("attempt id", &request.attempt_id)?;
        let baseline_json = request.baseline.to_bounded_json()?;
        let (adapter_id, adapter_version) = request.baseline.adapter();
        let mut connection = self.pool.acquire().await?;
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
        let current = find_by_checkpoint(&mut transaction, &request.checkpoint_id)
            .await?
            .context("message effect checkpoint not found")?;
        if current.state != MessageEffectState::Prepared
            || current.revision != request.expected_revision
        {
            transaction.commit().await?;
            return Ok(BeginDispatchOutcome::Blocked(current));
        }
        if let Some(existing) =
            find_unresolved(&mut transaction, current.replay_key.as_str()).await?
        {
            if existing.checkpoint_id != current.checkpoint_id {
                transaction.commit().await?;
                return Ok(BeginDispatchOutcome::Blocked(existing));
            }
        }

        let revision = current.revision + 1;
        let now = Utc::now().timestamp_millis();
        let result = sqlx::query(
            r#"
            UPDATE computer_message_effects
            SET unresolved_fence_key = ?, state = 'dispatching', revision = ?,
                backend_owner_id = ?, attempt_id = ?, adapter_id = ?,
                adapter_version = ?, baseline_json = ?, updated_at = ?
            WHERE checkpoint_id = ? AND revision = ? AND state = 'prepared'
            "#,
        )
        .bind(&current.replay_key)
        .bind(revision)
        .bind(&request.backend_owner_id)
        .bind(&request.attempt_id)
        .bind(adapter_id)
        .bind(adapter_version)
        .bind(baseline_json)
        .bind(now)
        .bind(&request.checkpoint_id)
        .bind(request.expected_revision)
        .execute(&mut *transaction)
        .await?;
        ensure!(
            result.rows_affected() == 1,
            "dispatch revision changed concurrently"
        );
        insert_event(
            &mut transaction,
            MessageEffectEvent {
                checkpoint_id: &request.checkpoint_id,
                revision,
                from_state: Some(MessageEffectState::Prepared),
                to_state: MessageEffectState::Dispatching,
                actor_id: &request.backend_owner_id,
                reason_code: "dispatch_committed",
                evidence_digest: None,
            },
        )
        .await?;
        transaction.commit().await?;
        drop(connection);

        let effect = self
            .inspect(&request.checkpoint_id)
            .await?
            .context("dispatching message effect disappeared after commit")?;
        Ok(BeginDispatchOutcome::Ready {
            permit: DispatchExecutionPermit {
                authorization: DispatchExecutionAuthorization {
                    checkpoint_id: request.checkpoint_id,
                    revision,
                },
            },
            effect,
        })
    }

    pub(crate) async fn mark_unknown(
        &self,
        checkpoint_id: &str,
        expected_revision: i64,
        evidence_digest: Option<&str>,
        reason: &str,
    ) -> Result<MessageEffectSnapshot> {
        self.transition_nonterminal(
            checkpoint_id,
            expected_revision,
            MessageEffectState::Unknown,
            evidence_digest,
            reason,
        )
        .await
    }

    async fn transition_nonterminal(
        &self,
        checkpoint_id: &str,
        expected_revision: i64,
        target: MessageEffectState,
        evidence_digest: Option<&str>,
        reason: &str,
    ) -> Result<MessageEffectSnapshot> {
        ensure!(
            target == MessageEffectState::Unknown,
            "unsupported transition"
        );
        validate_optional_field("evidence digest", evidence_digest)?;
        validate_field("transition reason", reason)?;
        let mut connection = self.pool.acquire().await?;
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
        let current = find_by_checkpoint(&mut transaction, checkpoint_id)
            .await?
            .context("message effect checkpoint not found")?;
        ensure!(
            current.state == MessageEffectState::Dispatching
                && current.revision == expected_revision,
            "message effect is not the expected dispatch"
        );
        let revision = current.revision + 1;
        sqlx::query(
            "UPDATE computer_message_effects SET state = 'unknown', revision = ?, \
             evidence_digest = ?, updated_at = ? WHERE checkpoint_id = ? AND revision = ?",
        )
        .bind(revision)
        .bind(evidence_digest)
        .bind(Utc::now().timestamp_millis())
        .bind(checkpoint_id)
        .bind(expected_revision)
        .execute(&mut *transaction)
        .await?;
        insert_event(
            &mut transaction,
            MessageEffectEvent {
                checkpoint_id,
                revision,
                from_state: Some(current.state),
                to_state: target,
                actor_id: current.backend_owner_id.as_deref().unwrap_or("host"),
                reason_code: reason,
                evidence_digest,
            },
        )
        .await?;
        transaction.commit().await?;
        drop(connection);
        self.inspect(checkpoint_id)
            .await?
            .context("unknown message effect disappeared after commit")
    }

    pub(crate) async fn resolve_terminal(
        &self,
        checkpoint_id: &str,
        expected_revision: i64,
        resolution: TerminalResolution,
    ) -> Result<MessageEffectSnapshot> {
        let (target, proof_digest, evidence_digest, source) = match resolution {
            TerminalResolution::Sent {
                proof_digest,
                evidence_digest,
                source,
            } => (
                MessageEffectState::Sent,
                proof_digest,
                evidence_digest,
                source,
            ),
            TerminalResolution::Undeliverable {
                proof_digest,
                evidence_digest,
                source,
            } => (
                MessageEffectState::Undeliverable,
                proof_digest,
                evidence_digest,
                source,
            ),
        };
        validate_field("proof digest", &proof_digest)?;
        validate_field("evidence digest", &evidence_digest)?;
        let mut connection = self.pool.acquire().await?;
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
        let current = find_by_checkpoint(&mut transaction, checkpoint_id)
            .await?
            .context("message effect checkpoint not found")?;
        ensure!(
            matches!(
                current.state,
                MessageEffectState::Dispatching | MessageEffectState::Unknown
            ) && current.revision == expected_revision,
            "message effect is not resolvable at the expected revision"
        );
        let revision = current.revision + 1;
        sqlx::query(
            "UPDATE computer_message_effects SET unresolved_fence_key = NULL, state = ?, \
             revision = ?, proof_digest = ?, evidence_digest = ?, resolution_source = ?, \
             updated_at = ? WHERE checkpoint_id = ? AND revision = ?",
        )
        .bind(target.as_str())
        .bind(revision)
        .bind(&proof_digest)
        .bind(&evidence_digest)
        .bind(source.as_str())
        .bind(Utc::now().timestamp_millis())
        .bind(checkpoint_id)
        .bind(expected_revision)
        .execute(&mut *transaction)
        .await?;
        insert_event(
            &mut transaction,
            MessageEffectEvent {
                checkpoint_id,
                revision,
                from_state: Some(current.state),
                to_state: target,
                actor_id: source.as_str(),
                reason_code: "resolved",
                evidence_digest: Some(&evidence_digest),
            },
        )
        .await?;
        transaction.commit().await?;
        drop(connection);
        self.inspect(checkpoint_id)
            .await?
            .context("terminal message effect disappeared after commit")
    }

    pub(crate) async fn recover_for_backend(
        &self,
        current_backend_owner_id: &str,
        owner_is_alive: impl Fn(&str) -> bool,
    ) -> Result<Vec<MessageEffectSnapshot>> {
        validate_field("backend owner id", current_backend_owner_id)?;
        let mut connection = self.pool.acquire().await?;
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
        let rows = sqlx::query(
            "SELECT * FROM computer_message_effects \
             WHERE state IN ('prepared','dispatching') AND backend_owner_id <> ?",
        )
        .bind(current_backend_owner_id)
        .fetch_all(&mut *transaction)
        .await?;
        let mut recovered = Vec::with_capacity(rows.len());
        for row in rows {
            let current = decode_effect(&row)?;
            if current
                .backend_owner_id
                .as_deref()
                .is_some_and(&owner_is_alive)
            {
                continue;
            }
            let revision = current.revision + 1;
            let target = if current.state == MessageEffectState::Prepared {
                MessageEffectState::Abandoned
            } else {
                MessageEffectState::Unknown
            };
            sqlx::query(
                "UPDATE computer_message_effects SET state = ?, revision = ?, \
                 updated_at = ? WHERE checkpoint_id = ? AND revision = ? AND state = ?",
            )
            .bind(target.as_str())
            .bind(revision)
            .bind(Utc::now().timestamp_millis())
            .bind(&current.checkpoint_id)
            .bind(current.revision)
            .bind(current.state.as_str())
            .execute(&mut *transaction)
            .await?;
            insert_event(
                &mut transaction,
                MessageEffectEvent {
                    checkpoint_id: &current.checkpoint_id,
                    revision,
                    from_state: Some(current.state),
                    to_state: target,
                    actor_id: current_backend_owner_id,
                    reason_code: "backend_recovery",
                    evidence_digest: None,
                },
            )
            .await?;
            recovered.push(MessageEffectSnapshot {
                state: target,
                revision,
                ..current
            });
        }
        transaction.commit().await?;
        Ok(recovered)
    }

    pub(crate) async fn inspect(
        &self,
        checkpoint_id: &str,
    ) -> Result<Option<MessageEffectSnapshot>> {
        let row = sqlx::query("SELECT * FROM computer_message_effects WHERE checkpoint_id = ?")
            .bind(checkpoint_id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(decode_effect).transpose()
    }
}

async fn find_by_checkpoint(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    checkpoint_id: &str,
) -> Result<Option<MessageEffectSnapshot>> {
    let row = sqlx::query("SELECT * FROM computer_message_effects WHERE checkpoint_id = ?")
        .bind(checkpoint_id)
        .fetch_optional(&mut **transaction)
        .await?;
    row.as_ref().map(decode_effect).transpose()
}

async fn find_by_effect_key(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    effect_key: &str,
) -> Result<Option<MessageEffectSnapshot>> {
    let row = sqlx::query("SELECT * FROM computer_message_effects WHERE effect_key = ?")
        .bind(effect_key)
        .fetch_optional(&mut **transaction)
        .await?;
    row.as_ref().map(decode_effect).transpose()
}

async fn find_unresolved(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    fence_key: &str,
) -> Result<Option<MessageEffectSnapshot>> {
    let row = sqlx::query(
        "SELECT * FROM computer_message_effects WHERE unresolved_fence_key = ? \
         AND state IN ('dispatching','unknown')",
    )
    .bind(fence_key)
    .fetch_optional(&mut **transaction)
    .await?;
    row.as_ref().map(decode_effect).transpose()
}

fn decode_effect(row: &SqliteRow) -> Result<MessageEffectSnapshot> {
    let state = MessageEffectState::parse(row.try_get("state")?)?;
    let unresolved_fence_key: Option<String> = row.try_get("unresolved_fence_key")?;
    let backend_owner_id: Option<String> = row.try_get("backend_owner_id")?;
    let attempt_id: Option<String> = row.try_get("attempt_id")?;
    let baseline_json: Option<String> = row.try_get("baseline_json")?;
    let proof_digest: Option<String> = row.try_get("proof_digest")?;
    let resolution_source: Option<String> = row.try_get("resolution_source")?;
    let valid = match state {
        MessageEffectState::Prepared | MessageEffectState::Abandoned => {
            unresolved_fence_key.is_none()
                && backend_owner_id.is_some()
                && attempt_id.is_none()
                && baseline_json.is_none()
        }
        MessageEffectState::Dispatching | MessageEffectState::Unknown => {
            unresolved_fence_key.is_some()
                && backend_owner_id.is_some()
                && attempt_id.is_some()
                && baseline_json.is_some()
        }
        MessageEffectState::Sent | MessageEffectState::Undeliverable => {
            unresolved_fence_key.is_none() && proof_digest.is_some() && resolution_source.is_some()
        }
    };
    ensure!(
        valid,
        "invalid message effect row for state {}",
        state.as_str()
    );
    if let Some(baseline_json) = baseline_json {
        ensure!(
            baseline_json.len() <= MAX_BASELINE_BYTES,
            "invalid message effect row: baseline JSON is too large"
        );
        serde_json::from_str::<DispatchBaseline>(&baseline_json)
            .context("invalid message effect row: malformed baseline JSON")?;
    }
    Ok(MessageEffectSnapshot {
        checkpoint_id: row.try_get("checkpoint_id")?,
        effect_key: row.try_get("effect_key")?,
        replay_key: row.try_get("replay_key")?,
        unresolved_fence_key,
        origin_session_id: row.try_get("origin_session_id")?,
        app_id: row.try_get("app_id")?,
        message_hash: row.try_get("message_hash")?,
        source_hash: row.try_get("source_hash")?,
        state,
        revision: row.try_get("revision")?,
        backend_owner_id,
        attempt_id,
    })
}

struct MessageEffectEvent<'a> {
    checkpoint_id: &'a str,
    revision: i64,
    from_state: Option<MessageEffectState>,
    to_state: MessageEffectState,
    actor_id: &'a str,
    reason_code: &'a str,
    evidence_digest: Option<&'a str>,
}

async fn insert_event(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    event: MessageEffectEvent<'_>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO computer_message_effect_events (
            checkpoint_id, revision, from_state, to_state, actor_id,
            reason_code, evidence_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(event.checkpoint_id)
    .bind(event.revision)
    .bind(event.from_state.map(MessageEffectState::as_str))
    .bind(event.to_state.as_str())
    .bind(event.actor_id)
    .bind(event.reason_code)
    .bind(event.evidence_digest)
    .bind(Utc::now().timestamp_millis())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub(super) async fn create_schema_v16(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
) -> Result<()> {
    sqlx::query(EFFECTS_TABLE_SQL)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(UNRESOLVED_INDEX_SQL)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(EVENTS_TABLE_SQL)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub(super) async fn attest_connection_pragmas(connection: &mut SqliteConnection) -> Result<()> {
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *connection)
        .await?;
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&mut *connection)
        .await?;
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&mut *connection)
        .await?;
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&mut *connection)
        .await?;
    ensure!(
        journal_mode.eq_ignore_ascii_case("wal"),
        "journal_mode is not WAL"
    );
    ensure!(synchronous == 2, "synchronous is not FULL");
    ensure!(foreign_keys == 1, "foreign_keys is not enabled");
    ensure!(busy_timeout == 30_000, "busy_timeout is not 30000ms");
    Ok(())
}

pub(super) async fn attest_schema_v16(pool: &Pool<Sqlite>) -> Result<()> {
    let quick_check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(pool)
        .await?;
    ensure!(
        quick_check == "ok",
        "SQLite quick_check failed: {quick_check}"
    );

    attest_columns(
        pool,
        "computer_message_effects",
        &[
            ("checkpoint_id", "TEXT", 1, 1),
            ("effect_key", "TEXT", 1, 0),
            ("replay_key", "TEXT", 1, 0),
            ("unresolved_fence_key", "TEXT", 0, 0),
            ("origin_session_id", "TEXT", 1, 0),
            ("intent_occurrence_id", "TEXT", 1, 0),
            ("app_id", "TEXT", 1, 0),
            ("account_hash", "TEXT", 0, 0),
            ("identity_strength", "TEXT", 1, 0),
            ("conversation_hash", "TEXT", 0, 0),
            ("recipient_hash", "TEXT", 0, 0),
            ("message_hash", "TEXT", 1, 0),
            ("source_hash", "TEXT", 1, 0),
            ("state", "TEXT", 1, 0),
            ("revision", "INTEGER", 1, 0),
            ("backend_owner_id", "TEXT", 0, 0),
            ("attempt_id", "TEXT", 0, 0),
            ("adapter_id", "TEXT", 0, 0),
            ("adapter_version", "TEXT", 0, 0),
            ("baseline_json", "TEXT", 0, 0),
            ("proof_digest", "TEXT", 0, 0),
            ("evidence_digest", "TEXT", 0, 0),
            ("resolution_source", "TEXT", 0, 0),
            ("created_at", "INTEGER", 1, 0),
            ("updated_at", "INTEGER", 1, 0),
        ],
    )
    .await?;
    attest_columns(
        pool,
        "computer_message_effect_events",
        &[
            ("event_id", "INTEGER", 0, 1),
            ("checkpoint_id", "TEXT", 1, 0),
            ("revision", "INTEGER", 1, 0),
            ("from_state", "TEXT", 0, 0),
            ("to_state", "TEXT", 1, 0),
            ("actor_id", "TEXT", 1, 0),
            ("reason_code", "TEXT", 1, 0),
            ("evidence_digest", "TEXT", 0, 0),
            ("created_at", "INTEGER", 1, 0),
        ],
    )
    .await?;

    attest_unique_index(pool, "computer_message_effects", &["effect_key"]).await?;
    attest_unique_index(
        pool,
        "computer_message_effect_events",
        &["checkpoint_id", "revision"],
    )
    .await?;
    attest_table_body(pool, "computer_message_effects", EFFECTS_TABLE_SQL).await?;
    attest_table_body(pool, "computer_message_effect_events", EVENTS_TABLE_SQL).await?;

    let index_sql: Option<String> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
            .bind(UNRESOLVED_INDEX_NAME)
            .fetch_optional(pool)
            .await?;
    let actual_index = canonical_index_tokens(
        index_sql
            .as_deref()
            .context("unresolved fence index is missing")?,
    )?;
    let expected_index = canonical_index_tokens(UNRESOLVED_INDEX_SQL)?;
    ensure!(
        actual_index == expected_index,
        "unresolved fence index does not match the v16 contract"
    );
    let index_columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
            .bind(UNRESOLVED_INDEX_NAME)
            .fetch_all(pool)
            .await?;
    ensure!(
        index_columns == ["unresolved_fence_key"],
        "unresolved fence index columns do not match the v16 contract"
    );

    let foreign_keys = sqlx::query(
        "SELECT \"table\", \"from\", \"to\", on_delete \
         FROM pragma_foreign_key_list('computer_message_effect_events')",
    )
    .fetch_all(pool)
    .await?;
    ensure!(
        foreign_keys.len() == 1,
        "message effect event foreign key mismatch"
    );
    let foreign_key = &foreign_keys[0];
    ensure!(
        foreign_key.try_get::<String, _>("table")? == "computer_message_effects"
            && foreign_key.try_get::<String, _>("from")? == "checkpoint_id"
            && foreign_key.try_get::<String, _>("to")? == "checkpoint_id"
            && foreign_key
                .try_get::<String, _>("on_delete")?
                .eq_ignore_ascii_case("restrict"),
        "message effect event foreign key mismatch"
    );
    let effects_foreign_key_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_foreign_key_list('computer_message_effects')",
    )
    .fetch_one(pool)
    .await?;
    ensure!(
        effects_foreign_key_count == 0,
        "message effects must not cascade with sessions"
    );
    Ok(())
}

async fn attest_columns(
    pool: &Pool<Sqlite>,
    table: &str,
    expected: &[(&str, &str, i64, i64)],
) -> Result<()> {
    let rows = sqlx::query(&format!("PRAGMA table_xinfo('{table}')"))
        .fetch_all(pool)
        .await?;
    ensure!(
        rows.len() == expected.len(),
        "{table} column count mismatch"
    );
    for (row, expected) in rows.iter().zip(expected.iter()) {
        let actual = (
            row.try_get::<String, _>("name")?,
            row.try_get::<String, _>("type")?,
            row.try_get::<i64, _>("notnull")?,
            row.try_get::<i64, _>("pk")?,
        );
        ensure!(
            actual.0 == expected.0
                && actual.1.eq_ignore_ascii_case(expected.1)
                && actual.2 == expected.2
                && actual.3 == expected.3,
            "{table} column contract mismatch at {}",
            expected.0
        );
    }
    Ok(())
}

async fn attest_table_body(pool: &Pool<Sqlite>, table: &str, expected_sql: &str) -> Result<()> {
    let sql: Option<String> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_optional(pool)
            .await?;
    let actual = canonical_table_tokens(
        sql.as_deref()
            .with_context(|| format!("{table} table is missing"))?,
    )?;
    let expected = canonical_table_tokens(expected_sql)?;
    ensure!(
        actual == expected,
        "{table} table contract is missing or changed"
    );
    Ok(())
}

async fn attest_unique_index(
    pool: &Pool<Sqlite>,
    table: &str,
    expected_columns: &[&str],
) -> Result<()> {
    let indexes = sqlx::query(&format!("PRAGMA index_list('{table}')"))
        .fetch_all(pool)
        .await?;
    for index in indexes {
        let unique: i64 = index.try_get("unique")?;
        let partial: i64 = index.try_get("partial")?;
        if unique != 1 || partial != 0 {
            continue;
        }
        let name: String = index.try_get("name")?;
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
                .bind(name)
                .fetch_all(pool)
                .await?;
        if columns
            .iter()
            .map(String::as_str)
            .eq(expected_columns.iter().copied())
        {
            return Ok(());
        }
    }
    bail!("{table} UNIQUE contract is missing or changed")
}

fn canonical_index_tokens(sql: &str) -> Result<Vec<String>> {
    let wrapped = format!("CREATE TABLE controlled_index ({sql})");
    let tokens = canonical_table_tokens(&wrapped)?;
    let mut canonical = Vec::with_capacity(tokens.len());
    let mut index = 0;
    while index < tokens.len() {
        canonical.push(tokens[index].clone());
        if tokens[index] == "word:index"
            && tokens.get(index + 1).map(String::as_str) == Some("word:if")
            && tokens.get(index + 2).map(String::as_str) == Some("word:not")
            && tokens.get(index + 3).map(String::as_str) == Some("word:exists")
        {
            index += 4;
        } else {
            index += 1;
        }
    }
    Ok(canonical)
}

fn canonical_table_tokens(sql: &str) -> Result<Vec<String>> {
    let mut characters = sql.chars().peekable();
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut in_string = false;
    let mut string_literal = String::new();
    let mut body_started = false;
    let mut body_finished = false;
    let mut depth = 0_i32;

    while let Some(character) = characters.next() {
        if in_string {
            string_literal.push(character);
            if character == '\'' {
                if characters.peek() == Some(&'\'') {
                    string_literal.push(characters.next().expect("peeked quote exists"));
                } else {
                    in_string = false;
                    tokens.push(format!("literal:{string_literal}"));
                    string_literal.clear();
                }
            }
            continue;
        }

        if body_finished {
            ensure!(
                character.is_ascii_whitespace() || character == ';',
                "table SQL has unsupported trailing tokens"
            );
            continue;
        }

        if character == '-' && characters.peek() == Some(&'-') {
            bail!("SQL comments are not allowed in the v16 table contract");
        }
        if character == '/' && characters.peek() == Some(&'*') {
            bail!("SQL comments are not allowed in the v16 table contract");
        }
        if character == '\'' {
            ensure!(body_started, "table SQL contains a string before its body");
            flush_schema_word(&mut word, &mut tokens);
            in_string = true;
            string_literal.push(character);
            continue;
        }
        if !body_started {
            if character == '(' {
                body_started = true;
                depth = 1;
                tokens.push("punct:(".to_string());
            }
            continue;
        }
        if character.is_ascii_alphanumeric() || character == '_' {
            word.push(character.to_ascii_lowercase());
            continue;
        }
        flush_schema_word(&mut word, &mut tokens);
        match character {
            '(' => {
                depth += 1;
                tokens.push("punct:(".to_string());
            }
            ')' => {
                depth -= 1;
                ensure!(depth >= 0, "table SQL has unbalanced parentheses");
                tokens.push("punct:)".to_string());
                if depth == 0 {
                    body_finished = true;
                }
            }
            '"' | '`' | '[' | ']' => {
                bail!("quoted identifiers are not allowed in the v16 table contract");
            }
            value if value.is_ascii_whitespace() => {}
            ',' => tokens.push("punct:,".to_string()),
            '=' => tokens.push("operator:=".to_string()),
            '>' | '<' | '!' => {
                let mut operator = character.to_string();
                if characters.peek() == Some(&'=') {
                    operator.push(characters.next().expect("peeked equals exists"));
                }
                tokens.push(format!("operator:{operator}"));
            }
            ';' => bail!("table SQL body ended before its closing parenthesis"),
            _ => bail!("unsupported token in the v16 table contract"),
        }
    }
    ensure!(body_started, "table SQL body is missing");
    flush_schema_word(&mut word, &mut tokens);
    ensure!(!in_string, "table SQL has an unterminated string literal");
    ensure!(
        body_finished && depth == 0,
        "table SQL has unbalanced parentheses"
    );
    Ok(tokens)
}

fn flush_schema_word(word: &mut String, tokens: &mut Vec<String>) {
    if !word.is_empty() {
        tokens.push(format!("word:{word}"));
        word.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Connection, SqlitePool};
    use std::io::{BufRead, BufReader, Write};
    use std::path::Path;
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::str::FromStr;
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    const DISPATCHING_CHILD_TEST: &str = "session::session_manager::computer_message_effects::tests::dispatching_child_process_fixture";
    const DISPATCHING_CHILD_MODE_ENV: &str = "CODEPRO_MESSAGE_EFFECT_CHILD_MODE";
    const DISPATCHING_CHILD_DATABASE_ENV: &str = "CODEPRO_MESSAGE_EFFECT_CHILD_DATABASE";
    const DISPATCHING_CHILD_READY: &str = "CODEPRO_MESSAGE_EFFECT_CHILD_READY";

    struct SpawnedTestChild(Option<Child>);

    impl SpawnedTestChild {
        fn child_mut(&mut self) -> &mut Child {
            self.0.as_mut().expect("spawned child is still owned")
        }

        fn terminate_and_wait(mut self) -> ExitStatus {
            let mut child = self.0.take().expect("spawned child is still owned");
            child.kill().expect("terminate the exact spawned child");
            child.wait().expect("wait for the exact spawned child")
        }
    }

    impl Drop for SpawnedTestChild {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    fn strong_intent(occurrence: &str, session: &str) -> MessageEffectIntent {
        MessageEffectIntent {
            origin_session_id: session.to_string(),
            intent_occurrence_id: occurrence.to_string(),
            backend_owner_id: "backend-1".to_string(),
            app_id: "wechat.desktop".to_string(),
            account_hash: Some("account-a".to_string()),
            target: MessageTargetIdentity::Strong {
                conversation_hash: "conversation-a".to_string(),
                recipient_hash: "recipient-a".to_string(),
            },
            message_hash: "message-a".to_string(),
            source_hash: "source-a".to_string(),
        }
    }

    fn baseline() -> DispatchBaseline {
        DispatchBaseline::MonotonicCursor {
            adapter_id: "wechat-uia".to_string(),
            adapter_version: "1".to_string(),
            cursor: "42".to_string(),
        }
    }

    async fn open_pool(path: &Path) -> SqlitePool {
        let options = SqliteConnectOptions::from_str(path.to_str().unwrap())
            .unwrap()
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Full)
            .busy_timeout(std::time::Duration::from_secs(30));
        SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap()
    }

    async fn temp_pool() -> (TempDir, SqlitePool) {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("message-effects.db");
        let pool = open_pool(&path).await;
        let mut connection = pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        create_schema_v16(&mut transaction).await.unwrap();
        transaction.commit().await.unwrap();
        attest_schema_v16(&pool).await.unwrap();
        drop(connection);
        (directory, pool)
    }

    async fn effect_row_snapshot(pool: &SqlitePool, checkpoint_id: &str) -> String {
        sqlx::query_scalar(
            r#"
            SELECT json_object(
                'checkpoint_id', checkpoint_id,
                'effect_key', effect_key,
                'replay_key', replay_key,
                'unresolved_fence_key', unresolved_fence_key,
                'origin_session_id', origin_session_id,
                'intent_occurrence_id', intent_occurrence_id,
                'app_id', app_id,
                'account_hash', account_hash,
                'identity_strength', identity_strength,
                'conversation_hash', conversation_hash,
                'recipient_hash', recipient_hash,
                'message_hash', message_hash,
                'source_hash', source_hash,
                'state', state,
                'revision', revision,
                'backend_owner_id', backend_owner_id,
                'attempt_id', attempt_id,
                'adapter_id', adapter_id,
                'adapter_version', adapter_version,
                'baseline_json', baseline_json,
                'proof_digest', proof_digest,
                'evidence_digest', evidence_digest,
                'resolution_source', resolution_source,
                'created_at', created_at,
                'updated_at', updated_at
            )
            FROM computer_message_effects
            WHERE checkpoint_id = ?
            "#,
        )
        .bind(checkpoint_id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn event_rows_snapshot(pool: &SqlitePool, checkpoint_id: &str) -> Vec<String> {
        sqlx::query_scalar(
            r#"
            SELECT json_object(
                'event_id', event_id,
                'checkpoint_id', checkpoint_id,
                'revision', revision,
                'from_state', from_state,
                'to_state', to_state,
                'actor_id', actor_id,
                'reason_code', reason_code,
                'evidence_digest', evidence_digest,
                'created_at', created_at
            )
            FROM computer_message_effect_events
            WHERE checkpoint_id = ?
            ORDER BY event_id
            "#,
        )
        .bind(checkpoint_id)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    async fn replace_schema_contract(
        pool: &SqlitePool,
        effects_replacement: Option<(&str, &str)>,
        events_replacement: Option<(&str, &str)>,
    ) {
        let effects_sql: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'computer_message_effects'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        let events_sql: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'computer_message_effect_events'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query("DROP TABLE computer_message_effect_events")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("DROP TABLE computer_message_effects")
            .execute(pool)
            .await
            .unwrap();
        let effects_sql = effects_replacement
            .map(|(from, to)| effects_sql.replace(from, to))
            .unwrap_or(effects_sql);
        let events_sql = events_replacement
            .map(|(from, to)| events_sql.replace(from, to))
            .unwrap_or(events_sql);
        sqlx::query(&effects_sql).execute(pool).await.unwrap();
        sqlx::query(UNRESOLVED_INDEX_SQL)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(&events_sql).execute(pool).await.unwrap();
    }

    #[test]
    fn occurrence_changes_effect_key_but_not_replay_key() {
        let first = strong_intent("turn-1", "session-1").derive_keys().unwrap();
        let second = strong_intent("turn-2", "session-2").derive_keys().unwrap();

        assert_ne!(first.effect_key, second.effect_key);
        assert_eq!(first.replay_key, second.replay_key);
        assert_eq!(first.unresolved_fence_key, second.unresolved_fence_key);
    }

    #[test]
    fn weak_identity_uses_account_lane_and_never_window_identity() {
        let mut first = strong_intent("turn-1", "session-1");
        first.target = MessageTargetIdentity::Weak {
            lane_hash: "display-name-zsy".to_string(),
        };
        let mut second = strong_intent("turn-2", "session-2");
        second.target = MessageTargetIdentity::Weak {
            lane_hash: "renamed-window-zsy".to_string(),
        };

        let first = first.derive_keys().unwrap();
        let second = second.derive_keys().unwrap();
        assert_eq!(first.unresolved_fence_key, second.unresolved_fence_key);

        let mut no_account_first = strong_intent("turn-1", "session-1");
        no_account_first.account_hash = None;
        no_account_first.target = MessageTargetIdentity::Weak {
            lane_hash: "window-100".to_string(),
        };
        let mut no_account_second = strong_intent("turn-2", "session-2");
        no_account_second.account_hash = None;
        no_account_second.target = MessageTargetIdentity::Weak {
            lane_hash: "window-200".to_string(),
        };
        assert_eq!(
            no_account_first.derive_keys().unwrap().unresolved_fence_key,
            no_account_second
                .derive_keys()
                .unwrap()
                .unresolved_fence_key
        );
    }

    #[tokio::test]
    async fn schema_attestation_accepts_sqlite_omitting_if_not_exists_from_index_sql() {
        let (_directory, pool) = temp_pool().await;
        let stored_sql: String =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
                .bind(UNRESOLVED_INDEX_NAME)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert!(!stored_sql.to_ascii_lowercase().contains("if not exists"));
        attest_schema_v16(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn schema_attestation_rejects_wrong_partial_index() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("wrong-schema.db");
        let pool = SqlitePoolOptions::new()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        let mut connection = pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        create_schema_v16(&mut transaction).await.unwrap();
        transaction.commit().await.unwrap();
        sqlx::query("DROP INDEX ux_computer_message_effects_unresolved_fence")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE UNIQUE INDEX ux_computer_message_effects_unresolved_fence \
             ON computer_message_effects(unresolved_fence_key)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let error = attest_schema_v16(&pool).await.unwrap_err().to_string();
        assert!(error.contains("unresolved fence index"), "{error}");
    }

    #[tokio::test]
    async fn schema_attestation_rejects_same_columns_without_required_check() {
        let (_directory, pool) = temp_pool().await;
        replace_schema_contract(
            &pool,
            Some(("CHECK(identity_strength IN ('strong','weak'))", "")),
            None,
        )
        .await;

        let error = attest_schema_v16(&pool).await.unwrap_err().to_string();
        assert!(error.contains("table contract"), "{error}");
    }

    #[tokio::test]
    async fn schema_attestation_rejects_required_check_text_hidden_in_sql_comment() {
        let (_directory, pool) = temp_pool().await;
        replace_schema_contract(
            &pool,
            Some((
                "CHECK(identity_strength IN ('strong','weak'))",
                "/* CHECK(identity_strength IN ('strong','weak')) */",
            )),
            None,
        )
        .await;

        let error = attest_schema_v16(&pool).await.unwrap_err().to_string();
        assert!(error.contains("SQL comments"), "{error}");
    }

    #[test]
    fn table_body_canonicalization_preserves_string_literal_meaning() {
        let upper = canonical_table_tokens("CREATE TABLE t (x TEXT CHECK(x = 'A B'))").unwrap();
        let lower = canonical_table_tokens("CREATE TABLE t (x TEXT CHECK(x = 'a b'))").unwrap();
        let collapsed = canonical_table_tokens("CREATE TABLE t (x TEXT CHECK(x = 'AB'))").unwrap();

        assert_ne!(upper, lower);
        assert_ne!(upper, collapsed);
    }

    #[test]
    fn table_body_tokens_reject_quoted_identifiers_and_preserve_word_boundaries() {
        assert!(canonical_table_tokens(
            "CREATE TABLE t (resolution_source TEXT CHECK(\"resolution_source\" IS NULL))"
        )
        .is_err());
        assert!(canonical_table_tokens(
            "CREATE TABLE t (resolution_source TEXT CHECK(`resolution_source` IS NULL))"
        )
        .is_err());
        assert!(canonical_table_tokens(
            "CREATE TABLE t (resolution_source TEXT CHECK([resolution_source] IS NULL))"
        )
        .is_err());

        let separate = canonical_table_tokens(
            "CREATE TABLE t (resolution_source TEXT CHECK(resolution_source IS NULL))",
        )
        .unwrap();
        let joined = canonical_table_tokens(
            "CREATE TABLE t (resolution_source TEXT CHECK(resolution_source ISNULL))",
        )
        .unwrap();
        assert_ne!(separate, joined);
    }

    #[tokio::test]
    async fn schema_attestation_rejects_or_true_constraint_weakening() {
        let (_directory, pool) = temp_pool().await;
        replace_schema_contract(
            &pool,
            Some((
                "CHECK(identity_strength IN ('strong','weak'))",
                "CHECK(identity_strength IN ('strong','weak') OR 1)",
            )),
            None,
        )
        .await;

        let error = attest_schema_v16(&pool).await.unwrap_err().to_string();
        assert!(error.contains("table contract"), "{error}");
    }

    #[tokio::test]
    async fn schema_attestation_rejects_missing_effect_key_unique() {
        let (_directory, pool) = temp_pool().await;
        replace_schema_contract(
            &pool,
            Some((
                "effect_key TEXT NOT NULL UNIQUE",
                "effect_key TEXT NOT NULL",
            )),
            None,
        )
        .await;

        let error = attest_schema_v16(&pool).await.unwrap_err().to_string();
        assert!(error.contains("UNIQUE contract"), "{error}");
    }

    #[tokio::test]
    async fn schema_attestation_rejects_missing_event_revision_unique() {
        let (_directory, pool) = temp_pool().await;
        replace_schema_contract(
            &pool,
            None,
            Some((",\n        UNIQUE(checkpoint_id, revision)", "")),
        )
        .await;

        let error = attest_schema_v16(&pool).await.unwrap_err().to_string();
        assert!(error.contains("UNIQUE contract"), "{error}");
    }

    #[tokio::test]
    async fn prepare_and_dispatch_commit_yields_one_single_use_permit() {
        let (_directory, pool) = temp_pool().await;
        let store = MessageEffectStore::new(pool.clone());
        let prepared = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap();
        let PreparedMessageEffect::Created(prepared) = prepared else {
            panic!("first prepare must create a checkpoint");
        };
        assert!(!prepared.effect_key.is_empty());
        assert!(!prepared.replay_key.is_empty());
        assert_eq!(prepared.unresolved_fence_key, None);
        assert_eq!(prepared.origin_session_id, "session-1");
        assert_eq!(prepared.backend_owner_id.as_deref(), Some("backend-1"));
        assert_eq!(prepared.attempt_id, None);

        let dispatch = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id.clone(),
                expected_revision: prepared.revision,
                backend_owner_id: "backend-1".to_string(),
                attempt_id: "attempt-1".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap();
        let BeginDispatchOutcome::Ready { permit, effect } = dispatch else {
            panic!("dispatch must be ready");
        };
        assert_eq!(effect.state, MessageEffectState::Dispatching);
        assert_eq!(
            effect.unresolved_fence_key.as_deref(),
            Some(effect.replay_key.as_str())
        );
        assert_eq!(effect.backend_owner_id.as_deref(), Some("backend-1"));
        assert_eq!(effect.attempt_id.as_deref(), Some("attempt-1"));
        let authorization = permit.consume();
        assert_eq!(authorization.checkpoint_id(), prepared.checkpoint_id);
        assert_eq!(authorization.revision(), effect.revision);

        let second = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id.clone(),
                expected_revision: prepared.revision,
                backend_owner_id: "backend-1".to_string(),
                attempt_id: "attempt-2".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap();
        let BeginDispatchOutcome::Blocked(blocked) = second else {
            panic!("stale revision must return the current checkpoint");
        };
        assert_eq!(blocked.checkpoint_id, prepared.checkpoint_id);
        assert_eq!(blocked.revision, effect.revision);
    }

    #[tokio::test]
    async fn unresolved_effect_blocks_same_message_across_sessions() {
        let (_directory, pool) = temp_pool().await;
        let store = MessageEffectStore::new(pool);
        let first = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap();
        let PreparedMessageEffect::Created(first) = first else {
            panic!("first prepare must create a checkpoint");
        };
        let dispatch = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: first.checkpoint_id,
                expected_revision: first.revision,
                backend_owner_id: "backend-1".to_string(),
                attempt_id: "attempt-1".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap();
        assert!(matches!(dispatch, BeginDispatchOutcome::Ready { .. }));

        let second = store
            .prepare(strong_intent("turn-2", "session-2"))
            .await
            .unwrap();
        let PreparedMessageEffect::Blocked(existing) = second else {
            panic!("unresolved dispatch must block a new session");
        };
        assert_eq!(existing.state, MessageEffectState::Dispatching);
    }

    #[tokio::test]
    async fn owner_mismatch_recovery_on_same_pool_moves_dispatch_to_unknown_without_permit() {
        let (_directory, pool) = temp_pool().await;
        let store = MessageEffectStore::new(pool.clone());
        let PreparedMessageEffect::Created(prepared) = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap()
        else {
            panic!("first prepare must create a checkpoint");
        };
        let outcome = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id.clone(),
                expected_revision: prepared.revision,
                backend_owner_id: "old-backend".to_string(),
                attempt_id: "attempt-1".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap();
        assert!(matches!(outcome, BeginDispatchOutcome::Ready { .. }));

        drop(store);
        let reopened = MessageEffectStore::new(pool);
        let recovered = reopened
            .recover_for_backend("new-backend", |_| false)
            .await
            .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].state, MessageEffectState::Unknown);
        assert!(reopened
            .prepare(strong_intent("turn-2", "session-2"))
            .await
            .is_ok_and(|value| matches!(value, PreparedMessageEffect::Blocked(_))));
    }

    #[tokio::test]
    async fn recovery_leaves_an_effect_owned_by_a_confirmed_live_backend_untouched() {
        let (_directory, pool) = temp_pool().await;
        let store = MessageEffectStore::new(pool);
        let PreparedMessageEffect::Created(prepared) = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap()
        else {
            panic!("first prepare must create a checkpoint");
        };

        let recovered = store
            .recover_for_backend("new-backend", |owner| owner == "backend-1")
            .await
            .unwrap();

        assert!(recovered.is_empty());
        let untouched = store
            .inspect(&prepared.checkpoint_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(untouched.state, MessageEffectState::Prepared);
        assert_eq!(untouched.revision, prepared.revision);
        assert_eq!(untouched.backend_owner_id.as_deref(), Some("backend-1"));
    }

    #[tokio::test]
    async fn closed_pool_reopen_recovers_prepared_and_dispatching_states() {
        let (directory, pool) = temp_pool().await;
        let path = directory.path().join("message-effects.db");
        let store = MessageEffectStore::new(pool.clone());

        let mut prepared_intent = strong_intent("prepared-turn", "prepared-session");
        prepared_intent.target = MessageTargetIdentity::Strong {
            conversation_hash: "prepared-conversation".to_string(),
            recipient_hash: "prepared-recipient".to_string(),
        };
        prepared_intent.message_hash = "prepared-message".to_string();
        let PreparedMessageEffect::Created(prepared) =
            store.prepare(prepared_intent.clone()).await.unwrap()
        else {
            panic!("prepared checkpoint must be created");
        };

        let dispatch_intent = strong_intent("dispatch-turn", "dispatch-session");
        let PreparedMessageEffect::Created(dispatch_prepared) =
            store.prepare(dispatch_intent.clone()).await.unwrap()
        else {
            panic!("dispatch checkpoint must be created");
        };
        let BeginDispatchOutcome::Ready {
            effect: dispatching,
            ..
        } = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: dispatch_prepared.checkpoint_id.clone(),
                expected_revision: dispatch_prepared.revision,
                backend_owner_id: "old-backend".to_string(),
                attempt_id: "attempt-before-reopen".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap()
        else {
            panic!("dispatch must commit before the pool is closed");
        };

        drop(store);
        pool.close().await;
        let reopened_pool = open_pool(&path).await;
        attest_schema_v16(&reopened_pool).await.unwrap();
        let reopened = MessageEffectStore::new(reopened_pool);
        let recovered = reopened
            .recover_for_backend("new-backend", |_| false)
            .await
            .unwrap();
        assert_eq!(recovered.len(), 2);

        let recovered_prepared = reopened
            .inspect(&prepared.checkpoint_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered_prepared.state, MessageEffectState::Abandoned);
        assert_eq!(recovered_prepared.revision, prepared.revision + 1);
        let recovered_dispatching = reopened
            .inspect(&dispatching.checkpoint_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered_dispatching.state, MessageEffectState::Unknown);
        assert_eq!(recovered_dispatching.revision, dispatching.revision + 1);

        let PreparedMessageEffect::Created(reprepared) =
            reopened.prepare(prepared_intent).await.unwrap()
        else {
            panic!("abandoned preparation must be eligible for controlled reprepare");
        };
        assert_eq!(reprepared.checkpoint_id, prepared.checkpoint_id);
        assert_eq!(reprepared.revision, recovered_prepared.revision + 1);
        assert!(matches!(
            reopened
                .prepare(strong_intent("later-turn", "later-session"))
                .await
                .unwrap(),
            PreparedMessageEffect::Blocked(_)
        ));
    }

    #[test]
    #[ignore = "executed only by actual_child_process_recovery_moves_dispatching_to_unknown_without_permit"]
    fn dispatching_child_process_fixture() {
        let mode_enabled =
            std::env::var(DISPATCHING_CHILD_MODE_ENV).as_deref() == Ok("committed-dispatching-v1");
        let arguments: Vec<String> = std::env::args().collect();
        let exact_helper_requested = arguments
            .iter()
            .any(|value| value == DISPATCHING_CHILD_TEST)
            && arguments.iter().any(|value| value == "--exact")
            && arguments.iter().any(|value| value == "--ignored");
        if !mode_enabled || !exact_helper_requested {
            return;
        }

        let database_path = std::env::var_os(DISPATCHING_CHILD_DATABASE_ENV)
            .expect("parent supplied the isolated child database path");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let pool = open_pool(Path::new(&database_path)).await;
            attest_schema_v16(&pool).await.unwrap();
            let store = MessageEffectStore::new(pool);
            let PreparedMessageEffect::Created(prepared) = store
                .prepare(strong_intent("child-turn", "child-session"))
                .await
                .unwrap()
            else {
                panic!("child must create the isolated checkpoint");
            };
            let BeginDispatchOutcome::Ready { effect, permit } = store
                .begin_dispatch(BeginDispatch {
                    checkpoint_id: prepared.checkpoint_id,
                    expected_revision: prepared.revision,
                    backend_owner_id: "child-backend".to_string(),
                    attempt_id: "child-attempt".to_string(),
                    baseline: baseline(),
                })
                .await
                .unwrap()
            else {
                panic!("child must commit dispatching before it signals readiness");
            };
            drop(permit);
            println!(
                "{DISPATCHING_CHILD_READY} {} {}",
                effect.checkpoint_id, effect.revision
            );
            std::io::stdout().flush().unwrap();
            std::future::pending::<()>().await;
            drop((store, effect));
        });
    }

    #[tokio::test]
    async fn actual_child_process_recovery_moves_dispatching_to_unknown_without_permit() {
        let (directory, bootstrap_pool) = temp_pool().await;
        let database_path = directory.path().join("message-effects.db");
        bootstrap_pool.close().await;

        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg(DISPATCHING_CHILD_TEST)
            .arg("--exact")
            .arg("--ignored")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env(DISPATCHING_CHILD_MODE_ENV, "committed-dispatching-v1")
            .env(DISPATCHING_CHILD_DATABASE_ENV, &database_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().expect("child stdout is piped");
        let mut child = SpawnedTestChild(Some(child));
        let (line_sender, line_receiver) = mpsc::channel();
        let stdout_reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line_sender.send(line).is_err() {
                    break;
                }
            }
        });

        let deadline = Instant::now() + Duration::from_secs(20);
        let (checkpoint_id, dispatch_revision) = loop {
            let now = Instant::now();
            assert!(
                now < deadline,
                "child did not commit dispatching before timeout"
            );
            let remaining = deadline.saturating_duration_since(now);
            match line_receiver.recv_timeout(remaining.min(Duration::from_millis(250))) {
                Ok(Ok(line)) => {
                    let fields: Vec<&str> = line.split_whitespace().collect();
                    if let Some(marker) = fields
                        .iter()
                        .position(|value| *value == DISPATCHING_CHILD_READY)
                    {
                        assert!(
                            fields.len() >= marker + 3,
                            "invalid child readiness line: {line}"
                        );
                        break (
                            fields[marker + 1].to_string(),
                            fields[marker + 2].parse::<i64>().unwrap(),
                        );
                    }
                }
                Ok(Err(error)) => panic!("failed to read child readiness: {error}"),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(status) = child.child_mut().try_wait().unwrap() {
                        panic!("child exited before readiness with {status}");
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("child stdout closed before readiness")
                }
            }
        };

        let exit_status = child.terminate_and_wait();
        stdout_reader.join().unwrap();
        assert!(
            !exit_status.success(),
            "the explicitly terminated child must not report normal completion"
        );

        let reopened_pool = open_pool(&database_path).await;
        attest_schema_v16(&reopened_pool).await.unwrap();
        let reopened = MessageEffectStore::new(reopened_pool);
        let interrupted = reopened.inspect(&checkpoint_id).await.unwrap().unwrap();
        assert_eq!(interrupted.state, MessageEffectState::Dispatching);
        assert_eq!(interrupted.revision, dispatch_revision);
        assert_eq!(
            interrupted.backend_owner_id.as_deref(),
            Some("child-backend")
        );
        assert!(interrupted.unresolved_fence_key.is_some());
        let recovered = reopened
            .recover_for_backend("parent-new-backend", |_| false)
            .await
            .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].checkpoint_id, checkpoint_id);
        assert_eq!(recovered[0].state, MessageEffectState::Unknown);
        assert_eq!(recovered[0].revision, dispatch_revision + 1);
        assert!(recovered[0].unresolved_fence_key.is_some());

        match reopened
            .begin_dispatch(BeginDispatch {
                checkpoint_id: checkpoint_id.clone(),
                expected_revision: recovered[0].revision,
                backend_owner_id: "parent-new-backend".to_string(),
                attempt_id: "parent-retry".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap()
        {
            BeginDispatchOutcome::Blocked(blocked) => {
                assert_eq!(blocked.checkpoint_id, checkpoint_id);
                assert_eq!(blocked.state, MessageEffectState::Unknown);
                assert_eq!(blocked.revision, recovered[0].revision);
                assert!(blocked.unresolved_fence_key.is_some());
            }
            BeginDispatchOutcome::Ready { .. } => {
                panic!("recovery must never return a new dispatch permit")
            }
        }
        assert!(matches!(
            reopened
                .prepare(strong_intent("parent-retry-turn", "parent-retry-session"))
                .await
                .unwrap(),
            PreparedMessageEffect::Blocked(_)
        ));
    }

    #[tokio::test]
    async fn independent_pools_allow_exactly_one_dispatch_permit_and_consistent_events() {
        let (directory, bootstrap_pool) = temp_pool().await;
        let path = directory.path().join("message-effects.db");
        bootstrap_pool.close().await;
        let pool_a = open_pool(&path).await;
        let pool_b = open_pool(&path).await;
        let store_a = MessageEffectStore::new(pool_a.clone());
        let store_b = MessageEffectStore::new(pool_b.clone());
        let intent = strong_intent("shared-turn", "shared-session");

        let prepare_barrier = Arc::new(tokio::sync::Barrier::new(2));
        let prepare_barrier_a = Arc::clone(&prepare_barrier);
        let prepare_barrier_b = Arc::clone(&prepare_barrier);
        let (first, second) = tokio::join!(
            async {
                prepare_barrier_a.wait().await;
                store_a.prepare(intent.clone()).await
            },
            async {
                prepare_barrier_b.wait().await;
                store_b.prepare(intent.clone()).await
            }
        );
        let (prepared, prepare_blocked) = match (first.unwrap(), second.unwrap()) {
            (PreparedMessageEffect::Created(created), PreparedMessageEffect::Blocked(blocked))
            | (PreparedMessageEffect::Blocked(blocked), PreparedMessageEffect::Created(created)) => {
                (created, blocked)
            }
            _ => panic!("exactly one independent pool must create the checkpoint"),
        };
        assert_eq!(prepare_blocked.checkpoint_id, prepared.checkpoint_id);
        assert_eq!(prepare_blocked.revision, prepared.revision);

        let request_a = BeginDispatch {
            checkpoint_id: prepared.checkpoint_id.clone(),
            expected_revision: prepared.revision,
            backend_owner_id: "backend-a".to_string(),
            attempt_id: "attempt-a".to_string(),
            baseline: baseline(),
        };
        let request_b = BeginDispatch {
            checkpoint_id: prepared.checkpoint_id.clone(),
            expected_revision: prepared.revision,
            backend_owner_id: "backend-b".to_string(),
            attempt_id: "attempt-b".to_string(),
            baseline: baseline(),
        };
        let dispatch_barrier = Arc::new(tokio::sync::Barrier::new(2));
        let dispatch_barrier_a = Arc::clone(&dispatch_barrier);
        let dispatch_barrier_b = Arc::clone(&dispatch_barrier);
        let (first, second) = tokio::join!(
            async {
                dispatch_barrier_a.wait().await;
                store_a.begin_dispatch(request_a).await
            },
            async {
                dispatch_barrier_b.wait().await;
                store_b.begin_dispatch(request_b).await
            }
        );
        let (ready_effect, authorization, dispatch_blocked) =
            match (first.unwrap(), second.unwrap()) {
                (
                    BeginDispatchOutcome::Ready { permit, effect },
                    BeginDispatchOutcome::Blocked(blocked),
                )
                | (
                    BeginDispatchOutcome::Blocked(blocked),
                    BeginDispatchOutcome::Ready { permit, effect },
                ) => (effect, permit.consume(), blocked),
                _ => panic!("exactly one independent pool must receive a dispatch permit"),
            };
        assert_eq!(authorization.checkpoint_id(), prepared.checkpoint_id);
        assert_eq!(authorization.revision(), prepared.revision + 1);
        assert_eq!(dispatch_blocked.checkpoint_id, prepared.checkpoint_id);
        assert_eq!(dispatch_blocked.revision, ready_effect.revision);

        let events: Vec<(i64, Option<String>, String)> = sqlx::query_as(
            "SELECT revision, from_state, to_state FROM computer_message_effect_events \
             WHERE checkpoint_id = ? ORDER BY revision",
        )
        .bind(&prepared.checkpoint_id)
        .fetch_all(&pool_a)
        .await
        .unwrap();
        assert_eq!(
            events,
            vec![
                (0, None, "prepared".to_string()),
                (1, Some("prepared".to_string()), "dispatching".to_string())
            ]
        );
        let current = store_b
            .inspect(&prepared.checkpoint_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.state, MessageEffectState::Dispatching);
        assert_eq!(current.revision, 1);
    }

    #[tokio::test]
    async fn dispatch_event_insert_failure_rolls_back_without_returning_permit() {
        let (_directory, pool) = temp_pool().await;
        let store = MessageEffectStore::new(pool.clone());
        let PreparedMessageEffect::Created(prepared) = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap()
        else {
            panic!("first prepare must create a checkpoint");
        };
        sqlx::query(
            "CREATE TRIGGER reject_dispatch_event \
             BEFORE INSERT ON computer_message_effect_events \
             WHEN NEW.revision = 1 \
             BEGIN SELECT RAISE(ABORT, 'injected dispatch event failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let effect_before = effect_row_snapshot(&pool, &prepared.checkpoint_id).await;
        let events_before = event_rows_snapshot(&pool, &prepared.checkpoint_id).await;

        let result = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id.clone(),
                expected_revision: prepared.revision,
                backend_owner_id: "different-backend".to_string(),
                attempt_id: "attempt-rejected".to_string(),
                baseline: baseline(),
            })
            .await;
        let error = match result {
            Ok(_) => panic!("an event insertion failure must not return a dispatch permit"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("injected dispatch event failure"), "{error}");
        let rolled_back = store
            .inspect(&prepared.checkpoint_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rolled_back.state, MessageEffectState::Prepared);
        assert_eq!(rolled_back.revision, prepared.revision);
        assert_eq!(rolled_back.unresolved_fence_key, None);
        assert_eq!(rolled_back.attempt_id, None);
        assert_eq!(
            effect_row_snapshot(&pool, &prepared.checkpoint_id).await,
            effect_before
        );
        assert_eq!(
            event_rows_snapshot(&pool, &prepared.checkpoint_id).await,
            events_before
        );
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM computer_message_effect_events WHERE checkpoint_id = ?",
        )
        .bind(&prepared.checkpoint_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(event_count, 1);

        sqlx::query("DROP TRIGGER reject_dispatch_event")
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            store
                .begin_dispatch(BeginDispatch {
                    checkpoint_id: prepared.checkpoint_id,
                    expected_revision: prepared.revision,
                    backend_owner_id: "backend-1".to_string(),
                    attempt_id: "attempt-after-rollback".to_string(),
                    baseline: baseline(),
                })
                .await
                .unwrap(),
            BeginDispatchOutcome::Ready { .. }
        ));
    }

    #[tokio::test]
    async fn direct_commit_failure_rolls_back_without_returning_permit() {
        let (directory, pool) = temp_pool().await;
        let database_path = directory.path().join("message-effects.db");
        sqlx::query("CREATE TABLE injected_commit_parent (id INTEGER PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE injected_commit_child (\
                checkpoint_id TEXT PRIMARY KEY NOT NULL, \
                parent_id INTEGER NOT NULL, \
                FOREIGN KEY(parent_id) REFERENCES injected_commit_parent(id) \
                    DEFERRABLE INITIALLY DEFERRED\
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TRIGGER inject_dispatch_commit_failure \
             AFTER INSERT ON computer_message_effect_events \
             WHEN NEW.revision = 1 \
             BEGIN \
                INSERT INTO injected_commit_child(checkpoint_id, parent_id) \
                VALUES (NEW.checkpoint_id, 404); \
             END",
        )
        .execute(&pool)
        .await
        .unwrap();
        attest_schema_v16(&pool).await.unwrap();

        let mut probe_connection = pool.acquire().await.unwrap();
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut *probe_connection)
            .await
            .unwrap();
        assert_eq!(foreign_keys, 1);
        let mut probe = probe_connection
            .begin_with("BEGIN IMMEDIATE")
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO injected_commit_child(checkpoint_id, parent_id) VALUES ('deferred-probe', 404)",
        )
        .execute(&mut *probe)
        .await
        .expect("the deferred foreign-key violation must not fail its INSERT");
        let visible_before_commit: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM injected_commit_child")
                .fetch_one(&mut *probe)
                .await
                .unwrap();
        assert_eq!(visible_before_commit, 1);
        let commit_error = probe.commit().await.unwrap_err().to_string();
        assert!(
            commit_error
                .to_ascii_lowercase()
                .contains("foreign key constraint failed"),
            "{commit_error}"
        );
        drop(probe_connection);
        pool.close().await;

        let pool = open_pool(&database_path).await;
        attest_schema_v16(&pool).await.unwrap();
        let probe_rows_after_rollback: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM injected_commit_child")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(probe_rows_after_rollback, 0);
        let connection_is_usable: i64 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(connection_is_usable, 1);

        let store = MessageEffectStore::new(pool.clone());
        let PreparedMessageEffect::Created(prepared) = store
            .prepare(strong_intent(
                "commit-failure-turn",
                "commit-failure-session",
            ))
            .await
            .unwrap()
        else {
            panic!("first prepare must create the isolated checkpoint");
        };
        let effect_before = effect_row_snapshot(&pool, &prepared.checkpoint_id).await;
        let events_before = event_rows_snapshot(&pool, &prepared.checkpoint_id).await;
        let result = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id.clone(),
                expected_revision: prepared.revision,
                backend_owner_id: "commit-failure-backend".to_string(),
                attempt_id: "commit-failure-attempt".to_string(),
                baseline: baseline(),
            })
            .await;
        let error = match result {
            Ok(_) => panic!("a direct COMMIT failure must not return a dispatch permit"),
            Err(error) => error.to_string(),
        };
        assert!(
            error
                .to_ascii_lowercase()
                .contains("foreign key constraint failed"),
            "{error}"
        );
        drop(store);
        pool.close().await;

        let reopened_pool = open_pool(&database_path).await;
        attest_schema_v16(&reopened_pool).await.unwrap();
        assert_eq!(
            effect_row_snapshot(&reopened_pool, &prepared.checkpoint_id).await,
            effect_before
        );
        assert_eq!(
            event_rows_snapshot(&reopened_pool, &prepared.checkpoint_id).await,
            events_before
        );
        let orphan_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM injected_commit_child")
            .fetch_one(&reopened_pool)
            .await
            .unwrap();
        assert_eq!(orphan_rows, 0);
        let connection_is_usable: i64 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&reopened_pool)
            .await
            .unwrap();
        assert_eq!(connection_is_usable, 1);

        sqlx::query("DROP TRIGGER inject_dispatch_commit_failure")
            .execute(&reopened_pool)
            .await
            .unwrap();
        sqlx::query("DROP TABLE injected_commit_child")
            .execute(&reopened_pool)
            .await
            .unwrap();
        sqlx::query("DROP TABLE injected_commit_parent")
            .execute(&reopened_pool)
            .await
            .unwrap();
        let reopened = MessageEffectStore::new(reopened_pool);
        let BeginDispatchOutcome::Ready { permit, effect } = reopened
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id,
                expected_revision: prepared.revision,
                backend_owner_id: "retry-backend".to_string(),
                attempt_id: "retry-attempt".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap()
        else {
            panic!("retry after proven rollback must yield exactly one permit");
        };
        let authorization = permit.consume();
        assert_eq!(authorization.checkpoint_id(), effect.checkpoint_id);
        assert_eq!(authorization.revision(), effect.revision);
    }

    #[tokio::test]
    async fn terminal_transition_releases_fence_but_keeps_audit_history() {
        let (_directory, pool) = temp_pool().await;
        let store = MessageEffectStore::new(pool.clone());
        let PreparedMessageEffect::Created(prepared) = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap()
        else {
            panic!("first prepare must create a checkpoint");
        };
        let BeginDispatchOutcome::Ready { effect, .. } = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id.clone(),
                expected_revision: prepared.revision,
                backend_owner_id: "backend-1".to_string(),
                attempt_id: "attempt-1".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap()
        else {
            panic!("dispatch must be ready");
        };
        store
            .resolve_terminal(
                &prepared.checkpoint_id,
                effect.revision,
                TerminalResolution::Sent {
                    proof_digest: "proof-1".to_string(),
                    evidence_digest: "evidence-1".to_string(),
                    source: ResolutionSource::Adapter,
                },
            )
            .await
            .unwrap();

        assert!(matches!(
            store
                .prepare(strong_intent("turn-2", "session-2"))
                .await
                .unwrap(),
            PreparedMessageEffect::Created(_)
        ));
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM computer_message_effect_events WHERE checkpoint_id = ?",
        )
        .bind(prepared.checkpoint_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(event_count, 3);
    }

    #[tokio::test]
    async fn terminal_resolution_failure_keeps_the_dispatch_fenced_and_allows_unknown_freeze() {
        let (_directory, pool) = temp_pool().await;
        let store = MessageEffectStore::new(pool.clone());
        let PreparedMessageEffect::Created(prepared) = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap()
        else {
            panic!("first prepare must create a checkpoint");
        };
        let BeginDispatchOutcome::Ready { effect, permit } = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id.clone(),
                expected_revision: prepared.revision,
                backend_owner_id: "backend-1".to_string(),
                attempt_id: "attempt-1".to_string(),
                baseline: baseline(),
            })
            .await
            .unwrap()
        else {
            panic!("dispatch must commit before terminal resolution");
        };
        let authorization = permit.consume();
        sqlx::query(
            "CREATE TRIGGER reject_terminal_resolution \
             BEFORE UPDATE OF state ON computer_message_effects \
             WHEN NEW.state IN ('sent','undeliverable') \
             BEGIN SELECT RAISE(ABORT, 'injected terminal resolution failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let error = store
            .resolve_terminal(
                authorization.checkpoint_id(),
                authorization.revision(),
                TerminalResolution::Sent {
                    proof_digest: "proof".to_string(),
                    evidence_digest: "evidence".to_string(),
                    source: ResolutionSource::Adapter,
                },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("injected terminal resolution failure"),
            "{error}"
        );
        let still_dispatching = store
            .inspect(&prepared.checkpoint_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still_dispatching.state, MessageEffectState::Dispatching);
        assert_eq!(still_dispatching.revision, effect.revision);
        assert!(still_dispatching.unresolved_fence_key.is_some());

        sqlx::query("DROP TRIGGER reject_terminal_resolution")
            .execute(&pool)
            .await
            .unwrap();
        let unknown = store
            .mark_unknown(
                &prepared.checkpoint_id,
                effect.revision,
                Some("resolution-failure-evidence"),
                "terminal_resolution_failed",
            )
            .await
            .unwrap();
        assert_eq!(unknown.state, MessageEffectState::Unknown);
        assert!(matches!(
            store
                .prepare(strong_intent("turn-2", "session-2"))
                .await
                .unwrap(),
            PreparedMessageEffect::Blocked(_)
        ));
    }

    #[tokio::test]
    async fn unknown_records_caller_supplied_human_resolution_and_releases_fence() {
        let (_directory, pool) = temp_pool().await;
        let store = MessageEffectStore::new(pool.clone());
        let PreparedMessageEffect::Created(prepared) = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap()
        else {
            panic!("first prepare must create a checkpoint");
        };
        let BeginDispatchOutcome::Ready { effect, permit } = store
            .begin_dispatch(BeginDispatch {
                checkpoint_id: prepared.checkpoint_id.clone(),
                expected_revision: prepared.revision,
                backend_owner_id: "backend-1".to_string(),
                attempt_id: "attempt-1".to_string(),
                baseline: DispatchBaseline::CompleteMessageIds {
                    adapter_id: "wechat-uia".to_string(),
                    adapter_version: "1".to_string(),
                    message_ids: vec!["before-message-1".to_string()],
                },
            })
            .await
            .unwrap()
        else {
            panic!("dispatch must be ready");
        };
        let authorization = permit.consume();
        assert_eq!(authorization.checkpoint_id(), prepared.checkpoint_id);
        assert_eq!(authorization.revision(), effect.revision);

        let unknown = store
            .mark_unknown(
                &prepared.checkpoint_id,
                effect.revision,
                Some("evidence-unknown"),
                "delivery_unproven",
            )
            .await
            .unwrap();
        assert_eq!(unknown.state, MessageEffectState::Unknown);
        assert_eq!(unknown.revision, effect.revision + 1);
        assert!(unknown.unresolved_fence_key.is_some());

        let resolved = store
            .resolve_terminal(
                &prepared.checkpoint_id,
                unknown.revision,
                TerminalResolution::Undeliverable {
                    proof_digest: "proof-human".to_string(),
                    evidence_digest: "evidence-human".to_string(),
                    source: ResolutionSource::Human,
                },
            )
            .await
            .unwrap();
        assert_eq!(resolved.state, MessageEffectState::Undeliverable);
        assert_eq!(resolved.revision, unknown.revision + 1);
        assert_eq!(resolved.unresolved_fence_key, None);

        let (actor_id, evidence_digest): (String, Option<String>) = sqlx::query_as(
            "SELECT actor_id, evidence_digest FROM computer_message_effect_events \
             WHERE checkpoint_id = ? AND revision = ?",
        )
        .bind(&prepared.checkpoint_id)
        .bind(resolved.revision)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(actor_id, "human");
        assert_eq!(evidence_digest.as_deref(), Some("evidence-human"));

        assert!(matches!(
            store
                .prepare(strong_intent("turn-2", "session-2"))
                .await
                .unwrap(),
            PreparedMessageEffect::Created(_)
        ));
    }

    #[tokio::test]
    async fn deleting_session_rows_does_not_delete_message_effects() {
        let (_directory, pool) = temp_pool().await;
        sqlx::query("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions(id) VALUES ('session-1')")
            .execute(&pool)
            .await
            .unwrap();
        let store = MessageEffectStore::new(pool.clone());
        let PreparedMessageEffect::Created(prepared) = store
            .prepare(strong_intent("turn-1", "session-1"))
            .await
            .unwrap()
        else {
            panic!("first prepare must create a checkpoint");
        };
        sqlx::query("DELETE FROM sessions WHERE id = 'session-1'")
            .execute(&pool)
            .await
            .unwrap();

        assert!(store
            .inspect(&prepared.checkpoint_id)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn invalid_unknown_row_is_rejected_fail_closed() {
        let (_directory, pool) = temp_pool().await;
        let mut connection = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA ignore_check_constraints = ON")
            .execute(&mut *connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO computer_message_effects (
                checkpoint_id, effect_key, replay_key, unresolved_fence_key,
                origin_session_id, intent_occurrence_id, app_id, account_hash,
                identity_strength, conversation_hash, recipient_hash, message_hash,
                source_hash, state, revision, created_at, updated_at
             ) VALUES (
                'bad', 'effect', 'replay', NULL, 'session', 'turn', 'app', 'account',
                'strong', 'conversation', 'recipient', 'message', 'source', 'unknown',
                1, 1, 1
             )",
        )
        .execute(&mut *connection)
        .await
        .unwrap();
        sqlx::query("PRAGMA ignore_check_constraints = OFF")
            .execute(&mut *connection)
            .await
            .unwrap();
        drop(connection);

        let store = MessageEffectStore::new(pool);
        let error = store.inspect("bad").await.unwrap_err().to_string();
        assert!(error.contains("invalid message effect row"), "{error}");
    }
}
