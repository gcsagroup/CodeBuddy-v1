use super::*;

struct Projects;
impl Projects {
    fn empty() -> Self {
        cleanup::TEST_REGISTERED_PROJECT_IDENTITIES.with(|p| *p.borrow_mut() = Some(Vec::new()));
        Self
    }
}
impl Drop for Projects {
    fn drop(&mut self) {
        cleanup::TEST_REGISTERED_PROJECT_IDENTITIES.with(|p| *p.borrow_mut() = None);
    }
}
fn fixture() -> (tempfile::TempDir, PathBuf, RootCapabilityContext) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().canonicalize().unwrap().join("中文 审计.tmp");
    std::fs::write(&path, b"preserve exactly").unwrap();
    let capability = issue_root_capability(
        &Uuid::new_v4().to_string(),
        "run",
        "message",
        Some(Path::new("/")),
        RootCapabilityKind::CleanupAudit,
    )
    .unwrap();
    (temp, path, capability)
}
fn request(path: &Path, capability: &RootCapabilityContext) -> AuditRootCleanupRequest {
    AuditRootCleanupRequest {
        root_path: "/".into(),
        targets: vec![path.to_str().unwrap().into()],
        capability: capability.clone(),
    }
}
fn cancel(token: &str, capability: &RootCapabilityContext) -> Result<()> {
    cancel_root_cleanup(ExecuteRootCleanupRequest {
        audit_token: token.into(),
        capability: capability.clone(),
    })
}

#[tokio::test]
async fn cleanup_api_readonly_audit_cancel_reselect_preserve_target() {
    let _projects = Projects::empty();
    let (temp, path, capability) = fixture();
    let before = std::fs::metadata(&path).unwrap();
    let response = audit_root_cleanup(request(&path, &capability)).unwrap();
    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["executionAvailable"], false);
    assert_eq!(json["destructiveConfirmationRequired"], true);
    assert_eq!(response.target.bytes, 16);
    assert_eq!(
        response.target.hash,
        Some(blake3::hash(b"preserve exactly").to_hex().to_string())
    );
    assert!(audit_root_cleanup(request(&path, &capability)).is_err());
    cancel(&response.audit_token, &capability).unwrap();
    assert!(cancel(&response.audit_token, &capability).is_err());
    let retry = audit_root_cleanup(request(&path, &capability)).unwrap();
    cancel(&retry.audit_token, &capability).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"preserve exactly");
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!(
        (before.ino(), before.mtime(), before.mtime_nsec()),
        (after.ino(), after.mtime(), after.mtime_nsec())
    );
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    revoke_session_workspace_authority(&capability.session_id).unwrap();
}

#[tokio::test]
async fn cleanup_api_rejects_each_wrong_context_field_without_consuming_receipt() {
    let _projects = Projects::empty();
    let (_temp, path, capability) = fixture();
    let response = audit_root_cleanup(request(&path, &capability)).unwrap();
    for field in 0..4 {
        let mut wrong = capability.clone();
        match field {
            0 => wrong.session_id.push('x'),
            1 => wrong.run_id.push('x'),
            2 => wrong.source_message_id.push('x'),
            _ => wrong.nonce.push('x'),
        }
        assert!(cancel(&response.audit_token, &wrong).is_err());
        assert!(audit_root_cleanup(request(&path, &wrong)).is_err());
    }
    cancel(&response.audit_token, &capability).unwrap();
    let allocation = issue_root_capability(
        &capability.session_id,
        "run",
        "message",
        Some(Path::new("/")),
        RootCapabilityKind::AllocateChild,
    )
    .unwrap();
    assert!(audit_root_cleanup(request(&path, &allocation)).is_err());
    revoke_session_workspace_authority(&capability.session_id).unwrap();
}

#[tokio::test]
async fn cleanup_api_expiry_and_unknown_restart_token_never_restore_authority() {
    let _projects = Projects::empty();
    let (_temp, path, capability) = fixture();
    expire_confirmation_for_test(&capability);
    assert!(audit_root_cleanup(request(&path, &capability)).is_err());
    assert!(cancel("token-from-another-process", &capability).is_err());
    let capability = issue_root_capability(
        &capability.session_id,
        "run",
        "message",
        Some(Path::new("/")),
        RootCapabilityKind::CleanupAudit,
    )
    .unwrap();
    let response = audit_root_cleanup(request(&path, &capability)).unwrap();
    cleanup_registry()
        .lock()
        .unwrap()
        .get_mut(&response.audit_token)
        .unwrap()
        .capability
        .expires_at = Instant::now();
    assert!(cancel(&response.audit_token, &capability).is_err());
    assert!(!cleanup_registry()
        .lock()
        .unwrap()
        .contains_key(&response.audit_token));
    assert!(audit_root_cleanup(request(&path, &capability)).is_err());
    revoke_session_workspace_authority(&capability.session_id).unwrap();
}

#[tokio::test]
async fn cleanup_api_revocation_during_inspection_and_after_audit_cannot_revive_tokens() {
    let _projects = Projects::empty();
    let (_temp, path, capability) = fixture();
    assert!(
        audit_root_cleanup_with_hook(request(&path, &capability), || {
            revoke_session_workspace_authority(&capability.session_id)
        })
        .is_err()
    );
    let capability = issue_root_capability(
        &capability.session_id,
        "run",
        "message",
        Some(Path::new("/")),
        RootCapabilityKind::CleanupAudit,
    )
    .unwrap();
    let response = audit_root_cleanup(request(&path, &capability)).unwrap();
    revoke_session_workspace_authority(&capability.session_id).unwrap();
    assert!(cancel(&response.audit_token, &capability).is_err());
    assert!(audit_root_cleanup(request(&path, &capability)).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"preserve exactly");
}

#[tokio::test]
async fn cleanup_api_source_replacement_during_audit_invalidates_summary() {
    let _projects = Projects::empty();
    let (_temp, path, capability) = fixture();
    let original = path.with_extension("original");
    assert!(
        audit_root_cleanup_with_hook(request(&path, &capability), || {
            std::fs::rename(&path, &original)?;
            std::fs::write(&path, b"replacement")?;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    assert_eq!(std::fs::read(&original).unwrap(), b"preserve exactly");
    let response = audit_root_cleanup(request(&path, &capability)).unwrap();
    cancel(&response.audit_token, &capability).unwrap();
    revoke_session_workspace_authority(&capability.session_id).unwrap();
}

#[tokio::test]
async fn cleanup_api_closed_session_and_project_boundary_fail_without_receipt() {
    let _projects = Projects::empty();
    let (_temp, path, capability) = fixture();
    cleanup::TEST_REGISTERED_PROJECT_IDENTITIES
        .with(|p| *p.borrow_mut() = Some(vec![path.parent().unwrap().to_str().unwrap().into()]));
    assert!(audit_root_cleanup(request(&path, &capability)).is_err());
    cleanup::TEST_REGISTERED_PROJECT_IDENTITIES.with(|p| *p.borrow_mut() = Some(Vec::new()));
    let barrier = begin_session_close(&capability.session_id).unwrap();
    barrier.wait_for_idle().await.unwrap();
    assert!(audit_root_cleanup(request(&path, &capability)).is_err());
    reopen_session_access(&capability.session_id).unwrap();
    let response = audit_root_cleanup(request(&path, &capability)).unwrap();
    cancel(&response.audit_token, &capability).unwrap();
    revoke_session_workspace_authority(&capability.session_id).unwrap();
}

#[tokio::test]
async fn cleanup_api_concurrent_audits_reserve_one_receipt() {
    let _projects = Projects::empty();
    let (_temp, path, capability) = fixture();
    let runtime = tokio::runtime::Handle::current();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let other_path = path.clone();
    let other_capability = capability.clone();
    let worker = std::thread::spawn(move || {
        let _runtime = runtime.enter();
        let _projects = Projects::empty();
        audit_root_cleanup_with_hook(request(&other_path, &other_capability), || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(audit_root_cleanup(request(&path, &capability)).is_err());
    release_tx.send(()).unwrap();
    let response = worker.join().unwrap().unwrap();
    cancel(&response.audit_token, &capability).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"preserve exactly");
    revoke_session_workspace_authority(&capability.session_id).unwrap();
}
