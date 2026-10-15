use super::*;

#[test]
fn root_disk_usage_reports_real_capacity_and_rejects_non_roots() {
    let usage = inspect_root_disk_usage(Path::new("/")).unwrap();
    assert_eq!(usage.root_path, "/");
    assert_eq!(usage.capacity_bytes, fs2::total_space("/").unwrap());
    assert!(usage.capacity_bytes > 0);
    assert!(usage.available_bytes <= usage.capacity_bytes);
    let data = serde_json::to_value(&usage).unwrap();
    assert_eq!(data.as_object().unwrap().len(), 3);
    assert_eq!(data["rootPath"], "/");
    assert!(data["availableBytes"].is_u64());
    let (fixture, workspace) = fixture();
    let alias = fixture.path().join("root-alias");
    std::os::unix::fs::symlink("/", &alias).unwrap();
    for invalid in [
        workspace.as_path(),
        alias.as_path(),
        Path::new("relative"),
        Path::new("/tmp/.."),
    ] {
        assert!(inspect_root_disk_usage(invalid).is_err());
    }
}

fn request(path: &Path, state: WorkspaceState) -> AcquireWorkspaceLeaseRequest {
    AcquireWorkspaceLeaseRequest {
        requested_path: path.to_string_lossy().into_owned(),
        expected_identity: normalize_identity(path).unwrap(),
        expected_state: state,
    }
}

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap().join("中文 工作区");
    std::fs::create_dir(&workspace).unwrap();
    (temp, workspace)
}

#[test]
fn lease_is_single_use_and_session_binding_is_authoritative() {
    let (_temp, workspace) = fixture();
    let acquired =
        acquire_workspace_lease(request(&workspace, WorkspaceState::EmptyDirectory)).unwrap();
    assert!(consume_workspace_lease(&acquired.lease_id, workspace.parent().unwrap()).is_err());
    let consumed = consume_workspace_lease(&acquired.lease_id, &workspace).unwrap();
    assert!(consume_workspace_lease(&acquired.lease_id, &workspace).is_err());
    let session = Uuid::new_v4().to_string();
    bind_workspace_lease(&session, consumed).unwrap();
    validate_session_workspace_binding(&session, &workspace, &acquired.lease_id).unwrap();
    assert!(validate_session_workspace_binding(&session, &workspace, "wrong-lease").is_err());
    release_session_workspace_lease(&session).unwrap();
    assert!(!session_has_workspace_lease(&session).unwrap());
    let refreshed = reacquire_existing_session_workspace_lease(&session, &workspace).unwrap();
    assert_ne!(refreshed, acquired.lease_id);
    validate_session_workspace_binding(&session, &workspace, &refreshed).unwrap();
    release_session_workspace_lease(&session).unwrap();
}

#[test]
fn replacing_directory_or_ancestor_invalidates_lease() {
    for replace_ancestor in [false, true] {
        let (_temp, workspace) = fixture();
        let target = workspace.join("child");
        std::fs::create_dir(&target).unwrap();
        let acquired =
            acquire_workspace_lease(request(&target, WorkspaceState::EmptyDirectory)).unwrap();
        let replaced = if replace_ancestor {
            &workspace
        } else {
            &target
        };
        let moved = replaced.with_extension("moved");
        std::fs::rename(replaced, &moved).unwrap();
        std::fs::create_dir(replaced).unwrap();
        if replace_ancestor {
            std::fs::create_dir(&target).unwrap();
        }
        assert!(consume_workspace_lease(&acquired.lease_id, &target).is_err());
        release_workspace_lease(&acquired.lease_id).unwrap();
    }
}

#[test]
fn canonical_reopen_rejects_replacement_and_symlink_swap() {
    let (_temp, workspace) = fixture();
    let moved = workspace.with_extension("moved");
    assert!(acquire_workspace_lease_with_hooks(
        request(&workspace, WorkspaceState::EmptyDirectory),
        || {
            std::fs::rename(&workspace, &moved)?;
            std::os::unix::fs::symlink(&moved, &workspace)?;
            Ok(())
        },
        || Ok(())
    )
    .is_err());
    assert!(moved.is_dir());
}

#[test]
fn new_workspace_rejects_collisions_and_retains_failed_rollback() {
    let (_temp, workspace) = fixture();
    let child = workspace.join("new");
    assert!(
        acquire_workspace_lease_with_hook(request(&child, WorkspaceState::Missing), || {
            std::fs::create_dir(&child)?;
            std::fs::write(child.join("existing-data"), "preserve")?;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(child.join("existing-data")).unwrap(),
        "preserve"
    );
    let child = workspace.join("created");
    let acquired = acquire_workspace_lease(request(&child, WorkspaceState::Missing)).unwrap();
    assert!(acquired.created);
    std::fs::write(child.join("foreign.txt"), "preserve").unwrap();
    assert!(release_workspace_lease(&acquired.lease_id).is_err());
    assert!(registry()
        .lock()
        .unwrap()
        .pending
        .contains_key(&acquired.lease_id));
    assert_eq!(
        std::fs::read_to_string(child.join("foreign.txt")).unwrap(),
        "preserve"
    );
    std::fs::remove_file(child.join("foreign.txt")).unwrap();
    release_workspace_lease(&acquired.lease_id).unwrap();
    assert!(!child.exists());

    let acquired = acquire_workspace_lease(request(&child, WorkspaceState::Missing)).unwrap();
    std::fs::remove_dir(&child).unwrap();
    std::fs::create_dir(&child).unwrap();
    std::fs::write(child.join("replacement.txt"), "preserve").unwrap();
    release_workspace_lease(&acquired.lease_id).unwrap();
    assert_eq!(
        std::fs::read_to_string(child.join("replacement.txt")).unwrap(),
        "preserve"
    );
}

#[tokio::test]
async fn close_drains_active_access_and_transaction_failure_reopens() {
    let session = Uuid::new_v4().to_string();
    let permit = acquire_session_access(&session).unwrap();
    let transaction = begin_session_lifecycle_transaction(&session).unwrap();
    assert!(acquire_session_access(&session).is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), transaction.wait_for_idle())
            .await
            .is_err()
    );
    drop(permit);
    transaction.wait_for_idle().await.unwrap();
    drop(transaction);
    drop(acquire_session_access(&session).unwrap());
    let transaction = begin_session_lifecycle_transaction(&session).unwrap();
    transaction.wait_for_idle().await.unwrap();
    transaction.commit_closed();
    assert!(acquire_session_access(&session).is_err());
    reopen_session_access(&session).unwrap();
}

#[test]
fn identity_rejects_root_relative_traversal_and_stale_inspection() {
    let (_temp, workspace) = fixture();
    for path in [
        Path::new("/"),
        Path::new("relative"),
        Path::new("/Users/../tmp"),
    ] {
        assert!(acquire_workspace_lease(AcquireWorkspaceLeaseRequest {
            requested_path: path.to_string_lossy().into_owned(),
            expected_identity: path.to_string_lossy().into_owned(),
            expected_state: WorkspaceState::EmptyDirectory
        })
        .is_err());
    }
    let mut stale = request(&workspace, WorkspaceState::EmptyDirectory);
    stale.expected_identity.push_str("-changed");
    assert!(acquire_workspace_lease(stale).is_err());
}

#[test]
fn resource_reads_reject_hard_links_symlinks_escape_and_oversized_files() {
    let (_temp, workspace) = fixture();
    let file = workspace.join("文件.txt");
    std::fs::write(&file, "Mac 中文").unwrap();
    assert_eq!(
        read_workspace_file_by_handle(&workspace, &file).unwrap().1,
        "Mac 中文"
    );
    let alias = workspace.join("alias");
    std::os::unix::fs::symlink(&file, &alias).unwrap();
    assert!(read_workspace_file_by_handle(&workspace, &alias).is_err());
    std::fs::hard_link(&file, workspace.join("hard-link")).unwrap();
    assert!(read_workspace_file_by_handle(&workspace, &file).is_err());
    assert!(read_workspace_file_by_handle(&workspace, &workspace.join("../outside")).is_err());
    let large = workspace.join("large");
    File::create(&large)
        .unwrap()
        .set_len(2 * 1024 * 1024 + 1)
        .unwrap();
    assert!(read_workspace_file_by_handle(&workspace, &large).is_err());
}

fn allocation_request(parent: &Path, session: &str) -> AllocateWorkspaceChildRequest {
    AllocateWorkspaceChildRequest {
        container_path: parent.to_string_lossy().into_owned(),
        suggested_name: "中文项目".into(),
        capability: issue_root_capability(
            session,
            "run",
            "message",
            Some(parent),
            RootCapabilityKind::AllocateChild,
        )
        .unwrap(),
    }
}

#[tokio::test]
async fn project_child_permission_denied_preserves_confirmation_for_retry() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, parent) = fixture();
    let owner = Uuid::new_v4().to_string();
    let request = allocation_request(&parent, &owner);
    let repeat = || AllocateWorkspaceChildRequest {
        container_path: request.container_path.clone(),
        suggested_name: request.suggested_name.clone(),
        capability: request.capability.clone(),
    };
    for mode in [0o500, 0o000] {
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(mode)).unwrap();
        let result = allocate_workspace_child(repeat());
        let mut forged = repeat();
        forged.capability.nonce = Uuid::new_v4().to_string();
        let forged_result = allocate_workspace_child(forged);
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(workspace_allocation_permission_error_data(&forged_result.unwrap_err()).is_none());
        let error = result.unwrap_err();
        assert_eq!(
            workspace_allocation_permission_error_data(&error),
            Some(serde_json::json!({
                "code": "workspace_permission_denied", "retryable": true, "capabilityPreserved": true,
            }))
        );
        assert!(!error.to_string().contains(parent.to_str().unwrap()));
        assert!(!parent.join(&request.suggested_name).exists());
    }
    let response = allocate_workspace_child(repeat()).unwrap();
    assert_eq!(
        allocate_workspace_child(repeat()).unwrap().lease_id,
        response.lease_id
    );
    release_workspace_lease(&response.lease_id).unwrap();
    revoke_session_workspace_authority(&owner).unwrap();
    assert!(!parent.join(&request.suggested_name).exists());
}

#[tokio::test]
async fn project_child_post_creation_permission_failure_consumes_confirmation() {
    let (_temp, parent) = fixture();
    let request = allocation_request(&parent, &Uuid::new_v4().to_string());
    let retry = AllocateWorkspaceChildRequest {
        container_path: request.container_path.clone(),
        suggested_name: request.suggested_name.clone(),
        capability: request.capability.clone(),
    };
    let error = allocate_workspace_child_with_lifecycle_hooks(
        request,
        || Ok(()),
        |_| Err(std::io::Error::from_raw_os_error(libc::EACCES).into()),
        bind_allocated_workspace_owner,
        release_workspace_lease,
    )
    .unwrap_err();
    assert!(workspace_allocation_permission_error_data(&error).is_none());
    assert!(!parent.join(&retry.suggested_name).exists());
    assert!(allocate_workspace_child(retry).is_err());
}

#[tokio::test]
async fn project_child_allocation_is_exact_owned_and_idempotent() {
    let (_temp, parent) = fixture();
    std::fs::write(parent.join("keep.txt"), "unchanged").unwrap();
    let owner = Uuid::new_v4().to_string();
    let request = allocation_request(&parent, &owner);
    let repeat = || AllocateWorkspaceChildRequest {
        container_path: request.container_path.clone(),
        suggested_name: request.suggested_name.clone(),
        capability: request.capability.clone(),
    };
    let response = allocate_workspace_child(repeat()).unwrap();
    assert_eq!(Path::new(&response.working_dir), parent.join("中文项目"));
    assert!(response.created);
    assert!(!session_has_workspace_lease(&owner).unwrap());
    assert_eq!(
        allocate_workspace_child(repeat()).unwrap().lease_id,
        response.lease_id
    );
    let mut wrong = repeat();
    wrong.suggested_name = "other".into();
    assert!(allocate_workspace_child(wrong).is_err());
    assert!(consume_allocated_workspace_lease(
        &response.lease_id,
        Path::new(&response.working_dir),
        "another-session"
    )
    .is_err());
    let lease = consume_allocated_workspace_lease(
        &response.lease_id,
        Path::new(&response.working_dir),
        &owner,
    )
    .unwrap();
    bind_workspace_lease(&owner, lease).unwrap();
    assert!(validate_session_workspace_lease(&owner, &parent).is_err());
    assert!(consume_allocated_workspace_lease(
        &response.lease_id,
        Path::new(&response.working_dir),
        &owner
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(parent.join("keep.txt")).unwrap(),
        "unchanged"
    );
    release_session_workspace_lease(&owner).unwrap();
    revoke_session_workspace_authority(&owner).unwrap();
    assert!(parent.join("中文项目").is_dir());
}

#[tokio::test]
async fn project_child_collision_and_symlink_never_select_a_different_child() {
    let (temp, parent) = fixture();
    let child = parent.join("中文项目");
    std::fs::create_dir(&child).unwrap();
    std::fs::write(child.join("keep.txt"), "unchanged").unwrap();
    assert!(allocate_workspace_child(allocation_request(&parent, "collision")).is_err());
    assert!(!parent.join("中文项目-2").exists());
    let alias = temp.path().canonicalize().unwrap().join("alias");
    std::os::unix::fs::symlink(&parent, &alias).unwrap();
    assert!(allocate_workspace_child(allocation_request(&alias, "symlink")).is_err());
    assert!(allocate_workspace_child(allocation_request(Path::new("/"), "root")).is_err());
    assert_eq!(
        std::fs::read_to_string(child.join("keep.txt")).unwrap(),
        "unchanged"
    );
}

#[tokio::test]
async fn project_child_replaced_parent_is_rejected_and_failed_creation_is_rolled_back() {
    let (_temp, parent) = fixture();
    let request = allocation_request(&parent, "replacement");
    let moved = parent.with_file_name("moved");
    assert!(allocate_workspace_child_with_hook(request, || {
        std::fs::rename(&parent, &moved)?;
        std::fs::create_dir(&parent)?;
        Ok(())
    })
    .is_err());
    assert!(!parent.join("中文项目").exists());
    assert!(!moved.join("中文项目").exists());
    let request = allocation_request(&parent, "rollback");
    assert!(allocate_workspace_child_with_lifecycle_hooks(
        request,
        || Ok(()),
        |_| Err(anyhow!("injected post-create failure")),
        bind_allocated_workspace_owner,
        release_workspace_lease
    )
    .is_err());
    assert!(!parent.join("中文项目").exists());
}

#[tokio::test]
async fn project_child_revoked_or_expired_tokens_do_not_create_directories() {
    let (_temp, parent) = fixture();
    let request = allocation_request(&parent, "revoked");
    revoke_session_workspace_authority("revoked").unwrap();
    assert!(allocate_workspace_child(request).is_err());
    let request = allocation_request(&parent, "expired");
    capability_registry()
        .lock()
        .unwrap()
        .get_mut(&request.capability.nonce)
        .unwrap()
        .expires_at = Instant::now();
    assert!(allocate_workspace_child(request).is_err());
    assert!(std::fs::read_dir(&parent).unwrap().next().is_none());
}
