// Shared allocation tokens, receipts and rollback. The platform validates the container.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AllocateWorkspaceChildRequest {
    pub container_path: String,
    pub suggested_name: String,
    pub capability: RootCapabilityContext,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RootCapabilityContext {
    pub session_id: String,
    pub run_id: String,
    pub source_message_id: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RootCapabilityKind {
    AllocateChild,
    CleanupAudit,
}

#[derive(Clone)]
struct RootCapability {
    context: RootCapabilityContext,
    root_identity: Option<String>,
    kind: RootCapabilityKind,
    reserved: bool,
    generation: Uuid,
    expires_at: Instant,
}

struct RootCapabilityReservation {
    capability: RootCapability,
    committed: bool,
    consume_on_drop: bool,
}

#[derive(Clone)]
struct AllocatedWorkspaceReceipt {
    capability: RootCapabilityContext,
    container_identity: String,
    suggested_name: String,
    response: AcquireWorkspaceLeaseResponse,
}

fn capability_registry() -> &'static Mutex<HashMap<String, RootCapability>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, RootCapability>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn allocated_workspace_receipt_registry(
) -> &'static Mutex<HashMap<String, AllocatedWorkspaceReceipt>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, AllocatedWorkspaceReceipt>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn workspace_allocation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn issue_root_capability(
    session_id: &str,
    run_id: &str,
    source_message_id: &str,
    root: Option<&Path>,
    kind: RootCapabilityKind,
) -> Result<RootCapabilityContext> {
    let context = RootCapabilityContext {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        source_message_id: source_message_id.to_string(),
        nonce: Uuid::new_v4().to_string(),
    };
    let root_identity = root.map(normalize_identity).transpose()?;
    let generation = Uuid::new_v4();
    let expires_at = Instant::now() + PENDING_LEASE_LIFETIME;
    capability_registry()
        .lock()
        .map_err(|_| anyhow!("root capability registry is unavailable"))?
        .insert(
            context.nonce.clone(),
            RootCapability {
                context: context.clone(),
                root_identity,
                kind,
                reserved: false,
                generation,
                expires_at,
            },
        );
    schedule_root_capability_expiry(context.nonce.clone(), generation, expires_at);
    Ok(context)
}

// Called only after the ACP host validates the persisted waiting task. A refresh
// never authorizes a second allocation after the first one has produced a lease.
pub(super) fn refresh_workspace_capability(
    session_id: &str,
    run_id: &str,
    source_message_id: &str,
    root: Option<&Path>,
) -> Result<RootCapabilityContext> {
    let _allocation = workspace_allocation_lock()
        .lock()
        .map_err(|_| anyhow!("workspace allocation lock is unavailable"))?;
    let matches_context = |context: &RootCapabilityContext| {
        context.session_id == session_id
            && context.run_id == run_id
            && context.source_message_id == source_message_id
    };
    if allocated_workspace_receipt_registry()
        .lock()
        .map_err(|_| anyhow!("allocation receipts are unavailable"))?
        .values()
        .any(|receipt| matches_context(&receipt.capability))
        || registry()
            .lock()
            .map_err(|_| anyhow!("workspace leases are unavailable"))?
            .pending
            .values()
            .any(|lease| lease.owner_session_id.as_deref() == Some(session_id))
    {
        bail!("Project allocation already has a lease; finish binding it before continuing");
    }
    let root_identity = root.map(normalize_identity).transpose()?;
    let mut capabilities = capability_registry()
        .lock()
        .map_err(|_| anyhow!("root capability registry is unavailable"))?;
    if let Some(existing) = capabilities.values().find(|capability| {
        matches_context(&capability.context)
            && capability.kind == RootCapabilityKind::AllocateChild
            && capability.root_identity == root_identity
            && capability.expires_at > Instant::now()
    }) {
        if existing.reserved {
            bail!("Project confirmation is in use");
        }
        return Ok(existing.context.clone());
    }
    capabilities.retain(|_, capability| {
        !matches_context(&capability.context) || capability.kind != RootCapabilityKind::AllocateChild
    });
    drop(capabilities);
    issue_root_capability(session_id, run_id, source_message_id, root, RootCapabilityKind::AllocateChild)
}

fn reserve_root_capability(
    context: &RootCapabilityContext,
    root: &Path,
    kind: RootCapabilityKind,
) -> Result<RootCapabilityReservation> {
    let mut registry = capability_registry()
        .lock()
        .map_err(|_| anyhow!("root capability registry is unavailable"))?;
    let capability = registry
        .get_mut(&context.nonce)
        .ok_or_else(|| anyhow!("root capability is missing, expired, or already consumed"))?;
    if capability.context != *context || capability.kind != kind {
        bail!("root capability context does not match the issuing message");
    }
    if Instant::now() >= capability.expires_at {
        bail!("root capability is expired");
    }
    if capability.reserved {
        bail!("root capability is already reserved by an active operation");
    }
    if capability
        .root_identity
        .as_ref()
        .is_some_and(|expected| normalize_identity(root).ok().as_ref() != Some(expected))
    {
        bail!("root capability does not authorize this container");
    }
    capability.reserved = true;
    Ok(RootCapabilityReservation {
        capability: capability.clone(),
        committed: false,
        consume_on_drop: false,
    })
}

#[cfg(test)]
pub(super) fn expire_confirmation_for_test(context: &RootCapabilityContext) {
    let mut registry = capability_registry().lock().unwrap();
    registry.get_mut(&context.nonce).unwrap().expires_at = Instant::now();
}

impl RootCapabilityReservation {
    fn consume_on_drop(&mut self) {
        self.consume_on_drop = true;
    }

    fn preserve_on_drop(&mut self) {
        self.consume_on_drop = false;
    }

    fn commit(mut self) -> Result<RootCapability> {
        let removed = capability_registry()
            .lock()
            .map_err(|_| anyhow!("root capability registry is unavailable"))?
            .remove(&self.capability.context.nonce)
            .ok_or_else(|| anyhow!("reserved root capability expired before commit"))?;
        if removed.context != self.capability.context
            || removed.generation != self.capability.generation
            || !removed.reserved
        {
            bail!("reserved root capability changed before commit");
        }
        self.committed = true;
        Ok(removed)
    }
}

impl Drop for RootCapabilityReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Ok(mut registry) = capability_registry().lock() {
            let matches_reservation =
                registry
                    .get(&self.capability.context.nonce)
                    .is_some_and(|capability| {
                        capability.context == self.capability.context
                            && capability.generation == self.capability.generation
                    });
            if matches_reservation {
                if self.consume_on_drop {
                    registry.remove(&self.capability.context.nonce);
                } else if let Some(capability) = registry.get_mut(&self.capability.context.nonce) {
                    capability.reserved = false;
                }
            }
        }
    }
}

pub(super) fn allocate_workspace_child(
    request: AllocateWorkspaceChildRequest,
) -> Result<AcquireWorkspaceLeaseResponse> {
    allocate_workspace_child_with_hook(request, || Ok(()))
}

fn allocate_workspace_child_with_hook<F>(
    request: AllocateWorkspaceChildRequest,
    before_allocate: F,
) -> Result<AcquireWorkspaceLeaseResponse>
where
    F: FnOnce() -> Result<()>,
{
    allocate_workspace_child_with_lifecycle_hooks(
        request,
        before_allocate,
        |_| Ok(()),
        bind_allocated_workspace_owner,
        release_workspace_lease,
    )
}

fn allocate_workspace_child_with_lifecycle_hooks<F, G, H, I>(
    request: AllocateWorkspaceChildRequest,
    before_allocate: F,
    after_child_create: G,
    bind_ownership: H,
    rollback: I,
) -> Result<AcquireWorkspaceLeaseResponse>
where
    F: FnOnce() -> Result<()>,
    G: FnOnce(&AcquireWorkspaceLeaseResponse) -> Result<()>,
    H: FnOnce(&AcquireWorkspaceLeaseResponse, &str) -> Result<()>,
    I: FnOnce(&str) -> Result<()>,
{
    let _allocation_guard = workspace_allocation_lock()
        .lock()
        .map_err(|_| anyhow!("workspace allocation state is unavailable"))?;
    let container = Path::new(&request.container_path);
    #[cfg(windows)]
    {
        let (_, components) = local_drive_components(container)?;
        if !components.is_empty() {
            bail!("workspace container must be a filesystem root");
        }
    }
    validate_project_child_name(&request.suggested_name)?;
    let container_identity = normalize_identity(container)?;
    let existing_receipt = allocated_workspace_receipt_registry()
        .lock()
        .map_err(|_| anyhow!("workspace allocation receipt registry is unavailable"))?
        .get(&request.capability.nonce)
        .cloned();
    if let Some(receipt) = existing_receipt {
        if receipt.capability != request.capability
            || receipt.container_identity != container_identity
            || receipt.suggested_name != request.suggested_name
        {
            bail!("workspace allocation nonce does not match its original request");
        }
        let leases = registry()
            .lock()
            .map_err(|_| anyhow!("workspace lease registry is unavailable"))?;
        let pending_matches = leases
            .pending
            .get(&receipt.response.lease_id)
            .is_some_and(|lease| {
                lease.owner_session_id.as_deref() == Some(request.capability.session_id.as_str())
                    && lease.normalized_identity == receipt.response.normalized_identity
            });
        let bound_matches = leases
            .sessions
            .get(&request.capability.session_id)
            .is_some_and(|lease| lease.normalized_identity == receipt.response.normalized_identity);
        if !pending_matches && !bound_matches {
            bail!("workspace allocation receipt is no longer active");
        }
        #[cfg(target_os = "macos")]
        validate_project_container_path(container)?;
        return Ok(receipt.response);
    }
    let mut reservation = reserve_root_capability(
        &request.capability,
        container,
        RootCapabilityKind::AllocateChild,
    )?;
    #[cfg(target_os = "macos")]
    let container_handles =
        pin_project_container(container).map_err(path_free_workspace_permission_error)?;
    if let Err(error) = before_allocate() {
        let error = path_free_workspace_permission_error(error);
        if workspace_allocation_permission_error_data(&error).is_none() {
            reservation.consume_on_drop();
        }
        return Err(error);
    }
    reservation.consume_on_drop();

    #[cfg(windows)]
    let response = loop {
        let suffix = (1..=1000)
            .find(|suffix| {
                let name = if *suffix == 1 {
                    request.suggested_name.clone()
                } else {
                    format!("{}-{suffix}", request.suggested_name)
                };
                !container.join(name).exists()
            })
            .ok_or_else(|| anyhow!("no unique workspace child name is available"))?;
        let name = if suffix == 1 {
            request.suggested_name.clone()
        } else {
            format!("{}-{suffix}", request.suggested_name)
        };
        let requested_path = container.join(name);
        let lease_request = AcquireWorkspaceLeaseRequest {
            requested_path: requested_path.to_string_lossy().into_owned(),
            expected_state: WorkspaceState::Missing,
            expected_identity: normalize_identity(&requested_path)?,
        };
        match acquire_workspace_lease(lease_request) {
            Ok(response) => break response,
            Err(error)
                if error
                    .to_string()
                    .contains("workspace component already exists") =>
            {
                continue;
            }
            Err(error) if workspace_allocation_permission_error_data(&error).is_some() => {
                reservation.preserve_on_drop();
                return Err(error);
            }
            Err(error) => return Err(error),
        }
    };
    #[cfg(target_os = "macos")]
    let response =
        match acquire_project_child_lease(container, &request.suggested_name, container_handles) {
            Ok(response) => response,
            Err(error) if workspace_allocation_permission_error_data(&error).is_some() => {
                reservation.preserve_on_drop();
                return Err(error);
            }
            Err(error) => return Err(error),
        };
    if let Err(error) = after_child_create(&response) {
        return rollback_allocated_workspace(response, error, rollback);
    }
    if let Err(error) = bind_ownership(&response, &request.capability.session_id) {
        return rollback_allocated_workspace(response, error, rollback);
    }
    if let Err(error) = reservation.commit() {
        return rollback_allocated_workspace(response, error, rollback);
    }
    let receipt = AllocatedWorkspaceReceipt {
        capability: request.capability,
        container_identity,
        suggested_name: request.suggested_name,
        response: response.clone(),
    };
    if let Err(error) = allocated_workspace_receipt_registry()
        .lock()
        .map_err(|_| anyhow!("workspace allocation receipt registry is unavailable"))
        .map(|mut receipts| {
            receipts.insert(receipt.capability.nonce.clone(), receipt);
        })
    {
        return rollback_allocated_workspace(response, error, rollback);
    }
    Ok(response)
}

fn bind_allocated_workspace_owner(
    response: &AcquireWorkspaceLeaseResponse,
    session_id: &str,
) -> Result<()> {
    registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))
        .and_then(|mut registry| {
            registry
                .pending
                .get_mut(&response.lease_id)
                .ok_or_else(|| {
                    anyhow!("allocated workspace lease disappeared before ownership binding")
                })
                .map(|lease| lease.owner_session_id = Some(session_id.to_string()))
        })
}

fn rollback_allocated_workspace<I>(
    response: AcquireWorkspaceLeaseResponse,
    operation_error: anyhow::Error,
    rollback: I,
) -> Result<AcquireWorkspaceLeaseResponse>
where
    I: FnOnce(&str) -> Result<()>,
{
    rollback(&response.lease_id).map_err(|rollback_error| {
        anyhow!(
            "workspace allocation failed after child creation and rollback failed: {operation_error}; {rollback_error}"
        )
    })?;
    Err(operation_error)
}

fn schedule_root_capability_expiry(nonce: String, generation: Uuid, expires_at: Instant) {
    tokio::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(expires_at)).await;
        expire_root_capability_generation(&nonce, generation);
    });
}

fn expire_root_capability_generation(nonce: &str, generation: Uuid) {
    if let Ok(mut registry) = capability_registry().lock() {
        if registry
            .get(nonce)
            .is_some_and(|capability| capability.generation == generation)
        {
            registry.remove(nonce);
        }
    }
}

fn validate_project_child_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.chars().count() > 48
        || !name
            .chars()
            .all(|character| character.is_alphanumeric() || character == '-')
        || !name.chars().next().is_some_and(char::is_alphanumeric)
    {
        bail!("workspace child name must be a safe semantic slug")
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        bail!("workspace child name is reserved by Windows")
    }
    Ok(())
}
