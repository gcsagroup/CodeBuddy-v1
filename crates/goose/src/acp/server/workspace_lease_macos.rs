use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::Entry, HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::secure_fs::macos::{
    create_directory_at, final_path, object_id, open_directory_at, open_directory_chain,
    open_file_at, validate_directory_chain, validate_entry,
};

include!("workspace_lease/lifecycle.rs");
include!("workspace_lease/allocation.rs");
// Native inspection and in-memory read-only audit receipts.
#[path = "workspace_lease/cleanup_macos.rs"]
mod cleanup;
use cleanup::RootCleanupTargetSummary;
include!("workspace_lease/cleanup_contract.rs");
include!("workspace_lease/cleanup_api_macos.rs");

pub(super) const ALLOCATE_PROJECT_CHILD_METHOD: &str =
    "_goose/unstable/workspace/project-container/v1/allocate-child";

#[derive(Debug, thiserror::Error)]
#[error("workspace allocation permission denied")]
struct WorkspaceAllocationPermissionDenied;

// Only call before creation. Permission errors after creation may have rollback
// failures and must never advertise that retrying the same capability is safe.
fn path_free_workspace_permission_error(error: anyhow::Error) -> anyhow::Error {
    if error.chain().any(|source| {
        source
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
    }) {
        WorkspaceAllocationPermissionDenied.into()
    } else {
        error
    }
}

pub(super) fn workspace_allocation_permission_error_data(
    error: &anyhow::Error,
) -> Option<serde_json::Value> {
    error
        .downcast_ref::<WorkspaceAllocationPermissionDenied>()
        .map(|_| {
            serde_json::json!({
                "code": "workspace_permission_denied",
                "retryable": true,
                "capabilityPreserved": true,
            })
        })
}

fn pin_project_container(path: &Path) -> Result<Vec<File>> {
    let identity = normalize_identity(path)?;
    if identity == "/" {
        bail!("choose a writable project parent instead of the filesystem root");
    }
    let handles = open_directory_chain(path)?;
    validate_directory_chain(path, &handles)?;
    if normalize_identity(&final_path(handles.last().expect("root exists"))?)? != identity {
        bail!("project container must use its canonical directory identity");
    }
    Ok(handles)
}

fn acquire_project_child_lease(
    container: &Path,
    name: &str,
    mut handles: Vec<File>,
) -> Result<AcquireWorkspaceLeaseResponse> {
    validate_directory_chain(container, &handles).map_err(path_free_workspace_permission_error)?;
    let leaf = create_directory_at(
        handles.last().expect("root exists"),
        std::ffi::OsStr::new(name),
    )
    .map_err(|error| {
        if error.is::<crate::secure_fs::macos::DirectoryCreationPermissionDenied>() {
            WorkspaceAllocationPermissionDenied.into()
        } else {
            error
        }
    })?;
    handles.push(leaf.file);
    let path = container.join(name);
    let lease = WorkspaceLease {
        lease_id: String::new(),
        normalized_identity: normalize_identity(&path)?,
        working_dir: path,
        _ancestor_chain: handles,
        created: true,
        created_reference: Some(leaf.reference),
        owner_session_id: None,
    };
    if let Err(error) = validate_workspace_lease(&lease, &lease.working_dir) {
        rollback_empty_created_workspace(&lease)
            .with_context(|| format!("{error}; child rollback failed"))?;
        return Err(error);
    }
    register_pending_workspace_lease(lease)
}

pub(super) fn validate_project_container_path(path: &Path) -> Result<()> {
    pin_project_container(path).map(|_| ())
}

pub(crate) fn revoke_session_workspace_authority(session_id: &str) -> Result<()> {
    // Same lock order as audit commit/cancel: receipts before capabilities.
    let mut audits = cleanup_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup audit registry is unavailable"))?;
    audits.retain(|_, audit| audit.capability.context.session_id != session_id);
    capability_registry()
        .lock()
        .map_err(|_| anyhow!("capability registry unavailable"))?
        .retain(|_, capability| capability.context.session_id != session_id);
    allocated_workspace_receipt_registry()
        .lock()
        .map_err(|_| anyhow!("receipt registry unavailable"))?
        .retain(|_, receipt| receipt.capability.session_id != session_id);
    Ok(())
}

fn normalize_identity(path: &Path) -> Result<String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        bail!("workspace identity must be an absolute local path");
    }
    path.components()
        .collect::<PathBuf>()
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("workspace path is not valid Unicode"))
}

pub(super) fn validate_root_container_path(path: &Path) -> Result<()> {
    if normalize_identity(path)? != "/" {
        bail!("root container must be the filesystem root");
    }
    Ok(())
}

pub(crate) fn inspect_root_disk_usage(root: &Path) -> Result<RootDiskUsage> {
    validate_root_container_path(root)?;
    let handles = open_directory_chain(root)?;
    validate_directory_chain(root, &handles)?;
    let canonical_root = final_path(
        handles
            .last()
            .ok_or_else(|| anyhow!("root has no handle"))?,
    )?;
    validate_root_container_path(&canonical_root)?;
    Ok(RootDiskUsage {
        root_path: canonical_root.to_string_lossy().into_owned(),
        capacity_bytes: fs2::total_space(&canonical_root)?,
        available_bytes: fs2::available_space(&canonical_root)?,
    })
}

fn acquire_handles<F, G>(
    request: &AcquireWorkspaceLeaseRequest,
    before_reopen: F,
    before_create: G,
) -> Result<WorkspaceLease>
where
    F: FnOnce() -> Result<()>,
    G: FnOnce() -> Result<()>,
{
    let requested = Path::new(&request.requested_path);
    normalize_identity(requested)?;
    let expected = normalize_identity(Path::new(&request.expected_identity))?;
    let parent = requested
        .parent()
        .ok_or_else(|| anyhow!("filesystem roots cannot be leased"))?;
    let existing = if request.expected_state == WorkspaceState::Missing {
        parent
    } else {
        requested
    };
    // Resolve the path selected during inspection, then pin every canonical component without following links.
    let canonical = existing.canonicalize()?;
    let mut handles = open_directory_chain(&canonical)?;
    let planned = if request.expected_state == WorkspaceState::Missing {
        canonical.join(
            requested
                .file_name()
                .ok_or_else(|| anyhow!("workspace has no leaf"))?,
        )
    } else {
        canonical.clone()
    };
    if normalize_identity(&planned)? != expected {
        bail!("workspace identity changed since inspection");
    }
    before_reopen()?;
    let reopened = open_directory_chain(&canonical)?;
    if handles.len() != reopened.len() {
        bail!("canonical workspace reopened as a different directory object");
    }
    for (original, current) in handles.iter().zip(&reopened) {
        if object_id(original)? != object_id(current)? {
            bail!("canonical workspace reopened as a different directory object");
        }
    }
    let mut created_reference = None;
    if request.expected_state == WorkspaceState::Missing {
        before_create()?;
        validate_directory_chain(&canonical, &handles)?;
        let leaf = create_directory_at(
            handles.last().expect("root exists"),
            requested.file_name().expect("leaf checked"),
        )?;
        handles.push(leaf.file);
        created_reference = Some(leaf.reference);
    }
    let lease = WorkspaceLease {
        lease_id: String::new(),
        _ancestor_chain: handles,
        working_dir: planned,
        normalized_identity: expected,
        created: request.expected_state == WorkspaceState::Missing,
        created_reference,
        owner_session_id: None,
    };
    if let Err(error) = validate_workspace_lease(&lease, &lease.working_dir) {
        if lease.created {
            rollback_empty_created_workspace(&lease)
                .with_context(|| format!("{error}; created workspace rollback failed"))?;
        }
        return Err(error);
    }
    Ok(lease)
}

fn validate_workspace_lease(lease: &WorkspaceLease, cwd: &Path) -> Result<()> {
    if normalize_identity(cwd)? != lease.normalized_identity {
        bail!("workspace lease cwd does not match its authoritative workspace");
    }
    validate_directory_chain(&lease.working_dir, &lease._ancestor_chain)?;
    if normalize_identity(&final_path(
        lease
            ._ancestor_chain
            .last()
            .ok_or_else(|| anyhow!("workspace has no handle"))?,
    )?)? != lease.normalized_identity
    {
        bail!("workspace lease handle identity changed");
    }
    Ok(())
}

fn rollback_empty_created_workspace(lease: &WorkspaceLease) -> Result<()> {
    lease
        .created_reference
        .as_ref()
        .ok_or_else(|| anyhow!("workspace has no creation reference"))?
        .remove_empty()
}

pub(crate) fn read_workspace_file_by_handle(
    workspace: &Path,
    requested_file: &Path,
) -> Result<(PathBuf, String)> {
    const MAX_BYTES: u64 = 2 * 1024 * 1024;
    let relative = requested_file
        .strip_prefix(workspace)
        .context("file resource link is outside the authoritative workspace")?;
    let components: Vec<_> = relative
        .components()
        .map(|c| match c {
            Component::Normal(name) => Ok(name),
            _ => Err(anyhow!("file resource link contains invalid components")),
        })
        .collect::<Result<_>>()?;
    let (name, parents) = components
        .split_last()
        .ok_or_else(|| anyhow!("file resource link has no filename"))?;
    let mut chain = open_directory_chain(workspace)?;
    let mut parent_path = workspace.to_path_buf();
    for name in parents {
        chain.push(open_directory_at(chain.last().expect("root exists"), name)?);
        parent_path.push(name);
    }
    let parent = chain.last().expect("root exists");
    let mut file = open_file_at(parent, name)?;
    let before = file.metadata()?;
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_BYTES {
        bail!(
            "file resource must be a regular singly-linked file within the attachment size limit"
        );
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    validate_directory_chain(&parent_path, &chain)?;
    validate_entry(parent, name, &file)?;
    if bytes.len() as u64 > MAX_BYTES
        || before.len() != after.len()
        || after.len() != bytes.len() as u64
        || before.modified()? != after.modified()?
        || after.nlink() != 1
    {
        bail!("file resource link changed while it was being read");
    }
    let path = final_path(&file)?;
    if path != requested_file {
        bail!("file resource link identity changed");
    }
    Ok((
        path,
        String::from_utf8(bytes).context("file resource link is not valid UTF-8")?,
    ))
}

#[cfg(test)]
#[path = "workspace_lease/macos_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "workspace_lease/cleanup_api_macos_tests.rs"]
mod cleanup_api_tests;
