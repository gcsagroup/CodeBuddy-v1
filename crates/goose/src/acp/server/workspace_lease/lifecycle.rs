// Shared ACP lease ownership and session lifecycle. Filesystem operations are supplied by the platform module.

pub(super) const ACQUIRE_METHOD: &str = "_goose/unstable/workspace/lease/acquire";
pub(super) const RELEASE_METHOD: &str = "_goose/unstable/workspace/lease/release";
const PENDING_LEASE_LIFETIME: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootDiskUsage {
    pub root_path: String,
    pub capacity_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum WorkspaceState {
    Missing,
    EmptyDirectory,
    NonEmptyDirectory,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AcquireWorkspaceLeaseRequest {
    pub requested_path: String,
    pub expected_state: WorkspaceState,
    pub expected_identity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AcquireWorkspaceLeaseResponse {
    pub lease_id: String,
    pub working_dir: String,
    pub normalized_identity: String,
    pub created: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReleaseWorkspaceLeaseRequest {
    pub lease_id: String,
}

struct WorkspaceLease {
    lease_id: String,
    _ancestor_chain: Vec<File>,
    working_dir: PathBuf,
    normalized_identity: String,
    created: bool,
    #[cfg(target_os = "macos")]
    created_reference: Option<crate::secure_fs::macos::DirectoryReference>,
    owner_session_id: Option<String>,
}

pub(super) struct ConsumedWorkspaceLease(WorkspaceLease);

#[derive(Default)]
struct LeaseRegistry {
    pending: HashMap<String, WorkspaceLease>,
    sessions: HashMap<String, WorkspaceLease>,
    rolled_back: HashSet<String>,
    rollback_orphans: HashMap<String, String>,
}

#[derive(Default)]
struct SessionAccessStateInner {
    active: usize,
    closing: bool,
}

#[derive(Default)]
struct SessionAccessState {
    inner: Mutex<SessionAccessStateInner>,
    changed: tokio::sync::Notify,
}

pub(super) struct SessionAccessPermit {
    state: Arc<SessionAccessState>,
}

pub(super) struct SessionCloseBarrier {
    state: Arc<SessionAccessState>,
}

pub(super) struct SessionLifecycleTransaction {
    session_id: String,
    barrier: SessionCloseBarrier,
    committed: bool,
}

fn registry() -> &'static Mutex<LeaseRegistry> {
    static REGISTRY: OnceLock<Mutex<LeaseRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(LeaseRegistry::default()))
}

fn session_access_registry() -> &'static Mutex<HashMap<String, Arc<SessionAccessState>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<SessionAccessState>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_lifecycle_registry() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) async fn lock_session_lifecycle(
    session_id: &str,
) -> Result<tokio::sync::OwnedMutexGuard<()>> {
    let lifecycle = session_lifecycle_registry()
        .lock()
        .map_err(|_| anyhow!("session lifecycle registry is unavailable"))?
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    Ok(lifecycle.lock_owned().await)
}

pub(super) fn acquire_session_access(session_id: &str) -> Result<SessionAccessPermit> {
    let state = session_access_registry()
        .lock()
        .map_err(|_| anyhow!("session access registry is unavailable"))?
        .entry(session_id.to_string())
        .or_default()
        .clone();
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| anyhow!("session access state is unavailable"))?;
        if inner.closing {
            bail!("session is closing");
        }
        inner.active += 1;
    }
    Ok(SessionAccessPermit { state })
}

pub(super) fn begin_session_close(session_id: &str) -> Result<SessionCloseBarrier> {
    let state = session_access_registry()
        .lock()
        .map_err(|_| anyhow!("session access registry is unavailable"))?
        .entry(session_id.to_string())
        .or_default()
        .clone();
    state
        .inner
        .lock()
        .map_err(|_| anyhow!("session access state is unavailable"))?
        .closing = true;
    Ok(SessionCloseBarrier { state })
}

pub(super) fn begin_session_lifecycle_transaction(
    session_id: &str,
) -> Result<SessionLifecycleTransaction> {
    Ok(SessionLifecycleTransaction {
        session_id: session_id.to_string(),
        barrier: begin_session_close(session_id)?,
        committed: false,
    })
}

pub(super) fn reopen_session_access(session_id: &str) -> Result<()> {
    let state = session_access_registry()
        .lock()
        .map_err(|_| anyhow!("session access registry is unavailable"))?
        .entry(session_id.to_string())
        .or_default()
        .clone();
    state
        .inner
        .lock()
        .map_err(|_| anyhow!("session access state is unavailable"))?
        .closing = false;
    Ok(())
}

impl SessionCloseBarrier {
    pub(super) async fn wait_for_idle(&self) -> Result<()> {
        loop {
            let notified = self.state.changed.notified();
            if self
                .state
                .inner
                .lock()
                .map_err(|_| anyhow!("session access state is unavailable"))?
                .active
                == 0
            {
                return Ok(());
            }
            notified.await;
        }
    }
}

impl SessionLifecycleTransaction {
    pub(super) async fn wait_for_idle(&self) -> Result<()> {
        self.barrier.wait_for_idle().await
    }

    pub(super) fn commit_closed(mut self) {
        self.committed = true;
    }

    pub(super) fn commit_reopened(mut self) -> Result<()> {
        reopen_session_access(&self.session_id)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for SessionLifecycleTransaction {
    fn drop(&mut self) {
        if !self.committed {
            let _ = reopen_session_access(&self.session_id);
        }
    }
}

impl Drop for SessionAccessPermit {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.state.inner.lock() {
            inner.active = inner.active.saturating_sub(1);
            if inner.active == 0 {
                self.state.changed.notify_waiters();
            }
        }
    }
}

pub(super) fn acquire_workspace_lease(
    request: AcquireWorkspaceLeaseRequest,
) -> Result<AcquireWorkspaceLeaseResponse> {
    acquire_workspace_lease_with_hook(request, || Ok(()))
}

fn acquire_workspace_lease_with_hook<F>(
    request: AcquireWorkspaceLeaseRequest,
    before_leaf_create: F,
) -> Result<AcquireWorkspaceLeaseResponse>
where
    F: FnOnce() -> Result<()>,
{
    acquire_workspace_lease_with_hooks(request, || Ok(()), before_leaf_create)
}

fn acquire_workspace_lease_with_hooks<F, G>(
    request: AcquireWorkspaceLeaseRequest,
    before_canonical_reopen: F,
    before_leaf_create: G,
) -> Result<AcquireWorkspaceLeaseResponse>
where
    F: FnOnce() -> Result<()>,
    G: FnOnce() -> Result<()>,
{
    let acquired = acquire_handles(&request, before_canonical_reopen, before_leaf_create)?;
    register_pending_workspace_lease(acquired)
}

fn register_pending_workspace_lease(
    mut acquired: WorkspaceLease,
) -> Result<AcquireWorkspaceLeaseResponse> {
    let response = AcquireWorkspaceLeaseResponse {
        lease_id: Uuid::new_v4().to_string(),
        working_dir: acquired.working_dir.to_string_lossy().into_owned(),
        normalized_identity: acquired.normalized_identity.clone(),
        created: acquired.created,
    };
    acquired.lease_id.clone_from(&response.lease_id);
    registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?
        .pending
        .insert(response.lease_id.clone(), acquired);
    Ok(response)
}

pub(super) fn release_workspace_lease(lease_id: &str) -> Result<()> {
    let lease = {
        let mut registry = registry()
            .lock()
            .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
        if let Some(lease) = registry.pending.remove(lease_id) {
            lease
        } else if registry.rolled_back.remove(lease_id) {
            return Ok(());
        } else {
            bail!("workspace lease is missing, consumed, or already released");
        }
    };
    if lease.created {
        #[cfg(not(target_os = "macos"))]
        rollback_empty_created_workspace(&lease)?;
        #[cfg(target_os = "macos")]
        if let Err(error) = rollback_empty_created_workspace(&lease) {
            registry()
                .lock()
                .map_err(|_| anyhow!("workspace lease registry is unavailable"))?
                .pending
                .insert(lease_id.to_string(), lease);
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn schedule_workspace_lease_expiry(lease_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(PENDING_LEASE_LIFETIME).await;
        let _ = release_workspace_lease(&lease_id);
    });
}

pub(super) fn consume_workspace_lease(
    lease_id: &str,
    cwd: &Path,
) -> Result<ConsumedWorkspaceLease> {
    let mut registry = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
    let lease = registry
        .pending
        .get(lease_id)
        .ok_or_else(|| anyhow!("workspace lease is missing, consumed, or already released"))?;
    validate_workspace_lease(lease, cwd)?;
    let lease = registry
        .pending
        .remove(lease_id)
        .ok_or_else(|| anyhow!("workspace lease is missing, consumed, or already released"))?;
    Ok(ConsumedWorkspaceLease(lease))
}

pub(super) fn consume_allocated_workspace_lease(
    lease_id: &str,
    cwd: &Path,
    owner_session_id: &str,
) -> Result<ConsumedWorkspaceLease> {
    let mut registry = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
    let lease = registry
        .pending
        .get(lease_id)
        .ok_or_else(|| anyhow!("workspace lease is missing, consumed, or already released"))?;
    if lease.owner_session_id.as_deref() != Some(owner_session_id) {
        bail!("allocated workspace lease belongs to a different session");
    }
    validate_workspace_lease(lease, cwd)?;
    let lease = registry
        .pending
        .remove(lease_id)
        .ok_or_else(|| anyhow!("workspace lease is missing, consumed, or already released"))?;
    Ok(ConsumedWorkspaceLease(lease))
}

pub(super) fn validate_consumed_workspace_lease(
    lease: &ConsumedWorkspaceLease,
    cwd: &Path,
) -> Result<()> {
    validate_workspace_lease(&lease.0, cwd)
}

pub(super) fn bind_workspace_lease(session_id: &str, lease: ConsumedWorkspaceLease) -> Result<()> {
    let mut registry = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
    match registry.sessions.entry(session_id.to_string()) {
        Entry::Vacant(entry) => {
            entry.insert(lease.0);
            registry.rollback_orphans.remove(session_id);
            drop(registry);
            reopen_session_access(session_id)
        }
        Entry::Occupied(_) => {
            drop(registry);
            let lease_id = lease.0.lease_id.clone();
            if lease.0.created {
                rollback_empty_created_workspace(&lease.0).map_err(|error| {
                    anyhow!(
                        "workspace lease is already bound to this session; rollback left an orphan for lease {lease_id}: {error}"
                    )
                })?;
            }
            bail!("workspace lease is already bound to this session")
        }
    }
}

pub(super) fn validate_session_workspace_lease(session_id: &str, cwd: &Path) -> Result<()> {
    let registry = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
    if let Some(error) = registry.rollback_orphans.get(session_id) {
        bail!("workspace lease is retained as a rollback orphan: {error}");
    }
    let lease = registry
        .sessions
        .get(session_id)
        .ok_or_else(|| anyhow!("workspace lease must be re-confirmed"))?;
    validate_workspace_lease(lease, cwd)
}

pub(super) fn validated_session_workspace_lease_id(session_id: &str, cwd: &Path) -> Result<String> {
    let registry = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
    if let Some(error) = registry.rollback_orphans.get(session_id) {
        bail!("workspace lease is retained as a rollback orphan: {error}");
    }
    let lease = registry
        .sessions
        .get(session_id)
        .ok_or_else(|| anyhow!("workspace lease must be re-confirmed"))?;
    validate_workspace_lease(lease, cwd)?;
    Ok(lease.lease_id.clone())
}

pub(super) fn validate_session_workspace_binding(
    session_id: &str,
    cwd: &Path,
    lease_id: &str,
) -> Result<()> {
    let registry = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
    if let Some(error) = registry.rollback_orphans.get(session_id) {
        bail!("workspace lease is retained as a rollback orphan: {error}");
    }
    let lease = registry
        .sessions
        .get(session_id)
        .ok_or_else(|| anyhow!("workspace lease must be re-confirmed"))?;
    if lease.lease_id != lease_id {
        bail!("workspace binding lease does not match the authoritative session lease");
    }
    validate_workspace_lease(lease, cwd)
}

pub(super) fn session_has_workspace_lease(session_id: &str) -> Result<bool> {
    Ok(registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?
        .sessions
        .contains_key(session_id))
}

pub(super) fn reacquire_existing_session_workspace_lease(
    session_id: &str,
    cwd: &Path,
) -> Result<String> {
    if !cwd.is_dir() {
        bail!("persisted workspace no longer exists as a directory");
    }
    let expected_state = if std::fs::read_dir(cwd)?.next().is_some() {
        WorkspaceState::NonEmptyDirectory
    } else {
        WorkspaceState::EmptyDirectory
    };
    let response = acquire_workspace_lease(AcquireWorkspaceLeaseRequest {
        requested_path: cwd.to_string_lossy().into_owned(),
        expected_state,
        expected_identity: normalize_identity(cwd)?,
    })?;
    let lease_id = response.lease_id.clone();
    let lease = consume_workspace_lease(&lease_id, cwd)?;
    validate_consumed_workspace_lease(&lease, cwd)?;
    bind_workspace_lease(session_id, lease)?;
    Ok(lease_id)
}

pub(super) fn release_session_workspace_lease(session_id: &str) -> Result<()> {
    let mut registry = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
    registry.sessions.remove(session_id);
    registry.rollback_orphans.remove(session_id);
    Ok(())
}

pub(super) fn rollback_failed_session_workspace_lease(session_id: &str) -> Result<()> {
    let lease = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?
        .sessions
        .remove(session_id)
        .ok_or_else(|| anyhow!("failed session workspace lease is missing"))?;
    let lease_id = lease.lease_id.clone();
    if lease.created {
        if let Err(error) = rollback_empty_created_workspace(&lease) {
            let mut registry = registry()
                .lock()
                .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
            registry.sessions.insert(session_id.to_string(), lease);
            registry
                .rollback_orphans
                .insert(session_id.to_string(), error.to_string());
            bail!("failed session workspace rollback retained authoritative lease: {error}");
        }
    }
    registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?
        .rolled_back
        .insert(lease_id);
    Ok(())
}
