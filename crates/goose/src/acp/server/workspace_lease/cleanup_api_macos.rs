// Audit receipts never authorize filesystem mutation and are never persisted.
struct ReadOnlyCleanupAudit {
    _inspection: cleanup::Inspection,
    capability: RootCapability,
}

fn cleanup_registry() -> &'static Mutex<HashMap<String, ReadOnlyCleanupAudit>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, ReadOnlyCleanupAudit>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn audit_root_cleanup(
    request: AuditRootCleanupRequest,
) -> Result<RootCleanupAuditResponse> {
    audit_root_cleanup_with_hook(request, || Ok(()))
}

fn audit_root_cleanup_with_hook(
    request: AuditRootCleanupRequest,
    after_inspect: impl FnOnce() -> Result<()>,
) -> Result<RootCleanupAuditResponse> {
    let _access = acquire_session_access(&request.capability.session_id)?;
    if request.targets.len() != 1 {
        bail!("cleanup audit requires exactly one user-selected target");
    }
    let root = Path::new(&request.root_path);
    validate_root_container_path(root)?;
    let reservation =
        reserve_root_capability(&request.capability, root, RootCapabilityKind::CleanupAudit)?;
    let inspection = cleanup::inspect(root, Path::new(&request.targets[0]))?;
    after_inspect()?;
    inspection.revalidate()?;
    let summary = inspection.summary.clone();
    let mut audits = cleanup_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup audit registry is unavailable"))?;
    // Holding the receipt lock makes commit+insert atomic with session revocation.
    let capability = reservation.commit()?;
    if capability.expires_at <= Instant::now() {
        bail!("cleanup capability expired during inspection");
    }
    let expires_at = capability.expires_at;
    let audit_token = Uuid::new_v4().to_string();
    audits.insert(
        audit_token.clone(),
        ReadOnlyCleanupAudit {
            _inspection: inspection,
            capability,
        },
    );
    drop(audits);
    let expiry_token = audit_token.clone();
    tokio::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(expires_at)).await;
        if let Ok(mut audits) = cleanup_registry().lock() {
            audits.remove(&expiry_token);
        }
    });
    Ok(RootCleanupAuditResponse {
        audit_token,
        root_identity: normalize_identity(root)?,
        target: summary,
        destructive_confirmation_required: true,
        execution_available: false,
    })
}

pub(super) fn cancel_root_cleanup(request: ExecuteRootCleanupRequest) -> Result<()> {
    let _access = acquire_session_access(&request.capability.session_id)?;
    let mut audits = cleanup_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup audit registry is unavailable"))?;
    let audit = audits
        .get(&request.audit_token)
        .ok_or_else(|| anyhow!("cleanup audit token is missing, expired, or already consumed"))?;
    if audit.capability.context != request.capability {
        bail!("cleanup cancellation does not match the audited message capability");
    }
    let mut capability = audits
        .remove(&request.audit_token)
        .expect("checked receipt")
        .capability;
    if capability.expires_at <= Instant::now() {
        bail!("cleanup audit token is expired");
    }
    // Re-selection uses the same read-only capability, without extending its original deadline.
    capability.reserved = false;
    let mut capabilities = capability_registry()
        .lock()
        .map_err(|_| anyhow!("capability registry unavailable"))?;
    match capabilities.entry(capability.context.nonce.clone()) {
        Entry::Vacant(entry) => {
            entry.insert(capability);
            Ok(())
        }
        Entry::Occupied(_) => bail!("cleanup capability could not be safely restored"),
    }
}
