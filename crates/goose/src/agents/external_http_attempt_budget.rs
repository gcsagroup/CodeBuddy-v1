use async_trait::async_trait;
use fs2::FileExt;
use goose_providers::errors::ProviderError;
use goose_providers::retry::HttpAttemptGate;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const DEFAULT_EXTERNAL_HTTP_ATTEMPT_CAP: usize = 12;
const MAX_EXTERNAL_HTTP_ATTEMPT_CAP: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExternalHttpAttemptHostPolicy {
    attempt_cap: usize,
}

impl ExternalHttpAttemptHostPolicy {
    #[cfg(test)]
    pub(crate) fn try_new(attempt_cap: usize) -> Result<Self, ProviderError> {
        if !(1..=MAX_EXTERNAL_HTTP_ATTEMPT_CAP).contains(&attempt_cap) {
            return Err(ProviderError::ExecutionError(
                "external HTTP attempt host policy cap is invalid".to_string(),
            ));
        }
        Ok(Self { attempt_cap })
    }

    pub(crate) fn attempt_cap(self) -> usize {
        self.attempt_cap
    }
}

impl Default for ExternalHttpAttemptHostPolicy {
    fn default() -> Self {
        Self {
            attempt_cap: DEFAULT_EXTERNAL_HTTP_ATTEMPT_CAP,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExternalHttpAttemptBudgetState {
    pub logical_run_id: String,
    pub authorization_id: String,
    pub cap: usize,
    pub used: usize,
}

#[derive(Debug)]
pub(crate) struct ExternalHttpAttemptBudget {
    path: PathBuf,
    state: Mutex<ExternalHttpAttemptBudgetState>,
}

impl ExternalHttpAttemptBudget {
    pub(crate) fn issue_for_new_logical_run(
        path: PathBuf,
        logical_run_id: String,
        policy: ExternalHttpAttemptHostPolicy,
    ) -> Result<Self, ProviderError> {
        let state = ExternalHttpAttemptBudgetState {
            logical_run_id,
            authorization_id: Uuid::new_v4().to_string(),
            cap: policy.attempt_cap(),
            used: 0,
        };
        validate_state(&state, &state.logical_run_id)?;
        persist_new_state(&path, &state)?;
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    pub(crate) fn load_existing(
        path: PathBuf,
        logical_run_id: &str,
    ) -> Result<Self, ProviderError> {
        let bytes = fs::read(&path).map_err(persistence_error)?;
        let state: ExternalHttpAttemptBudgetState =
            serde_json::from_slice(&bytes).map_err(persistence_error)?;
        validate_state(&state, logical_run_id)?;
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    #[cfg(test)]
    fn load_or_create(
        path: PathBuf,
        logical_run_id: String,
        authorization_id: String,
        cap: usize,
    ) -> Result<Self, ProviderError> {
        if path.exists() {
            let budget = Self::load_existing(path, &logical_run_id)?;
            let state = budget.snapshot();
            if state.authorization_id != authorization_id || state.cap != cap {
                return Err(ProviderError::ExecutionError(
                    "external HTTP attempt authorization does not match persisted state"
                        .to_string(),
                ));
            }
            return Ok(budget);
        }
        let policy = ExternalHttpAttemptHostPolicy::try_new(cap)?;
        let state = ExternalHttpAttemptBudgetState {
            logical_run_id,
            authorization_id,
            cap: policy.attempt_cap(),
            used: 0,
        };
        validate_state(&state, &state.logical_run_id)?;
        persist_new_state(&path, &state)?;
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    #[cfg(test)]
    fn snapshot(&self) -> ExternalHttpAttemptBudgetState {
        self.state.lock().expect("attempt budget lock").clone()
    }
}

fn validate_state(
    state: &ExternalHttpAttemptBudgetState,
    logical_run_id: &str,
) -> Result<(), ProviderError> {
    // `used` may legitimately exceed `cap`: the counter is diagnostic-only and
    // never blocks, so persisted over-cap states must still load on resume.
    if logical_run_id.trim().is_empty()
        || state.logical_run_id != logical_run_id
        || state.authorization_id.trim().is_empty()
        || !(1..=MAX_EXTERNAL_HTTP_ATTEMPT_CAP).contains(&state.cap)
    {
        return Err(ProviderError::ExecutionError(
            "external HTTP attempt authorization does not match persisted state".to_string(),
        ));
    }
    Ok(())
}

#[async_trait]
impl HttpAttemptGate for ExternalHttpAttemptBudget {
    async fn reserve_attempt(&self) -> Result<(), ProviderError> {
        let mut state = self.state.lock().map_err(|_| {
            ProviderError::ExecutionError("external HTTP attempt budget lock poisoned".to_string())
        })?;
        let _durable_reservation_lock = lock_attempt_state(&self.path)?;
        let persisted = load_persisted_state(&self.path, &state.logical_run_id)?;
        if persisted.authorization_id != state.authorization_id || persisted.cap != state.cap {
            return Err(ProviderError::ExecutionError(
                "external HTTP attempt authorization does not match persisted state".to_string(),
            ));
        }
        *state = persisted;
        // The gate is a pure diagnostic counter: it never blocks a request.
        // Codex-style design: successful model calls are not rationed; only
        // per-request retry limits protect against transient failures.
        let mut next = state.clone();
        next.used += 1;
        persist_state(&self.path, &next)?;
        *state = next;
        Ok(())
    }
}

fn load_persisted_state(
    path: &Path,
    logical_run_id: &str,
) -> Result<ExternalHttpAttemptBudgetState, ProviderError> {
    let bytes = fs::read(path).map_err(persistence_error)?;
    let state: ExternalHttpAttemptBudgetState =
        serde_json::from_slice(&bytes).map_err(persistence_error)?;
    validate_state(&state, logical_run_id)?;
    Ok(state)
}

fn lock_attempt_state(destination: &Path) -> Result<fs::File, ProviderError> {
    let parent = destination.parent().ok_or_else(|| {
        ProviderError::ExecutionError("attempt budget path has no parent".to_string())
    })?;
    fs::create_dir_all(parent).map_err(persistence_error)?;
    let mut lock_path = destination.as_os_str().to_os_string();
    lock_path.push(".lock");
    let lock_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(PathBuf::from(lock_path))
        .map_err(persistence_error)?;
    lock_file.lock_exclusive().map_err(persistence_error)?;
    Ok(lock_file)
}

fn persist_state(
    destination: &Path,
    state: &ExternalHttpAttemptBudgetState,
) -> Result<(), ProviderError> {
    let parent = destination.parent().ok_or_else(|| {
        ProviderError::ExecutionError("attempt budget path has no parent".to_string())
    })?;
    fs::create_dir_all(parent).map_err(persistence_error)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(persistence_error)?;
    serde_json::to_writer(&mut temporary, state).map_err(persistence_error)?;
    temporary.write_all(b"\n").map_err(persistence_error)?;
    temporary.as_file().sync_all().map_err(persistence_error)?;
    temporary.persist(destination).map_err(persistence_error)?;
    Ok(())
}

fn persist_new_state(
    destination: &Path,
    state: &ExternalHttpAttemptBudgetState,
) -> Result<(), ProviderError> {
    let parent = destination.parent().ok_or_else(|| {
        ProviderError::ExecutionError("attempt budget path has no parent".to_string())
    })?;
    fs::create_dir_all(parent).map_err(persistence_error)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(persistence_error)?;
    serde_json::to_writer(&mut temporary, state).map_err(persistence_error)?;
    temporary.write_all(b"\n").map_err(persistence_error)?;
    temporary.as_file().sync_all().map_err(persistence_error)?;
    temporary
        .persist_noclobber(destination)
        .map_err(persistence_error)?;
    Ok(())
}

fn persistence_error(error: impl std::fmt::Display) -> ProviderError {
    ProviderError::ExecutionError(format!(
        "external HTTP attempt budget persistence failed: {error}"
    ))
}

pub(crate) fn exhausted(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<ProviderError>().is_some_and(|error| {
            matches!(
                error,
                ProviderError::ExternalHttpAttemptBudgetExceeded { .. }
            )
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use goose_providers::api_client::{ApiClient, AuthMethod};
    use std::sync::Arc;
    use wiremock::matchers::any;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn host_policy_defaults_to_twelve_and_rejects_unbounded_caps() {
        assert_eq!(ExternalHttpAttemptHostPolicy::default().attempt_cap(), 12);
        assert!(ExternalHttpAttemptHostPolicy::try_new(0).is_err());
        assert!(ExternalHttpAttemptHostPolicy::try_new(1_001).is_err());
    }

    #[tokio::test]
    async fn resumed_logical_run_preserves_authorization_cap_and_used() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("external-http-attempt-budget.json");
        let issued = ExternalHttpAttemptBudget::issue_for_new_logical_run(
            path.clone(),
            "run-a".to_string(),
            ExternalHttpAttemptHostPolicy::try_new(2).unwrap(),
        )
        .unwrap();
        issued.reserve_attempt().await.unwrap();
        let before_restart = issued.snapshot();
        drop(issued);

        let resumed = ExternalHttpAttemptBudget::load_existing(path, "run-a").unwrap();

        assert_eq!(resumed.snapshot(), before_restart);
    }

    #[tokio::test]
    async fn host_cannot_reissue_an_existing_logical_run_or_reset_used() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("external-http-attempt-budget.json");
        let issued = ExternalHttpAttemptBudget::issue_for_new_logical_run(
            path.clone(),
            "run-a".to_string(),
            ExternalHttpAttemptHostPolicy::try_new(2).unwrap(),
        )
        .unwrap();
        issued.reserve_attempt().await.unwrap();
        let before_reissue = issued.snapshot();
        drop(issued);

        assert!(ExternalHttpAttemptBudget::issue_for_new_logical_run(
            path.clone(),
            "run-a".to_string(),
            ExternalHttpAttemptHostPolicy::try_new(3).unwrap(),
        )
        .is_err());

        let restored = ExternalHttpAttemptBudget::load_existing(path, "run-a").unwrap();
        assert_eq!(restored.snapshot(), before_reissue);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn independent_gate_instances_reserve_one_durable_attempt_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("external-http-attempt-budget.json");
        ExternalHttpAttemptBudget::issue_for_new_logical_run(
            path.clone(),
            "run-a".to_string(),
            ExternalHttpAttemptHostPolicy::try_new(1).unwrap(),
        )
        .unwrap();
        let first =
            Arc::new(ExternalHttpAttemptBudget::load_existing(path.clone(), "run-a").unwrap());
        let second =
            Arc::new(ExternalHttpAttemptBudget::load_existing(path.clone(), "run-a").unwrap());
        let barrier = Arc::new(tokio::sync::Barrier::new(3));

        let reserve = |gate: Arc<ExternalHttpAttemptBudget>| {
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                gate.reserve_attempt().await
            })
        };
        let first_reservation = reserve(first);
        let second_reservation = reserve(second);
        barrier.wait().await;
        let results = [
            first_reservation.await.unwrap(),
            second_reservation.await.unwrap(),
        ];

        // The gate never blocks: both reservations succeed and the durable
        // counter records exactly two attempts.
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 2);
        let persisted: ExternalHttpAttemptBudgetState =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted.used, 2);
    }

    #[test]
    fn new_logical_runs_receive_distinct_unpredictable_authorization_ids() {
        let directory = tempfile::tempdir().unwrap();
        let first = ExternalHttpAttemptBudget::issue_for_new_logical_run(
            directory.path().join("run-a.json"),
            "run-a".to_string(),
            ExternalHttpAttemptHostPolicy::default(),
        )
        .unwrap();
        let second = ExternalHttpAttemptBudget::issue_for_new_logical_run(
            directory.path().join("run-b.json"),
            "run-b".to_string(),
            ExternalHttpAttemptHostPolicy::default(),
        )
        .unwrap();

        assert_ne!(
            first.snapshot().authorization_id,
            second.snapshot().authorization_id
        );
        assert_ne!(first.snapshot().authorization_id, "run-a");
        assert_ne!(second.snapshot().authorization_id, "run-b");
    }

    #[tokio::test]
    async fn over_cap_persisted_gate_still_allows_wire_requests() {
        let directory = tempfile::tempdir().unwrap();
        let gate = Arc::new(
            ExternalHttpAttemptBudget::issue_for_new_logical_run(
                directory.path().join("external-http-attempt-budget.json"),
                "run-a".to_string(),
                ExternalHttpAttemptHostPolicy::try_new(1).unwrap(),
            )
            .unwrap(),
        );
        let server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let client = ApiClient::new_with_tls(server.uri(), AuthMethod::NoAuth, None).unwrap();

        goose_providers::retry::with_http_attempt_gate(gate, async {
            client.request("first").response_get().await?;
            client.request("second").response_get().await
        })
        .await
        .unwrap();

        // The gate never blocks: both requests go out even though the cap is 1.
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[test]
    fn missing_or_corrupt_sidecars_fail_closed_without_recreation() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.json");
        assert!(ExternalHttpAttemptBudget::load_existing(missing.clone(), "run-a").is_err());
        assert!(!missing.exists());

        let corrupt = directory.path().join("corrupt.json");
        fs::write(&corrupt, b"not-json").unwrap();
        assert!(ExternalHttpAttemptBudget::load_existing(corrupt.clone(), "run-a").is_err());
        assert_eq!(fs::read(corrupt).unwrap(), b"not-json");
    }

    #[tokio::test]
    async fn persisted_attempts_survive_restart_and_keep_counting_past_cap() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("external-http-attempt-budget.json");
        let first = ExternalHttpAttemptBudget::load_or_create(
            path.clone(),
            "run-a".to_string(),
            "authorization-a".to_string(),
            2,
        )
        .unwrap();
        first.reserve_attempt().await.unwrap();
        drop(first);

        let resumed = ExternalHttpAttemptBudget::load_or_create(
            path.clone(),
            "run-a".to_string(),
            "authorization-a".to_string(),
            2,
        )
        .unwrap();
        assert_eq!(resumed.snapshot().used, 1);
        resumed.reserve_attempt().await.unwrap();
        // The gate never blocks: reservations past the cap still succeed and
        // the durable counter keeps counting.
        resumed.reserve_attempt().await.unwrap();
        assert_eq!(resumed.snapshot().used, 3);
        let persisted: ExternalHttpAttemptBudgetState =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted.used, 3);
    }

    #[test]
    fn persisted_authorization_cannot_be_relabelled_or_have_its_cap_raised() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("external-http-attempt-budget.json");
        ExternalHttpAttemptBudget::load_or_create(
            path.clone(),
            "run-a".to_string(),
            "authorization-a".to_string(),
            2,
        )
        .unwrap();

        assert!(ExternalHttpAttemptBudget::load_or_create(
            path.clone(),
            "run-a".to_string(),
            "authorization-b".to_string(),
            2,
        )
        .is_err());
        assert!(ExternalHttpAttemptBudget::load_or_create(
            path,
            "run-a".to_string(),
            "authorization-a".to_string(),
            3,
        )
        .is_err());
    }
}
