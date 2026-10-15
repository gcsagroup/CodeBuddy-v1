use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::Entry, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::mem::MaybeUninit;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use uuid::Uuid;
use winapi::shared::winerror::{ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED, ERROR_NO_MORE_FILES};
use winapi::um::fileapi::{
    GetFileInformationByHandle, GetFinalPathNameByHandleW, SetFileInformationByHandle,
    BY_HANDLE_FILE_INFORMATION, FILE_DISPOSITION_INFO, FILE_ID_INFO,
};
use winapi::um::minwinbase::{
    FileDispositionInfo, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, FileIdInfo,
};
use winapi::um::winbase::GetFileInformationByHandleEx;

include!("workspace_lease/lifecycle.rs");
include!("workspace_lease/allocation.rs");
include!("workspace_lease/cleanup_policy.rs");
include!("workspace_lease/cleanup_contract.rs");

pub(super) const ALLOCATE_CHILD_METHOD: &str = "_goose/unstable/workspace/lease/allocate-child";
const MAX_RESOURCE_LINK_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CLEANUP_JOURNAL_BYTES: u64 = 64 * 1024;
pub(super) const WORKSPACE_PERMISSION_DENIED_CODE: &str = "workspace_permission_denied";

const FILE_LIST_DIRECTORY: u32 = 0x0001;
const FILE_TRAVERSE: u32 = 0x0020;
const FILE_READ_ATTRIBUTES: u32 = 0x0080;
const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_SHARE_DELETE: u32 = 0x0000_0004;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
const FILE_OPEN: u32 = 0x0000_0001;
const FILE_CREATE: u32 = 0x0000_0002;
const FILE_OPEN_IF: u32 = 0x0000_0003;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_NAME_NORMALIZED: u32 = 0x0;
const VOLUME_NAME_DOS: u32 = 0x0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PermanentlyDeleteQuarantineRequest {
    pub quarantine_token: String,
    pub capability: RootCapabilityContext,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RetryCleanupRecoveryRequest {
    pub capability: RootCapabilityContext,
    pub quarantine_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ListCleanupRecoveryRequest {
    pub capability: RootCapabilityContext,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CleanupRecoveryDiagnostic {
    quarantine_token: String,
    phase: CleanupJournalPhase,
    original_path: String,
    quarantine_path: String,
    retry_original_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CleanupRecoveryListResponse {
    recoveries: Vec<CleanupRecoveryDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RetryCleanupRecoveryResponse {
    restored: bool,
    reveal_path: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("workspace allocation permission denied")]
struct WorkspaceAllocationPermissionDenied;

fn is_windows_permission_denied(error: &anyhow::Error) -> bool {
    const STATUS_ACCESS_DENIED: i32 = 0xC000_0022_u32 as i32;
    error.chain().any(|source| {
        source
            .downcast_ref::<io::Error>()
            .and_then(io::Error::raw_os_error)
            .is_some_and(|code| code == 5 || code == STATUS_ACCESS_DENIED)
            || {
                let normalized = source.to_string().to_ascii_lowercase();
                normalized.contains("access is denied")
                    || normalized.contains("ntstatus 0xc0000022")
            }
    })
}

pub(super) fn path_free_workspace_permission_error(error: anyhow::Error) -> anyhow::Error {
    if is_windows_permission_denied(&error) {
        anyhow::Error::new(WorkspaceAllocationPermissionDenied)
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
                "code": WORKSPACE_PERMISSION_DENIED_CODE,
                "retryable": true,
                "capabilityPreserved": true,
            })
        })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RootCleanupQuarantineResponse {
    pub quarantine_token: String,
    pub target: RootCleanupTargetSummary,
    pub permanent_confirmation_required: bool,
}

struct RootCleanupAudit {
    root_identity: String,
    root_path: PathBuf,
    root_object_id: DirectoryObjectId,
    root_handle: File,
    ancestor_chain: Vec<CleanupAncestor>,
    target_path: PathBuf,
    target_object_id: DirectoryObjectId,
    target_handle: File,
    target_link_count: Option<u32>,
    summary: RootCleanupTargetSummary,
    capability: RootCapabilityContext,
    reserved_capability: RootCapability,
}

struct RootCleanupQuarantine {
    quarantine_token: String,
    capability: RootCapabilityContext,
    original_path: PathBuf,
    quarantine_path: PathBuf,
    quarantine_dir: PathBuf,
    quarantine_dir_handle: Option<File>,
    target_handle: Option<File>,
    original_parent_handle: File,
    original_name: OsString,
    target_object_id: DirectoryObjectId,
    target_link_count: Option<u32>,
    summary: RootCleanupTargetSummary,
    authority: QuarantineAuthority,
    generation: Uuid,
    _owner_lock: File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuarantineAuthority {
    ActiveConfirmable,
    RestoreOnlyRevoked,
    RestoreOnlyExpired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupJournalRecord {
    schema_version: u32,
    quarantine_token: String,
    capability_binding: String,
    owner_session_id: String,
    owner_run_id: String,
    owner_source_message_id: String,
    original_path: PathBuf,
    original_parent_object_id: DirectoryObjectId,
    quarantine_path: PathBuf,
    quarantine_dir: PathBuf,
    target_object_id: DirectoryObjectId,
    target_link_count: Option<u32>,
    target_type: CleanupJournalTargetType,
    target_bytes: u64,
    target_modified_millis: u128,
    target_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CleanupJournalTargetType {
    File,
    EmptyDirectory,
}

fn cleanup_journal_target_type(summary: &RootCleanupTargetSummary) -> CleanupJournalTargetType {
    if summary.target_type == "empty-directory" {
        CleanupJournalTargetType::EmptyDirectory
    } else {
        CleanupJournalTargetType::File
    }
}

fn cleanup_capability_binding(capability: &RootCapabilityContext) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in [
        &capability.session_id,
        &capability.run_id,
        &capability.source_message_id,
        &capability.nonce,
    ] {
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CleanupJournalPhase {
    Planned,
    Quarantined,
    RestorePlanned,
    Restored,
    DeletePlanned,
    Deleted,
    Orphan,
}

impl CleanupJournalPhase {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Restored | Self::Deleted)
    }

    fn can_transition_to(self, next: Self) -> bool {
        if self.is_terminal() {
            return false;
        }
        if self == next {
            return true;
        }
        match self {
            Self::Planned => matches!(
                next,
                Self::Quarantined | Self::RestorePlanned | Self::Restored | Self::Orphan
            ),
            Self::Quarantined => matches!(
                next,
                Self::RestorePlanned | Self::DeletePlanned | Self::Restored | Self::Orphan
            ),
            Self::RestorePlanned => matches!(next, Self::Restored | Self::Orphan),
            Self::DeletePlanned => matches!(
                next,
                Self::RestorePlanned | Self::Restored | Self::Deleted | Self::Orphan
            ),
            Self::Orphan => matches!(next, Self::RestorePlanned | Self::Restored | Self::Deleted),
            Self::Restored | Self::Deleted => false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupJournalEntry {
    phase: CleanupJournalPhase,
    record: CleanupJournalRecord,
    mac: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupJournalSigningPayload<'a> {
    phase: CleanupJournalPhase,
    record: &'a CleanupJournalRecord,
}

struct CleanupAncestor {
    path: PathBuf,
    object_id: DirectoryObjectId,
    handle: File,
}

struct CreatedQuarantineDirGuard {
    path: PathBuf,
    handle: Option<File>,
    committed: bool,
}

impl CreatedQuarantineDirGuard {
    fn new(path: PathBuf, handle: File) -> Self {
        Self {
            path,
            handle: Some(handle),
            committed: false,
        }
    }

    fn handle(&self) -> &File {
        self.handle.as_ref().expect("quarantine handle exists")
    }

    fn open_delete_handle(&self) -> Result<File> {
        let delete_handle = open_cleanup_directory_for_delete(&self.path)?;
        ensure_same_directory_object(self.handle(), &delete_handle)?;
        Ok(delete_handle)
    }

    fn commit(mut self, delete_handle: File) -> File {
        self.committed = true;
        drop(self.handle.take());
        delete_handle
    }

    fn rollback(mut self) -> Result<()> {
        let delete_handle = self.open_delete_handle()?;
        drop(self.handle.take());
        self.committed = true;
        let result = delete_created_quarantine_directory(&delete_handle).with_context(|| {
            format!(
                "cleanup quarantine wrapper remains at {}; manual cleanup is required",
                self.path.display()
            )
        });
        drop(delete_handle);
        result
    }
}

impl Drop for CreatedQuarantineDirGuard {
    fn drop(&mut self) {
        if !self.committed {
            let delete_handle = self.open_delete_handle();
            drop(self.handle.take());
            self.committed = true;
            if let Err(error) =
                delete_handle.and_then(|handle| delete_created_quarantine_directory(&handle))
            {
                tracing::error!(path = %self.path.display(), %error, "failed to rollback a newly-created cleanup quarantine directory");
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
enum DirectoryObjectId {
    FileIdInfo {
        volume_serial_number: u64,
        file_id: [u8; 16],
    },
    LegacyFileIndex {
        volume_serial_number: u32,
        file_index: u64,
    },
}

fn cleanup_registry() -> &'static Mutex<HashMap<String, RootCleanupAudit>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, RootCleanupAudit>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cleanup_quarantine_registry() -> &'static Mutex<HashMap<String, RootCleanupQuarantine>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, RootCleanupQuarantine>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn workspace_authority_revoke_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
pub(super) fn abandon_cleanup_quarantine_for_test(quarantine_token: &str) -> Result<()> {
    cleanup_quarantine_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup quarantine registry is unavailable"))?
        .remove(quarantine_token)
        .ok_or_else(|| anyhow!("cleanup quarantine test receipt is missing"))?;
    Ok(())
}

fn cleanup_journal_dir() -> PathBuf {
    #[cfg(test)]
    return TEST_CLEANUP_JOURNAL_ROOT.with(|root| {
        root.borrow()
            .as_ref()
            .map(|context| context.path.clone())
            .expect("cleanup journal tests must inject a unique journal root")
    });
    #[cfg(not(test))]
    crate::config::paths::Paths::state_dir().join("cleanup-quarantine")
}

fn open_cleanup_journal_dir() -> Result<File> {
    #[cfg(not(test))]
    {
        static HELD_DIRECTORY_CHAIN: OnceLock<Mutex<Option<Vec<File>>>> = OnceLock::new();
        let mut held = HELD_DIRECTORY_CHAIN
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| anyhow!("cleanup journal directory state is unavailable"))?;
        if let Some(chain) = held.as_ref() {
            validate_held_cleanup_journal_chain(chain, &cleanup_journal_dir())?;
            return chain
                .last()
                .ok_or_else(|| anyhow!("cleanup journal directory chain is empty"))?
                .try_clone()
                .map_err(Into::into);
        }
        let chain = open_cleanup_journal_dir_chain_at(&cleanup_journal_dir())?;
        let handle = chain
            .last()
            .ok_or_else(|| anyhow!("cleanup journal directory chain is empty"))?
            .try_clone()?;
        *held = Some(chain);
        Ok(handle)
    }
    #[cfg(test)]
    TEST_CLEANUP_JOURNAL_ROOT.with(|root| {
        root.borrow()
            .as_ref()
            .expect("cleanup journal tests must inject a unique journal root")
            .handle
            .try_clone()
            .map_err(Into::into)
    })
}

#[cfg(test)]
fn open_cleanup_journal_dir_at(path: &Path) -> Result<File> {
    let chain = open_cleanup_journal_dir_chain_at(path)?;
    chain
        .last()
        .ok_or_else(|| anyhow!("cleanup journal directory has no final handle"))?
        .try_clone()
        .map_err(Into::into)
}

fn open_cleanup_journal_dir_chain_at(path: &Path) -> Result<Vec<File>> {
    std::fs::create_dir_all(path)?;
    if std::fs::symlink_metadata(path)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!("cleanup journal directory cannot be a reparse point");
    }
    let chain = open_absolute_directory_chain(path)?;
    let handle = chain
        .last()
        .ok_or_else(|| anyhow!("cleanup journal directory has no final handle"))?
        .try_clone()?;
    if final_identity(&handle)? != normalize_identity(path)? {
        bail!("cleanup journal directory identity is invalid");
    }
    Ok(chain)
}

#[cfg(not(test))]
fn validate_held_cleanup_journal_chain(chain: &[File], path: &Path) -> Result<()> {
    let current = open_absolute_directory_chain(path)?;
    if current.len() != chain.len()
        || current
            .iter()
            .zip(chain)
            .any(|(left, right)| directory_object_id(left).ok() != directory_object_id(right).ok())
    {
        bail!("cleanup journal held directory identity chain changed");
    }
    Ok(())
}

#[derive(Debug)]
struct CleanupJournalDirectoryEntry {
    name: OsString,
    attributes: u32,
}

fn cleanup_journal_directory_entries(
    directory: &File,
) -> Result<Vec<CleanupJournalDirectoryEntry>> {
    validate_held_cleanup_journal_dir(directory)?;
    let object_id = directory_object_id(directory)?;
    let mut entries = Vec::new();
    let mut restart = true;
    loop {
        let mut storage = vec![0_u64; 8192];
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(
                storage.as_mut_ptr().cast::<u8>(),
                storage.len() * std::mem::size_of::<u64>(),
            )
        };
        let class = if restart {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        let success = unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle().cast(),
                class,
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
            )
        };
        if success == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(error).context("failed to enumerate the held cleanup journal directory");
        }
        restart = false;
        let mut offset = 0_usize;
        loop {
            const NEXT_OFFSET: usize = 0;
            const ATTRIBUTES_OFFSET: usize = 56;
            const NAME_LENGTH_OFFSET: usize = 60;
            const NAME_OFFSET: usize = 104;
            if offset + NAME_OFFSET > bytes.len() {
                bail!("cleanup journal directory enumeration returned a truncated entry");
            }
            let read_u32 = |relative: usize| -> u32 {
                u32::from_ne_bytes(
                    bytes[offset + relative..offset + relative + 4]
                        .try_into()
                        .expect("directory field is four bytes"),
                )
            };
            let next = read_u32(NEXT_OFFSET) as usize;
            let attributes = read_u32(ATTRIBUTES_OFFSET);
            let name_bytes = read_u32(NAME_LENGTH_OFFSET) as usize;
            if !name_bytes.is_multiple_of(2) || offset + NAME_OFFSET + name_bytes > bytes.len() {
                bail!("cleanup journal directory enumeration returned an invalid leaf name");
            }
            let name_units = unsafe {
                std::slice::from_raw_parts(
                    bytes.as_ptr().add(offset + NAME_OFFSET).cast::<u16>(),
                    name_bytes / 2,
                )
            };
            let name = OsString::from_wide(name_units);
            if name != OsStr::new(".") && name != OsStr::new("..") {
                entries.push(CleanupJournalDirectoryEntry { name, attributes });
            }
            if next == 0 {
                break;
            }
            if next < NAME_OFFSET + name_bytes || offset + next >= bytes.len() {
                bail!("cleanup journal directory enumeration returned an invalid offset");
            }
            offset += next;
        }
    }
    if directory_object_id(directory)? != object_id {
        bail!("cleanup journal directory identity changed while it was enumerated");
    }
    validate_held_cleanup_journal_dir(directory)?;
    Ok(entries)
}

fn validate_held_cleanup_journal_dir(handle: &File) -> Result<()> {
    if final_identity(handle)? != normalize_identity(&cleanup_journal_dir())? {
        bail!("cleanup journal directory path no longer names the held directory object");
    }
    Ok(())
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum TestExecuteRestoredErrorPoint {
    QuarantineDirectoryValidation,
    TargetIdentity,
    PostMoveValidation,
}

#[cfg(test)]
thread_local! {
    static TEST_CLEANUP_JOURNAL_ROOT: std::cell::RefCell<Option<TestCleanupJournalContext>> = const { std::cell::RefCell::new(None) };
    static TEST_CLEANUP_JOURNAL_FAULT: std::cell::RefCell<Option<(CleanupJournalPhase, bool)>> = const { std::cell::RefCell::new(None) };
    static TEST_REGISTERED_PROJECT_IDENTITIES: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
    static TEST_QUARANTINE_DIRECTORY_DELETE_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static TEST_CREATED_QUARANTINE_ROLLBACK_DELETE_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static TEST_EXECUTE_RESTORED_ERROR_POINT: std::cell::Cell<Option<TestExecuteRestoredErrorPoint>> = const { std::cell::Cell::new(None) };
    static TEST_PERMANENT_DELETE_BEFORE_TERMINAL_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static TEST_CLEANUP_INSPECTION_FAILURE_PATH: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) struct TestCleanupJournalRootGuard {
    _serial: std::sync::MutexGuard<'static, ()>,
    previous: Option<TestCleanupJournalContext>,
    previous_registered_project_identities: Option<Vec<String>>,
}

#[cfg(test)]
struct TestCleanupJournalContext {
    path: PathBuf,
    handle: File,
}

#[cfg(test)]
impl TestCleanupJournalRootGuard {
    pub(super) fn enter(path: PathBuf) -> Self {
        static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
        // Cleanup receipts and workspace capabilities intentionally use process-wide
        // registries. Keep tests that replace the journal root from mutating those
        // registries concurrently, otherwise one test can revoke another test's receipt.
        let serial = SERIAL
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let handle = open_cleanup_journal_dir_at(&path)
            .expect("test cleanup journal directory must be valid");
        let previous = TEST_CLEANUP_JOURNAL_ROOT
            .with(|root| root.replace(Some(TestCleanupJournalContext { path, handle })));
        let previous_registered_project_identities = TEST_REGISTERED_PROJECT_IDENTITIES
            .with(|identities| identities.replace(Some(Vec::new())));
        Self {
            _serial: serial,
            previous,
            previous_registered_project_identities,
        }
    }
}

#[cfg(test)]
impl Drop for TestCleanupJournalRootGuard {
    fn drop(&mut self) {
        TEST_CLEANUP_JOURNAL_ROOT.with(|root| {
            root.replace(self.previous.take());
        });
        TEST_REGISTERED_PROJECT_IDENTITIES.with(|identities| {
            identities.replace(self.previous_registered_project_identities.take());
        });
    }
}

#[cfg(test)]
struct TestCleanupJournalFaultGuard;

#[cfg(test)]
impl TestCleanupJournalFaultGuard {
    fn enter(phase: CleanupJournalPhase, after_replace: bool) -> Self {
        TEST_CLEANUP_JOURNAL_FAULT.with(|fault| {
            assert!(fault.replace(Some((phase, after_replace))).is_none());
        });
        Self
    }
}

#[cfg(test)]
impl Drop for TestCleanupJournalFaultGuard {
    fn drop(&mut self) {
        TEST_CLEANUP_JOURNAL_FAULT.with(|fault| {
            fault.replace(None);
        });
    }
}

#[cfg(test)]
struct TestQuarantineDirectoryDeleteFaultGuard;

#[cfg(test)]
impl TestQuarantineDirectoryDeleteFaultGuard {
    fn enter() -> Self {
        TEST_QUARANTINE_DIRECTORY_DELETE_FAILURE.with(|fault| {
            assert!(!fault.replace(true));
        });
        Self
    }
}

#[cfg(test)]
impl Drop for TestQuarantineDirectoryDeleteFaultGuard {
    fn drop(&mut self) {
        TEST_QUARANTINE_DIRECTORY_DELETE_FAILURE.with(|fault| fault.set(false));
    }
}

#[cfg(test)]
struct TestCreatedQuarantineRollbackDeleteFaultGuard;

#[cfg(test)]
impl TestCreatedQuarantineRollbackDeleteFaultGuard {
    fn enter() -> Self {
        TEST_CREATED_QUARANTINE_ROLLBACK_DELETE_FAILURE.with(|fault| {
            assert!(!fault.replace(true));
        });
        Self
    }
}

#[cfg(test)]
impl Drop for TestCreatedQuarantineRollbackDeleteFaultGuard {
    fn drop(&mut self) {
        TEST_CREATED_QUARANTINE_ROLLBACK_DELETE_FAILURE.with(|fault| fault.set(false));
    }
}

#[cfg(test)]
struct TestExecuteRestoredErrorGuard;

#[cfg(test)]
impl TestExecuteRestoredErrorGuard {
    fn enter(point: TestExecuteRestoredErrorPoint) -> Self {
        TEST_EXECUTE_RESTORED_ERROR_POINT.with(|current| {
            assert!(current.replace(Some(point)).is_none());
        });
        Self
    }
}

#[cfg(test)]
impl Drop for TestExecuteRestoredErrorGuard {
    fn drop(&mut self) {
        TEST_EXECUTE_RESTORED_ERROR_POINT.with(|current| current.set(None));
    }
}

#[cfg(test)]
fn test_execute_restored_error(point: TestExecuteRestoredErrorPoint) -> bool {
    TEST_EXECUTE_RESTORED_ERROR_POINT.with(|current| current.get() == Some(point))
}

#[cfg(test)]
struct TestPermanentDeleteBeforeTerminalHookGuard;

#[cfg(test)]
impl TestPermanentDeleteBeforeTerminalHookGuard {
    fn enter(hook: impl FnOnce() + 'static) -> Self {
        TEST_PERMANENT_DELETE_BEFORE_TERMINAL_HOOK.with(|current| {
            assert!(current.replace(Some(Box::new(hook))).is_none());
        });
        Self
    }
}

#[cfg(test)]
impl Drop for TestPermanentDeleteBeforeTerminalHookGuard {
    fn drop(&mut self) {
        TEST_PERMANENT_DELETE_BEFORE_TERMINAL_HOOK.with(|current| {
            current.replace(None);
        });
    }
}

#[cfg(test)]
fn run_permanent_delete_before_terminal_hook() {
    let hook =
        TEST_PERMANENT_DELETE_BEFORE_TERMINAL_HOOK.with(|current| current.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
struct TestCleanupInspectionFaultGuard;

#[cfg(test)]
impl TestCleanupInspectionFaultGuard {
    fn enter(path: PathBuf) -> Self {
        TEST_CLEANUP_INSPECTION_FAILURE_PATH.with(|current| {
            assert!(current.replace(Some(path)).is_none());
        });
        Self
    }
}

#[cfg(test)]
impl Drop for TestCleanupInspectionFaultGuard {
    fn drop(&mut self) {
        TEST_CLEANUP_INSPECTION_FAILURE_PATH.with(|current| {
            current.replace(None);
        });
    }
}

fn lock_cleanup_journal() -> Result<File> {
    let dir = open_cleanup_journal_dir()?;
    let path = cleanup_journal_dir().join(".reconcile.lock");
    let lock = open_relative_file_with_access(
        &dir,
        OsStr::new(".reconcile.lock"),
        FILE_OPEN_IF,
        winapi::um::winnt::GENERIC_READ | winapi::um::winnt::GENERIC_WRITE | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )?
    .ok_or_else(|| anyhow!("cleanup journal lock could not be opened"))?;
    if lock.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || final_identity(&lock)? != normalize_identity(&path)?
    {
        bail!("cleanup journal lock identity is invalid");
    }
    fs2::FileExt::lock_exclusive(&lock)?;
    Ok(lock)
}

fn lock_cleanup_record_owner(token: &str) -> Result<File> {
    Uuid::parse_str(token).context("cleanup owner token is invalid")?;
    let dir = open_cleanup_journal_dir()?;
    let path = cleanup_journal_dir().join(format!(".{token}.owner.lock"));
    let name = format!(".{token}.owner.lock");
    let lock = open_relative_file_with_access(
        &dir,
        OsStr::new(&name),
        FILE_OPEN_IF,
        winapi::um::winnt::GENERIC_READ | winapi::um::winnt::GENERIC_WRITE | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )?
    .ok_or_else(|| anyhow!("cleanup owner lock could not be opened"))?;
    if lock.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || final_identity(&lock)? != normalize_identity(&path)?
    {
        bail!("cleanup owner lock identity is invalid");
    }
    fs2::FileExt::lock_exclusive(&lock)?;
    Ok(lock)
}

fn try_lock_cleanup_record_owner(token: &str) -> Result<Option<File>> {
    Uuid::parse_str(token).context("cleanup owner token is invalid")?;
    let dir = open_cleanup_journal_dir()?;
    let path = cleanup_journal_dir().join(format!(".{token}.owner.lock"));
    let name = format!(".{token}.owner.lock");
    let lock = open_relative_file_with_access(
        &dir,
        OsStr::new(&name),
        FILE_OPEN_IF,
        winapi::um::winnt::GENERIC_READ | winapi::um::winnt::GENERIC_WRITE | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )?
    .ok_or_else(|| anyhow!("cleanup owner lock could not be opened"))?;
    if lock.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || final_identity(&lock)? != normalize_identity(&path)?
    {
        bail!("cleanup owner lock identity is invalid");
    }
    match fs2::FileExt::try_lock_exclusive(&lock) {
        Ok(()) => Ok(Some(lock)),
        Err(_) => Ok(None),
    }
}

fn cleanup_journal_signing_key_unlocked() -> Result<[u8; 32]> {
    let dir = open_cleanup_journal_dir()?;
    let path = cleanup_journal_dir().join(".integrity.key");
    match open_relative_file_with_access(
        &dir,
        OsStr::new(".integrity.key"),
        FILE_OPEN,
        winapi::um::winnt::GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ,
    )? {
        Some(mut file) => {
            let before = file.metadata()?;
            let object_id = directory_object_id(&file)?;
            if before.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || before.len() != 32
                || final_identity(&file)? != normalize_identity(&path)?
            {
                bail!("cleanup journal integrity key cannot be a reparse point");
            }
            let mut key = [0_u8; 32];
            file.read_exact(&mut key)?;
            if file.read(&mut [0_u8; 1])? != 0 {
                bail!("cleanup journal integrity key has an invalid length");
            }
            let after = file.metadata()?;
            if after.len() != before.len()
                || directory_object_id(&file)? != object_id
                || final_identity(&file)? != normalize_identity(&path)?
            {
                bail!("cleanup journal integrity key changed while it was read");
            }
            Ok(key)
        }
        None => {
            let mut key = [0_u8; 32];
            key[..16].copy_from_slice(Uuid::new_v4().as_bytes());
            key[16..].copy_from_slice(Uuid::new_v4().as_bytes());
            let mut file = open_relative_file_with_access(
                &dir,
                OsStr::new(".integrity.key"),
                FILE_CREATE,
                winapi::um::winnt::GENERIC_WRITE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ,
            )?
            .ok_or_else(|| anyhow!("cleanup journal integrity key already exists"))?;
            file.write_all(&key)?;
            file.sync_all()?;
            if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || final_identity(&file)? != normalize_identity(&path)?
            {
                bail!("cleanup journal integrity key identity is invalid");
            }
            Ok(key)
        }
    }
}

fn cleanup_journal_mac(
    key: &[u8; 32],
    phase: CleanupJournalPhase,
    record: &CleanupJournalRecord,
) -> Result<String> {
    // This detects corruption, not malicious changes by the same OS user. No-follow handles,
    // object identity, and strict path boundaries are the authorization boundary.
    let payload = serde_json::to_vec(&CleanupJournalSigningPayload { phase, record })?;
    Ok(blake3::keyed_hash(key, &payload).to_hex().to_string())
}

fn persist_cleanup_journal_phase(record: &CleanupJournalRecord, phase: &str) -> Result<()> {
    let _lock = lock_cleanup_journal()?;
    persist_cleanup_journal_phase_unlocked(record, phase)
}

fn persist_cleanup_journal_phase_unlocked(
    record: &CleanupJournalRecord,
    phase: &str,
) -> Result<()> {
    let phase = match phase {
        "planned" => CleanupJournalPhase::Planned,
        "quarantined" => CleanupJournalPhase::Quarantined,
        "restore-planned" => CleanupJournalPhase::RestorePlanned,
        "restored" => CleanupJournalPhase::Restored,
        "delete-planned" => CleanupJournalPhase::DeletePlanned,
        "deleted" => CleanupJournalPhase::Deleted,
        "orphan" => CleanupJournalPhase::Orphan,
        _ => bail!("invalid cleanup quarantine journal phase"),
    };
    let dir_path = cleanup_journal_dir();
    let dir = open_cleanup_journal_dir()?;
    let final_name = format!("{}.json", record.quarantine_token);
    let final_path = dir_path.join(&final_name);
    let key = cleanup_journal_signing_key_unlocked()?;
    if path_exists_without_follow(&final_path)? {
        let current = read_cleanup_journal_entry(&final_path)?;
        if current.mac != cleanup_journal_mac(&key, current.phase, &current.record)? {
            bail!("cleanup quarantine journal integrity check failed");
        }
        if current.record != *record {
            bail!("cleanup journal record is immutable after creation");
        }
        if !current.phase.can_transition_to(phase) {
            bail!(
                "cleanup journal phase transition is invalid or terminal: {:?} -> {:?}",
                current.phase,
                phase
            );
        }
    } else if phase != CleanupJournalPhase::Planned {
        bail!("cleanup journal must begin in the planned phase");
    }
    let temporary_name = format!(
        ".{}.{}.tmp",
        record.quarantine_token,
        Uuid::new_v4().simple()
    );
    let bytes = serde_json::to_vec(&CleanupJournalEntry {
        phase,
        record: record.clone(),
        mac: cleanup_journal_mac(&key, phase, record)?,
    })?;
    let mut temporary = open_relative_file_with_access(
        &dir,
        OsStr::new(&temporary_name),
        FILE_CREATE,
        winapi::um::winnt::GENERIC_WRITE
            | FILE_READ_ATTRIBUTES
            | SYNCHRONIZE
            | winapi::um::winnt::DELETE,
        FILE_SHARE_READ,
    )?
    .ok_or_else(|| anyhow!("cleanup journal temporary leaf already exists"))?;
    temporary.write_all(&bytes)?;
    temporary.sync_all()?;
    #[cfg(test)]
    if TEST_CLEANUP_JOURNAL_FAULT.with(|fault| {
        fault
            .borrow()
            .as_ref()
            .is_some_and(|(fault_phase, after_replace)| *fault_phase == phase && !after_replace)
    }) {
        let _ = delete_open_cleanup_target(&temporary);
        bail!("forced cleanup journal failure before atomic replace");
    }
    rename_open_target_relative_with_replace(&temporary, &dir, OsStr::new(&final_name), true)
        .context("failed to atomically replace cleanup quarantine journal")?;
    if final_identity(&temporary)? != normalize_identity(&final_path)? {
        bail!("cleanup journal replacement escaped its held directory");
    }
    #[cfg(test)]
    if TEST_CLEANUP_JOURNAL_FAULT.with(|fault| {
        fault
            .borrow()
            .as_ref()
            .is_some_and(|(fault_phase, after_replace)| *fault_phase == phase && *after_replace)
    }) {
        bail!("forced cleanup journal failure after atomic replace");
    }
    Ok(())
}

fn restore_quarantined_cleanup(receipt: &mut RootCleanupQuarantine) -> Result<()> {
    let record = CleanupJournalRecord {
        schema_version: 1,
        quarantine_token: receipt.quarantine_token.clone(),
        capability_binding: cleanup_capability_binding(&receipt.capability),
        owner_session_id: receipt.capability.session_id.clone(),
        owner_run_id: receipt.capability.run_id.clone(),
        owner_source_message_id: receipt.capability.source_message_id.clone(),
        original_path: receipt.original_path.clone(),
        original_parent_object_id: directory_object_id(&receipt.original_parent_handle)?,
        quarantine_path: receipt.quarantine_path.clone(),
        quarantine_dir: receipt.quarantine_dir.clone(),
        target_object_id: receipt.target_object_id,
        target_link_count: receipt.target_link_count,
        target_type: cleanup_journal_target_type(&receipt.summary),
        target_bytes: receipt.summary.bytes,
        target_modified_millis: receipt.summary.modified_millis,
        target_hash: receipt.summary.hash.clone(),
    };
    persist_cleanup_journal_phase(&record, "restore-planned")?;
    let target_handle = receipt
        .target_handle
        .as_ref()
        .ok_or_else(|| anyhow!("quarantined cleanup target handle is unavailable"))?;
    if let Err(error) = rename_open_target_relative(
        target_handle,
        &receipt.original_parent_handle,
        &receipt.original_name,
    ) {
        return Err(error).with_context(|| {
            format!(
                "recoverable cleanup orphan remains at {}",
                record.quarantine_path.display()
            )
        });
    }
    drop(receipt.target_handle.take());
    finalize_committed_restore(&record, receipt.quarantine_dir_handle.take(), || {
        persist_cleanup_journal_phase(&record, "restored")
    });
    Ok(())
}

fn finalize_committed_restore<F>(
    record: &CleanupJournalRecord,
    quarantine_dir_handle: Option<File>,
    persist_terminal: F,
) where
    F: FnOnce() -> Result<()>,
{
    if let Err(error) = persist_terminal() {
        tracing::warn!(
            quarantine_token = record.quarantine_token,
            %error,
            "cleanup restore committed but its terminal journal update needs reconciliation"
        );
    }
    if let Some(quarantine_dir_handle) = quarantine_dir_handle {
        if let Err(error) = delete_live_quarantine_directory(&quarantine_dir_handle) {
            tracing::warn!(
                quarantine_token = record.quarantine_token,
                %error,
                "cleanup restore committed; empty quarantine directory cleanup was deferred"
            );
        }
        drop(quarantine_dir_handle);
    }
}

fn finalize_execute_restored_error<F>(
    record: &CleanupJournalRecord,
    original_error: anyhow::Error,
    cleanup_quarantine_dir: F,
) -> anyhow::Error
where
    F: FnOnce() -> Result<()>,
{
    let terminal_error = persist_cleanup_journal_phase(record, "restored").err();
    if let Err(error) = cleanup_quarantine_dir() {
        tracing::warn!(
            quarantine_token = record.quarantine_token,
            %error,
            "cleanup target was restored; empty quarantine directory cleanup was deferred"
        );
    }
    if let Some(terminal_error) = terminal_error {
        original_error.context(format!(
            "cleanup target was restored, but its terminal recovery evidence still needs repair: {terminal_error}"
        ))
    } else {
        original_error
    }
}

fn delete_live_quarantine_directory(handle: &File) -> Result<()> {
    #[cfg(test)]
    if TEST_QUARANTINE_DIRECTORY_DELETE_FAILURE.with(std::cell::Cell::get) {
        bail!("forced live quarantine directory delete failure");
    }
    delete_open_cleanup_target(handle)
        .context("failed to remove committed cleanup quarantine directory by handle")
}

fn delete_created_quarantine_directory(handle: &File) -> Result<()> {
    #[cfg(test)]
    if TEST_CREATED_QUARANTINE_ROLLBACK_DELETE_FAILURE.with(std::cell::Cell::get) {
        bail!("forced created quarantine directory rollback delete failure");
    }
    delete_open_cleanup_target(handle)
        .context("failed to rollback created cleanup quarantine directory by handle")
}

fn open_cleanup_directory_for_delete(path: &Path) -> Result<File> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("cleanup directory has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("cleanup directory has no leaf name"))?;
    let parent_chain = open_absolute_directory_chain(parent)?;
    let parent_handle = parent_chain
        .last()
        .ok_or_else(|| anyhow!("cleanup directory parent has no held handle"))?;
    let handle = open_relative_directory_with_access(
        parent_handle,
        name,
        FILE_OPEN,
        true,
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE | winapi::um::winnt::DELETE,
        FILE_SHARE_READ,
    )?
    .ok_or_else(|| anyhow!("cleanup directory is missing"))?;
    if handle.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || final_identity(&handle)? != normalize_identity(path)?
    {
        bail!("cleanup directory is a reparse point or changed identity");
    }
    Ok(handle)
}

fn warn_unheld_cleanup_directory(record: &CleanupJournalRecord, terminal: CleanupJournalPhase) {
    match std::fs::symlink_metadata(&record.quarantine_dir) {
        Ok(_) => tracing::warn!(
            quarantine_token = record.quarantine_token,
            quarantine_dir = %record.quarantine_dir.display(),
            terminal_phase = ?terminal,
            "cleanup recovery left an unowned quarantine directory path for manual inspection"
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(
            quarantine_token = record.quarantine_token,
            quarantine_dir = %record.quarantine_dir.display(),
            terminal_phase = ?terminal,
            %error,
            "cleanup recovery could not inspect its unowned quarantine directory path"
        ),
    }
}

enum JournalOriginalTargetInspection {
    Missing,
    ReceiptTarget { _handle: File },
    Other { _handle: File },
}

impl JournalOriginalTargetInspection {
    fn is_present(&self) -> bool {
        !matches!(self, Self::Missing)
    }

    fn is_receipt_target(&self) -> bool {
        matches!(self, Self::ReceiptTarget { .. })
    }
}

fn inspect_journal_original_target(
    record: &CleanupJournalRecord,
) -> Result<JournalOriginalTargetInspection> {
    let Some(handle) = open_cleanup_object_for_inspection(&record.original_path)? else {
        return Ok(JournalOriginalTargetInspection::Missing);
    };
    if held_journal_target_matches(record, &record.original_path, &handle)? {
        Ok(JournalOriginalTargetInspection::ReceiptTarget { _handle: handle })
    } else {
        Ok(JournalOriginalTargetInspection::Other { _handle: handle })
    }
}

fn journal_target_matches_without_delete(
    record: &CleanupJournalRecord,
    path: &Path,
) -> Result<bool> {
    let Some(handle) = open_cleanup_object_for_inspection(path)? else {
        return Ok(false);
    };
    held_journal_target_matches(record, path, &handle)
}

fn path_exists_without_follow(path: &Path) -> Result<bool> {
    #[cfg(test)]
    if TEST_CLEANUP_INSPECTION_FAILURE_PATH
        .with(|failure_path| failure_path.borrow().as_deref() == Some(path))
    {
        bail!("forced cleanup object inspection failure");
    }
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to inspect cleanup recovery path without following links: {}",
                path.display()
            )
        }),
    }
}

fn open_matching_journal_target(
    record: &CleanupJournalRecord,
    path: &Path,
) -> Result<Option<File>> {
    let is_directory = record.target_type == CleanupJournalTargetType::EmptyDirectory;
    let handle = open_cleanup_target(path, is_directory)?;
    Ok(held_journal_target_matches(record, path, &handle)?.then_some(handle))
}

fn held_journal_target_matches(
    record: &CleanupJournalRecord,
    path: &Path,
    handle: &File,
) -> Result<bool> {
    let is_directory = record.target_type == CleanupJournalTargetType::EmptyDirectory;
    let metadata = handle.metadata()?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(false);
    }
    if metadata.is_dir() != is_directory {
        return Ok(false);
    }
    if directory_object_id(handle)? != record.target_object_id {
        return Ok(false);
    }
    if let Some(expected) = record.target_link_count {
        if expected != 1 || file_link_count(handle)? != expected {
            return Ok(false);
        }
    }
    let root = path.components().take(2).collect::<PathBuf>();
    let summary = cleanup_target_summary(&root, path, handle, is_directory)?;
    Ok(cleanup_journal_target_type(&summary) == record.target_type
        && summary.bytes == record.target_bytes
        && summary.modified_millis == record.target_modified_millis
        && summary.hash == record.target_hash)
}

fn read_cleanup_journal_entry(path: &Path) -> Result<CleanupJournalEntry> {
    if path.parent() != Some(cleanup_journal_dir().as_path()) {
        bail!("cleanup journal path is outside the held journal directory");
    }
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("cleanup journal path has no leaf name"))?;
    let dir = open_cleanup_journal_dir()?;
    let mut file = open_relative_file_with_access(
        &dir,
        name,
        FILE_OPEN,
        winapi::um::winnt::GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ,
    )?
    .ok_or_else(|| anyhow!("cleanup journal leaf is missing"))?;
    let before = file.metadata()?;
    if before.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || before.len() > MAX_CLEANUP_JOURNAL_BYTES
        || final_identity(&file)? != normalize_identity(path)?
    {
        bail!("cleanup quarantine journal file identity or size is invalid");
    }
    let object_id = directory_object_id(&file)?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_CLEANUP_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if bytes.len() as u64 != before.len()
        || after.len() != before.len()
        || directory_object_id(&file)? != object_id
        || final_identity(&file)? != normalize_identity(path)?
    {
        bail!("cleanup quarantine journal changed while it was read");
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn validate_cleanup_journal_record(name: &str, record: &CleanupJournalRecord) -> Result<()> {
    if record.schema_version != 1
        || name != format!("{}.json", record.quarantine_token)
        || Uuid::parse_str(&record.quarantine_token).is_err()
        || record.capability_binding.len() != 64
        || !record
            .capability_binding
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || record.owner_session_id.trim().is_empty()
        || record.owner_run_id.trim().is_empty()
        || record.owner_source_message_id.trim().is_empty()
    {
        bail!("cleanup quarantine journal identity is invalid");
    }
    let (original_drive, _) = local_drive_components(&record.original_path)?;
    let (quarantine_drive, _) = local_drive_components(&record.quarantine_path)?;
    if original_drive != quarantine_drive
        || record.quarantine_path.parent() != Some(record.quarantine_dir.as_path())
        || record.quarantine_path.file_name() != Some(OsStr::new("target"))
        || record.quarantine_dir.file_name()
            != Some(OsStr::new(&format!(
                ".codeagentpro-quarantine-{}",
                record.quarantine_token
            )))
        || record.quarantine_dir.parent() != record.original_path.parent()
    {
        bail!("cleanup quarantine journal path boundary is invalid");
    }
    match record.target_type {
        CleanupJournalTargetType::File => {
            let hash = record
                .target_hash
                .as_deref()
                .ok_or_else(|| anyhow!("cleanup journal file hash is missing"))?;
            if record.target_link_count != Some(1)
                || hash.len() != 64
                || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                bail!("cleanup quarantine journal file contract is invalid");
            }
        }
        CleanupJournalTargetType::EmptyDirectory => {
            if record.target_link_count.is_some()
                || record.target_hash.is_some()
                || record.target_bytes != 0
            {
                bail!("cleanup quarantine journal directory contract is invalid");
            }
        }
    }
    Ok(())
}

fn cleanup_record_matches_capability(
    record: &CleanupJournalRecord,
    capability: &RootCapabilityContext,
) -> bool {
    record.owner_session_id == capability.session_id
        && record.owner_run_id == capability.run_id
        && record.owner_source_message_id == capability.source_message_id
        && record.capability_binding == cleanup_capability_binding(capability)
}

pub(crate) fn reconcile_cleanup_quarantine_journal_once() -> Result<()> {
    static RECONCILED: OnceLock<Mutex<bool>> = OnceLock::new();
    reconcile_cleanup_quarantine_journal_with_state(
        RECONCILED.get_or_init(|| Mutex::new(false)),
        reconcile_cleanup_quarantine_journal,
    )
}

fn reconcile_cleanup_quarantine_journal_with_state<F>(
    state: &Mutex<bool>,
    reconcile: F,
) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    let mut reconciled = state
        .lock()
        .map_err(|_| anyhow!("cleanup reconcile state is unavailable"))?;
    if *reconciled {
        return Ok(());
    }
    reconcile()?;
    *reconciled = true;
    Ok(())
}

pub(crate) fn reconcile_cleanup_quarantine_journal() -> Result<()> {
    let dir = cleanup_journal_dir();
    if !path_exists_without_follow(&dir)? {
        return Ok(());
    }
    let _lock = lock_cleanup_journal()?;
    let held_dir = open_cleanup_journal_dir()?;
    validate_held_cleanup_journal_dir(&held_dir)?;
    let key = cleanup_journal_signing_key_unlocked()?;
    let mut entries = cleanup_journal_directory_entries(&held_dir)?;
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    let mut failures = Vec::new();
    for entry in entries {
        if entry.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            failures.push(format!(
                "{}: cleanup quarantine journal contains a non-file entry",
                entry.name.to_string_lossy()
            ));
            continue;
        }
        let name = entry.name.to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        let outcome = (|| {
            let journal = read_cleanup_journal_entry(&dir.join(&entry.name))?;
            if journal.mac != cleanup_journal_mac(&key, journal.phase, &journal.record)? {
                bail!("cleanup quarantine journal integrity check failed");
            }
            validate_cleanup_journal_record(&name, &journal.record)?;
            let Some(_owner_lock) =
                try_lock_cleanup_record_owner(&journal.record.quarantine_token)?
            else {
                return Ok(());
            };
            reconcile_cleanup_journal_record(journal)
        })();
        if let Err(error) = outcome {
            failures.push(format!("{name}: {error}"));
        }
    }
    validate_held_cleanup_journal_dir(&held_dir)?;
    if !failures.is_empty() {
        bail!(
            "cleanup recovery requires attention: {}",
            failures.join("; ")
        );
    }
    Ok(())
}

fn reconcile_cleanup_journal_record(journal: CleanupJournalEntry) -> Result<()> {
    let phase = journal.phase;
    let record = journal.record;
    if phase.is_terminal() {
        return Ok(());
    }
    if phase == CleanupJournalPhase::Orphan {
        bail!(
            "cleanup recovery requires explicit orphan recovery at {}",
            record.quarantine_path.display()
        );
    }
    let quarantine_exists = path_exists_without_follow(&record.quarantine_path)?;
    let original = inspect_journal_original_target(&record)?;
    let original_exists = original.is_present();
    if phase == CleanupJournalPhase::DeletePlanned && !quarantine_exists {
        let terminal = if original.is_receipt_target() {
            CleanupJournalPhase::Restored
        } else {
            CleanupJournalPhase::Deleted
        };
        persist_cleanup_journal_phase_unlocked(
            &record,
            match terminal {
                CleanupJournalPhase::Restored => "restored",
                CleanupJournalPhase::Deleted => "deleted",
                _ => unreachable!("delete-planned missing-target terminal is fixed"),
            },
        )?;
        warn_unheld_cleanup_directory(&record, terminal);
        return Ok(());
    }
    if original_exists && !quarantine_exists {
        if !original.is_receipt_target() {
            persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
            bail!("cleanup recovery found a different object at the original path");
        }
        persist_cleanup_journal_phase_unlocked(&record, "restored")?;
        warn_unheld_cleanup_directory(&record, CleanupJournalPhase::Restored);
        return Ok(());
    }
    if original_exists && quarantine_exists {
        persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
        bail!(
            "cleanup recovery cannot restore {} because the original path is occupied",
            record.quarantine_path.display()
        );
    }
    if quarantine_exists {
        if std::fs::symlink_metadata(&record.quarantine_dir)?.file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
            || std::fs::symlink_metadata(&record.quarantine_path)?.file_attributes()
                & FILE_ATTRIBUTE_REPARSE_POINT
                != 0
        {
            persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
            bail!("cleanup recovery refuses a reparse-point quarantine");
        }
        let Some(target_handle) = open_matching_journal_target(&record, &record.quarantine_path)?
        else {
            persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
            bail!("cleanup recovery quarantine object no longer matches its receipt");
        };
        persist_cleanup_journal_phase_unlocked(&record, "restore-planned")?;
        let original_parent = record
            .original_path
            .parent()
            .ok_or_else(|| anyhow!("cleanup recovery original path has no parent"))?;
        let original_parent_chain = open_absolute_directory_chain(original_parent)?;
        let original_parent_handle = original_parent_chain
            .last()
            .ok_or_else(|| anyhow!("cleanup recovery original parent has no handle"))?;
        if directory_object_id(original_parent_handle)? != record.original_parent_object_id {
            persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
            bail!("cleanup recovery original parent identity changed");
        }
        let original_name = record
            .original_path
            .file_name()
            .ok_or_else(|| anyhow!("cleanup recovery original path has no leaf name"))?;
        if let Err(error) =
            rename_open_target_relative(&target_handle, original_parent_handle, original_name)
        {
            persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
            bail!(
                "cleanup recovery left an orphan at {}: {error}",
                record.quarantine_path.display()
            );
        }
        drop(target_handle);
        persist_cleanup_journal_phase_unlocked(&record, "restored")?;
        warn_unheld_cleanup_directory(&record, CleanupJournalPhase::Restored);
        return Ok(());
    }
    persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
    bail!("cleanup recovery cannot locate either side of the quarantined target")
}

fn cleanup_retry_original_available(
    phase: CleanupJournalPhase,
    record: &CleanupJournalRecord,
) -> Result<bool> {
    if phase.is_terminal() {
        return Ok(false);
    }
    let original = inspect_journal_original_target(record)?;
    let original_exists = original.is_present();
    let quarantine_exists = path_exists_without_follow(&record.quarantine_path)?;
    match (original_exists, quarantine_exists) {
        (true, false) if phase.can_transition_to(CleanupJournalPhase::Restored) => {
            Ok(original.is_receipt_target())
        }
        (false, true) if phase.can_transition_to(CleanupJournalPhase::RestorePlanned) => {
            let quarantine_metadata = std::fs::symlink_metadata(&record.quarantine_path)?;
            let quarantine_dir_metadata = std::fs::symlink_metadata(&record.quarantine_dir)?;
            if quarantine_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || quarantine_dir_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || !journal_target_matches_without_delete(record, &record.quarantine_path)?
            {
                return Ok(false);
            }
            let original_parent = record
                .original_path
                .parent()
                .ok_or_else(|| anyhow!("cleanup recovery original path has no parent"))?;
            let original_parent_chain = open_absolute_directory_chain(original_parent)?;
            let Some(original_parent_handle) = original_parent_chain.last() else {
                return Ok(false);
            };
            Ok(directory_object_id(original_parent_handle)? == record.original_parent_object_id)
        }
        _ => Ok(false),
    }
}

pub(super) fn list_cleanup_recovery_diagnostics(
    request: ListCleanupRecoveryRequest,
) -> Result<CleanupRecoveryListResponse> {
    let dir = cleanup_journal_dir();
    if !path_exists_without_follow(&dir)? {
        return Ok(CleanupRecoveryListResponse {
            recoveries: Vec::new(),
        });
    }
    let _lock = lock_cleanup_journal()?;
    let held_dir = open_cleanup_journal_dir()?;
    validate_held_cleanup_journal_dir(&held_dir)?;
    let key = cleanup_journal_signing_key_unlocked()?;
    let mut recoveries = Vec::new();
    for entry in cleanup_journal_directory_entries(&held_dir)? {
        if entry.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            bail!("cleanup quarantine journal contains a non-file entry");
        }
        let name = entry.name.to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        let journal = read_cleanup_journal_entry(&dir.join(&entry.name))?;
        if journal.mac != cleanup_journal_mac(&key, journal.phase, &journal.record)? {
            bail!("cleanup quarantine journal integrity check failed");
        }
        validate_cleanup_journal_record(&name, &journal.record)?;
        if !cleanup_record_matches_capability(&journal.record, &request.capability) {
            continue;
        }
        if journal.phase.is_terminal() {
            continue;
        }
        let retry_original_available =
            cleanup_retry_original_available(journal.phase, &journal.record)?;
        recoveries.push(CleanupRecoveryDiagnostic {
            quarantine_token: journal.record.quarantine_token,
            phase: journal.phase,
            original_path: journal.record.original_path.to_string_lossy().into_owned(),
            quarantine_path: journal
                .record
                .quarantine_path
                .to_string_lossy()
                .into_owned(),
            retry_original_available,
        });
    }
    validate_held_cleanup_journal_dir(&held_dir)?;
    recoveries.sort_by(|left, right| left.quarantine_token.cmp(&right.quarantine_token));
    Ok(CleanupRecoveryListResponse { recoveries })
}

pub(super) fn retry_cleanup_recovery_original(
    request: RetryCleanupRecoveryRequest,
) -> Result<RetryCleanupRecoveryResponse> {
    Uuid::parse_str(&request.quarantine_token).context("cleanup recovery token is invalid")?;
    let _journal_lock = lock_cleanup_journal()?;
    let path = cleanup_journal_dir().join(format!("{}.json", request.quarantine_token));
    let journal = read_cleanup_journal_entry(&path)?;
    let key = cleanup_journal_signing_key_unlocked()?;
    if journal.mac != cleanup_journal_mac(&key, journal.phase, &journal.record)? {
        bail!("cleanup quarantine journal integrity check failed");
    }
    validate_cleanup_journal_record(
        &format!("{}.json", request.quarantine_token),
        &journal.record,
    )?;
    if !cleanup_record_matches_capability(&journal.record, &request.capability) {
        bail!("cleanup recovery authority does not match the original session and message");
    }
    if journal.phase.is_terminal() {
        bail!("cleanup recovery is already terminal and immutable");
    }
    let phase = journal.phase;
    let record = journal.record;
    let Some(_owner_lock) = try_lock_cleanup_record_owner(&record.quarantine_token)? else {
        bail!("cleanup recovery is still owned by a live session");
    };
    let quarantine_exists = path_exists_without_follow(&record.quarantine_path)?;
    let original = inspect_journal_original_target(&record)?;
    let original_exists = original.is_present();
    if phase == CleanupJournalPhase::DeletePlanned && !quarantine_exists {
        let restored = original.is_receipt_target();
        let terminal = if restored {
            CleanupJournalPhase::Restored
        } else {
            CleanupJournalPhase::Deleted
        };
        persist_cleanup_journal_phase_unlocked(
            &record,
            if restored { "restored" } else { "deleted" },
        )?;
        warn_unheld_cleanup_directory(&record, terminal);
        return Ok(RetryCleanupRecoveryResponse {
            restored,
            reveal_path: (!restored).then(|| record.quarantine_dir.to_string_lossy().into_owned()),
        });
    }
    if original_exists {
        if quarantine_exists {
            return Ok(RetryCleanupRecoveryResponse {
                restored: false,
                reveal_path: Some(record.quarantine_path.to_string_lossy().into_owned()),
            });
        }
        if original.is_receipt_target() {
            persist_cleanup_journal_phase_unlocked(&record, "restored")?;
            return Ok(RetryCleanupRecoveryResponse {
                restored: true,
                reveal_path: None,
            });
        }
        bail!("cleanup recovery found a different object at the original path");
    }
    if !quarantine_exists {
        persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
        return Ok(RetryCleanupRecoveryResponse {
            restored: false,
            reveal_path: Some(record.quarantine_dir.to_string_lossy().into_owned()),
        });
    }
    let Some(target_handle) = open_matching_journal_target(&record, &record.quarantine_path)?
    else {
        persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
        bail!("cleanup recovery quarantine object no longer matches its receipt");
    };
    persist_cleanup_journal_phase_unlocked(&record, "restore-planned")?;
    let original_parent = record
        .original_path
        .parent()
        .ok_or_else(|| anyhow!("cleanup recovery original path has no parent"))?;
    let original_parent_chain = open_absolute_directory_chain(original_parent)?;
    let original_parent_handle = original_parent_chain
        .last()
        .ok_or_else(|| anyhow!("cleanup recovery original parent has no handle"))?;
    if directory_object_id(original_parent_handle)? != record.original_parent_object_id {
        persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
        bail!("cleanup recovery original parent identity changed");
    }
    let original_name = record
        .original_path
        .file_name()
        .ok_or_else(|| anyhow!("cleanup recovery original path has no leaf name"))?;
    if let Err(_error) =
        rename_open_target_relative(&target_handle, original_parent_handle, original_name)
    {
        persist_cleanup_journal_phase_unlocked(&record, "orphan")?;
        return Ok(RetryCleanupRecoveryResponse {
            restored: false,
            reveal_path: Some(record.quarantine_path.to_string_lossy().into_owned()),
        });
    }
    drop(target_handle);
    persist_cleanup_journal_phase_unlocked(&record, "restored")?;
    warn_unheld_cleanup_directory(&record, CleanupJournalPhase::Restored);
    Ok(RetryCleanupRecoveryResponse {
        restored: true,
        reveal_path: None,
    })
}

fn ensure_session_cleanup_journal_terminal(session_id: &str) -> Result<()> {
    let _ = reconcile_cleanup_quarantine_journal();
    let dir = cleanup_journal_dir();
    if !path_exists_without_follow(&dir)? {
        return Ok(());
    }
    let _lock = lock_cleanup_journal()?;
    let held_dir = open_cleanup_journal_dir()?;
    validate_held_cleanup_journal_dir(&held_dir)?;
    let key = cleanup_journal_signing_key_unlocked()?;
    for entry in cleanup_journal_directory_entries(&held_dir)? {
        if entry.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            bail!("cleanup quarantine journal contains a non-file entry");
        }
        let name = entry.name.to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        let journal = read_cleanup_journal_entry(&dir.join(&entry.name))?;
        if journal.mac != cleanup_journal_mac(&key, journal.phase, &journal.record)? {
            bail!("cleanup quarantine journal integrity check failed");
        }
        validate_cleanup_journal_record(&name, &journal.record)?;
        if journal.record.owner_session_id == session_id && !journal.phase.is_terminal() {
            bail!(
                "session cleanup recovery must be restored before the session can be deleted or archived"
            );
        }
    }
    validate_held_cleanup_journal_dir(&held_dir)?;
    Ok(())
}

fn restore_root_capability(mut capability: RootCapability) -> Result<()> {
    capability.reserved = false;
    capability.generation = Uuid::new_v4();
    capability.expires_at = Instant::now() + PENDING_LEASE_LIFETIME;
    let nonce = capability.context.nonce.clone();
    let generation = capability.generation;
    let expires_at = capability.expires_at;
    let replaced = capability_registry()
        .lock()
        .map_err(|_| anyhow!("root capability registry is unavailable"))?
        .insert(nonce.clone(), capability);
    if replaced.is_some() {
        bail!("root capability could not be safely restored");
    }
    schedule_root_capability_expiry(nonce, generation, expires_at);
    Ok(())
}

pub(crate) fn revoke_session_workspace_authority(session_id: &str) -> Result<()> {
    // Revocation spans several registries and may restore quarantined bytes. Keep the
    // whole teardown serialized so two close paths cannot consume the same receipt
    // between the registry scan and removal.
    let _revoke_guard = workspace_authority_revoke_lock()
        .lock()
        .map_err(|_| anyhow!("workspace authority revoke lock is unavailable"))?;
    let quarantine_tokens = cleanup_quarantine_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup quarantine registry is unavailable"))?
        .iter()
        .filter(|(_, receipt)| receipt.capability.session_id == session_id)
        .map(|(token, _)| token.clone())
        .collect::<Vec<_>>();
    for token in quarantine_tokens {
        let mut receipt = {
            let mut registry = cleanup_quarantine_registry()
                .lock()
                .map_err(|_| anyhow!("cleanup quarantine registry is unavailable"))?;
            let receipt = registry
                .get_mut(&token)
                .ok_or_else(|| anyhow!("cleanup quarantine receipt disappeared during teardown"))?;
            receipt.authority = QuarantineAuthority::RestoreOnlyRevoked;
            registry
                .remove(&token)
                .ok_or_else(|| anyhow!("cleanup quarantine receipt disappeared during teardown"))?
        };
        if let Err(error) = restore_quarantined_cleanup(&mut receipt) {
            cleanup_quarantine_registry()
                .lock()
                .map_err(|_| anyhow!("cleanup quarantine registry is unavailable"))?
                .insert(token, receipt);
            return Err(error);
        }
    }

    ensure_session_cleanup_journal_terminal(session_id)?;

    capability_registry()
        .lock()
        .map_err(|_| anyhow!("root capability registry is unavailable"))?
        .retain(|_, capability| capability.context.session_id != session_id);
    allocated_workspace_receipt_registry()
        .lock()
        .map_err(|_| anyhow!("workspace allocation receipt registry is unavailable"))?
        .retain(|_, receipt| receipt.capability.session_id != session_id);
    cleanup_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup audit registry is unavailable"))?
        .retain(|_, audit| audit.capability.session_id != session_id);

    let pending_lease_ids = registry()
        .lock()
        .map_err(|_| anyhow!("workspace lease registry is unavailable"))?
        .pending
        .iter()
        .filter(|(_, lease)| lease.owner_session_id.as_deref() == Some(session_id))
        .map(|(lease_id, _)| lease_id.clone())
        .collect::<Vec<_>>();
    for lease_id in pending_lease_ids {
        release_workspace_lease(&lease_id)?;
    }
    Ok(())
}

pub(crate) fn inspect_root_disk_usage(root: &Path) -> Result<RootDiskUsage> {
    let (_, components) = local_drive_components(root)?;
    if !components.is_empty() {
        bail!("disk usage capability accepts only a filesystem root");
    }
    let root_handle = open_volume_root(local_drive_components(root)?.0)?;
    let canonical_root = final_path(&root_handle)?;
    Ok(RootDiskUsage {
        root_path: canonical_root.to_string_lossy().into_owned(),
        capacity_bytes: fs2::total_space(&canonical_root)?,
        available_bytes: fs2::available_space(&canonical_root)?,
    })
}

pub(crate) fn read_workspace_file_by_handle(
    workspace: &Path,
    requested_file: &Path,
) -> Result<(PathBuf, String)> {
    let workspace_chain = open_absolute_directory_chain(workspace)?;
    let workspace_handle = workspace_chain
        .last()
        .ok_or_else(|| anyhow!("authoritative workspace has no directory handle"))?;
    let canonical_workspace = final_path(workspace_handle)?;
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_OPEN_REPARSE_POINT)
        .open(requested_file)
        .context("failed to open file resource link without following the leaf")?;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!("file resource links cannot be reparse points");
    }
    if file_link_count(&file)? != 1 {
        bail!("file resource links cannot use multiply-linked files");
    }
    let canonical_file = final_path(&file)?;
    if canonical_file == canonical_workspace
        || !canonical_file.starts_with(&canonical_workspace)
        || !file.metadata()?.is_file()
    {
        bail!("file resource link is outside the authoritative workspace");
    }
    let before_metadata = file.metadata()?;
    if before_metadata.len() > MAX_RESOURCE_LINK_BYTES {
        bail!("file resource link exceeds the attachment size limit");
    }
    let before_object_id = directory_object_id(&file)?;
    let before_modified = before_metadata.modified()?;
    let mut bytes = Vec::with_capacity(before_metadata.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_RESOURCE_LINK_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_RESOURCE_LINK_BYTES {
        bail!("file resource link exceeds the attachment size limit");
    }
    let after_metadata = file.metadata()?;
    if directory_object_id(&file)? != before_object_id
        || after_metadata.len() != before_metadata.len()
        || after_metadata.modified()? != before_modified
        || after_metadata.len() != bytes.len() as u64
    {
        bail!("file resource link changed while it was being read");
    }
    let contents = String::from_utf8(bytes).context("file resource link is not valid UTF-8")?;
    Ok((canonical_file, contents))
}

pub(crate) fn validate_root_container_path(root: &Path) -> Result<String> {
    let (drive, components) = local_drive_components(root)?;
    if !components.is_empty() {
        bail!("root container must be a filesystem root");
    }
    let handle = open_volume_root(drive)?;
    let identity = final_identity(&handle)?;
    if normalize_identity(root)? != identity {
        bail!("root container identity changed");
    }
    Ok(identity)
}

pub(super) fn audit_root_cleanup(
    request: AuditRootCleanupRequest,
) -> Result<RootCleanupAuditResponse> {
    if request.targets.len() != 1 {
        bail!("cleanup audit requires exactly one user-selected target");
    }
    let root = Path::new(&request.root_path);
    let (root_drive, root_components) = local_drive_components(root)?;
    if !root_components.is_empty() {
        bail!("cleanup root must be a filesystem root");
    }
    let reservation =
        reserve_root_capability(&request.capability, root, RootCapabilityKind::CleanupAudit)?;
    let root_handle = open_volume_root(root_drive)?;
    let root_identity = final_identity(&root_handle)?;
    let canonical_root = final_path(&root_handle)?;
    let root_object_id = directory_object_id(&root_handle)?;
    let target_path = validate_cleanup_target(root, Path::new(&request.targets[0]))?;
    let ancestor_chain = open_cleanup_ancestor_chain(&root_handle, root, &target_path)?;
    let metadata = std::fs::symlink_metadata(&target_path)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!("cleanup targets cannot be reparse points");
    }
    reject_project_tree_cleanup(root, &target_path)?;
    ensure_cleanup_allowlisted(root, &target_path)?;
    if metadata.is_dir() && std::fs::read_dir(&target_path)?.next().is_some() {
        bail!("non-empty directories require a narrower exact cleanup target");
    }
    if !metadata.is_file() && !metadata.is_dir() {
        bail!("cleanup target must be a regular file or empty directory");
    }
    let target_parent_handle = ancestor_chain
        .last()
        .map(|ancestor| &ancestor.handle)
        .unwrap_or(&root_handle);
    let target_name = target_path
        .file_name()
        .ok_or_else(|| anyhow!("cleanup target has no leaf name"))?;
    let target_handle =
        open_cleanup_target_relative(target_parent_handle, target_name, metadata.is_dir())?;
    let target_link_count = if metadata.is_file() {
        let count = file_link_count(&target_handle)?;
        if count != 1 {
            bail!("cleanup refuses files with multiple hard links");
        }
        Some(count)
    } else {
        None
    };
    let canonical_target = final_path(&target_handle)?;
    if normalize_identity(&canonical_target)? != normalize_identity(&target_path)? {
        bail!("cleanup target identity changed during audit");
    }
    let summary =
        cleanup_target_summary(root, &canonical_target, &target_handle, metadata.is_dir())?;
    let target_object_id = directory_object_id(&target_handle)?;
    let reserved_capability = reservation.commit()?;
    let audit_token = Uuid::new_v4().to_string();
    let insert_result = cleanup_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup audit registry is unavailable"))
        .map(|mut registry| {
            registry.insert(
                audit_token.clone(),
                RootCleanupAudit {
                    root_identity: root_identity.clone(),
                    root_path: canonical_root,
                    root_object_id,
                    root_handle,
                    ancestor_chain,
                    target_path: canonical_target,
                    target_object_id,
                    target_handle,
                    target_link_count,
                    summary: summary.clone(),
                    capability: request.capability,
                    reserved_capability: reserved_capability.clone(),
                },
            )
        });
    if let Err(error) = insert_result {
        restore_root_capability(reserved_capability)?;
        return Err(error);
    }
    schedule_cleanup_audit_expiry(audit_token.clone());
    Ok(RootCleanupAuditResponse {
        audit_token,
        root_identity,
        target: summary,
        destructive_confirmation_required: true,
        execution_available: true,
    })
}

pub(super) fn execute_root_cleanup(
    request: ExecuteRootCleanupRequest,
) -> Result<RootCleanupQuarantineResponse> {
    execute_root_cleanup_with_hook(request, || Ok(()))
}

fn execute_root_cleanup_with_hook<F>(
    request: ExecuteRootCleanupRequest,
    hook: F,
) -> Result<RootCleanupQuarantineResponse>
where
    F: FnOnce() -> Result<()>,
{
    let mut registry = cleanup_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup audit registry is unavailable"))?;
    let audit = registry
        .get(&request.audit_token)
        .ok_or_else(|| anyhow!("cleanup audit token is missing, expired, or already consumed"))?;
    if audit.capability != request.capability {
        bail!("cleanup confirmation does not match the audited message capability");
    }
    let audit = registry
        .remove(&request.audit_token)
        .ok_or_else(|| anyhow!("cleanup audit token is missing, expired, or already consumed"))?;
    drop(registry);
    let reserved_capability_for_restore = audit.reserved_capability.clone();
    let quarantine_token = Uuid::new_v4().to_string();
    let owner_lock = lock_cleanup_record_owner(&quarantine_token)?;
    let capability_for_journal = audit.capability.clone();
    let receipt_capability = audit.capability.clone();
    let receipt_original_path = audit.target_path.clone();
    let receipt_target_object_id = audit.target_object_id;
    let receipt_target_link_count = audit.target_link_count;
    let receipt_summary = audit.summary.clone();
    let mut moved_record: Option<CleanupJournalRecord> = None;
    let quarantine_result = (|| {
        if normalize_identity(&audit.root_path)? != audit.root_identity
            || final_identity(&audit.root_handle)? != audit.root_identity
            || directory_object_id(&audit.root_handle)? != audit.root_object_id
        {
            bail!("cleanup root identity changed after audit");
        }
        let revalidated_target = validate_cleanup_target(&audit.root_path, &audit.target_path)?;
        if normalize_identity(&revalidated_target)? != normalize_identity(&audit.target_path)? {
            bail!("cleanup target boundary changed after audit");
        }
        reject_project_tree_cleanup(&audit.root_path, &audit.target_path)?;
        ensure_cleanup_allowlisted(&audit.root_path, &audit.target_path)?;
        revalidate_cleanup_ancestor_chain(&audit.ancestor_chain)?;
        revalidate_cleanup_link_count(&audit)?;
        hook()?;
        let revalidated_target = validate_cleanup_target(&audit.root_path, &audit.target_path)?;
        if normalize_identity(&revalidated_target)? != normalize_identity(&audit.target_path)? {
            bail!("cleanup target boundary changed during execution");
        }
        reject_project_tree_cleanup(&audit.root_path, &audit.target_path)?;
        ensure_cleanup_allowlisted(&audit.root_path, &audit.target_path)?;
        revalidate_cleanup_ancestor_chain(&audit.ancestor_chain)?;
        revalidate_cleanup_link_count(&audit)?;
        if final_identity(&audit.target_handle)? != normalize_identity(&audit.target_path)?
            || directory_object_id(&audit.target_handle)? != audit.target_object_id
        {
            bail!("cleanup target identity changed after audit");
        }
        let current = cleanup_target_summary(
            &audit.root_path,
            &audit.target_path,
            &audit.target_handle,
            audit.summary.target_type == "empty-directory",
        )?;
        if current.relative_path != audit.summary.relative_path
            || current.target_type != audit.summary.target_type
            || current.bytes != audit.summary.bytes
            || current.modified_millis != audit.summary.modified_millis
            || current.hash != audit.summary.hash
        {
            bail!("cleanup target changed after audit; confirmation is no longer valid");
        }
        if audit.summary.target_type == "empty-directory"
            && std::fs::read_dir(&audit.target_path)?.next().is_some()
        {
            bail!("cleanup directory is no longer empty");
        }
        let original_path = audit.target_path.clone();
        let parent = original_path
            .parent()
            .ok_or_else(|| anyhow!("cleanup target has no parent"))?
            .to_path_buf();
        let quarantine_name =
            OsString::from(format!(".codeagentpro-quarantine-{}", quarantine_token));
        let parent_handle = audit
            .ancestor_chain
            .last()
            .map(|ancestor| &ancestor.handle)
            .unwrap_or(&audit.root_handle);
        let original_parent_handle = parent_handle.try_clone()?;
        let original_name = original_path
            .file_name()
            .ok_or_else(|| anyhow!("cleanup target has no leaf name"))?
            .to_os_string();
        let quarantine_dir_handle =
            try_create_cleanup_rename_root_directory(parent_handle, &quarantine_name)?
                .ok_or_else(|| anyhow!("same-volume cleanup quarantine already exists"))?;
        let quarantine_dir = parent.join(&quarantine_name);
        let quarantine_dir_guard =
            CreatedQuarantineDirGuard::new(quarantine_dir.clone(), quarantine_dir_handle);
        let quarantine_path = quarantine_dir.join("target");
        let journal_record = CleanupJournalRecord {
            schema_version: 1,
            quarantine_token: quarantine_token.clone(),
            capability_binding: cleanup_capability_binding(&capability_for_journal),
            owner_session_id: capability_for_journal.session_id.clone(),
            owner_run_id: capability_for_journal.run_id.clone(),
            owner_source_message_id: capability_for_journal.source_message_id.clone(),
            original_path: original_path.clone(),
            original_parent_object_id: directory_object_id(&original_parent_handle)?,
            quarantine_path: quarantine_path.clone(),
            quarantine_dir: quarantine_dir.clone(),
            target_object_id: audit.target_object_id,
            target_link_count: audit.target_link_count,
            target_type: cleanup_journal_target_type(&audit.summary),
            target_bytes: audit.summary.bytes,
            target_modified_millis: audit.summary.modified_millis,
            target_hash: audit.summary.hash.clone(),
        };
        let pre_move = (|| {
            if normalize_identity(&final_path(quarantine_dir_guard.handle())?)?
                != normalize_identity(&quarantine_dir)?
                || std::fs::symlink_metadata(&quarantine_dir)?.file_attributes()
                    & FILE_ATTRIBUTE_REPARSE_POINT
                    != 0
            {
                bail!("cleanup quarantine directory identity is invalid");
            }
            persist_cleanup_journal_phase(&journal_record, "planned")?;
            rename_open_target_relative(
                &audit.target_handle,
                quarantine_dir_guard.handle(),
                OsStr::new("target"),
            )
            .context("failed to atomically quarantine exact cleanup target")
        })();
        if let Err(error) = pre_move {
            return match quarantine_dir_guard.rollback() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(anyhow!(
                    "cleanup quarantine failed before its move and rollback of the new empty quarantine also failed: {error}; {rollback_error}"
                )),
            };
        }
        moved_record = Some(journal_record.clone());
        #[cfg(test)]
        let quarantine_dir_delete_result = if test_execute_restored_error(
            TestExecuteRestoredErrorPoint::QuarantineDirectoryValidation,
        ) {
            Err(anyhow!(
                "forced cleanup quarantine directory validation failure"
            ))
        } else {
            quarantine_dir_guard.open_delete_handle()
        };
        #[cfg(not(test))]
        let quarantine_dir_delete_result = quarantine_dir_guard.open_delete_handle();
        let quarantine_dir_delete_handle = match quarantine_dir_delete_result {
            Ok(handle) => handle,
            Err(error) => {
                let original_error = error.context(
                    "cleanup quarantine directory could not be safely reopened after the move",
                );
                let restore = rename_open_target_relative(
                    &audit.target_handle,
                    &original_parent_handle,
                    &original_name,
                );
                if let Err(restore_error) = restore {
                    return Err(anyhow!(
                        "cleanup quarantine directory changed after the move and left a recoverable orphan at {}: {original_error}; restore failed: {restore_error}",
                        quarantine_path.display()
                    ));
                }
                moved_record = None;
                return Err(finalize_execute_restored_error(
                    &journal_record,
                    original_error,
                    || quarantine_dir_guard.rollback(),
                ));
            }
        };
        let quarantine_dir_handle = quarantine_dir_guard.commit(quarantine_dir_delete_handle);
        let quarantine_handle = audit.target_handle;
        let target_identity_changed =
            directory_object_id(&quarantine_handle).ok() != Some(audit.target_object_id);
        #[cfg(test)]
        let target_identity_changed = target_identity_changed
            || test_execute_restored_error(TestExecuteRestoredErrorPoint::TargetIdentity);
        if target_identity_changed {
            let original_error = anyhow!("cleanup target identity changed before quarantine move");
            let restore = rename_open_target_relative(
                &quarantine_handle,
                &original_parent_handle,
                &original_name,
            );
            drop(quarantine_handle);
            if let Err(restore_error) = restore {
                drop(quarantine_dir_handle);
                return Err(restore_error)
                    .context("cleanup moved a changed object and could not restore it");
            }
            moved_record = None;
            let error = finalize_execute_restored_error(&journal_record, original_error, || {
                delete_live_quarantine_directory(&quarantine_dir_handle)
            });
            drop(quarantine_dir_handle);
            return Err(error);
        }
        #[cfg(test)]
        let post_move_check =
            if test_execute_restored_error(TestExecuteRestoredErrorPoint::PostMoveValidation) {
                Err(anyhow!("forced post-move cleanup validation root cause"))
                    .context("forced post-move cleanup validation failure")
            } else {
                reject_project_tree_cleanup(&audit.root_path, &original_path)
                    .and_then(|()| revalidate_cleanup_ancestor_chain(&audit.ancestor_chain))
            };
        #[cfg(not(test))]
        let post_move_check = reject_project_tree_cleanup(&audit.root_path, &original_path)
            .and_then(|()| revalidate_cleanup_ancestor_chain(&audit.ancestor_chain));
        if let Err(error) = post_move_check {
            let restore = rename_open_target_relative(
                &quarantine_handle,
                &original_parent_handle,
                &original_name,
            );
            drop(quarantine_handle);
            if let Err(restore_error) = restore {
                drop(quarantine_dir_handle);
                let _ = persist_cleanup_journal_phase(&journal_record, "orphan");
                bail!(
                    "cleanup quarantine detected a project boundary change and left a recoverable orphan at {}: {error}; restore failed: {restore_error}",
                    quarantine_path.display()
                );
            }
            moved_record = None;
            let error = finalize_execute_restored_error(&journal_record, error, || {
                delete_live_quarantine_directory(&quarantine_dir_handle)
            });
            drop(quarantine_dir_handle);
            return Err(error);
        }
        if let Err(error) = persist_cleanup_journal_phase(&journal_record, "quarantined") {
            let restore = rename_open_target_relative(
                &quarantine_handle,
                &original_parent_handle,
                &original_name,
            );
            drop(quarantine_handle);
            if let Err(restore_error) = restore {
                drop(quarantine_dir_handle);
                let _ = persist_cleanup_journal_phase(&journal_record, "orphan");
                bail!(
                    "cleanup journal failed after quarantine and left a recoverable orphan at {}: {error}; restore failed: {restore_error}",
                    quarantine_path.display()
                );
            }
            moved_record = None;
            let error = finalize_execute_restored_error(&journal_record, error, || {
                delete_live_quarantine_directory(&quarantine_dir_handle)
            });
            drop(quarantine_dir_handle);
            return Err(error);
        }
        Ok((
            quarantine_path,
            quarantine_dir,
            quarantine_dir_handle,
            quarantine_handle,
            original_parent_handle,
            original_name,
        ))
    })();
    let (
        quarantine_path,
        quarantine_dir,
        quarantine_dir_handle,
        target_handle,
        original_parent_handle,
        original_name,
    ) = match quarantine_result {
        Ok(result) => result,
        Err(error) => {
            if let Some(record) = moved_record {
                persist_cleanup_journal_phase(&record, "orphan")?;
                return Err(anyhow!(
                    "cleanup quarantine failed after its move and left a recoverable orphan at {}: {error}",
                    record.quarantine_path.display()
                ));
            }
            restore_root_capability(reserved_capability_for_restore).map_err(|restore_error| {
            anyhow!(
                    "cleanup quarantine failed and its audit capability could not be restored: {error}; {restore_error}"
            )
        })?;
            return Err(error);
        }
    };
    let mut receipt = RootCleanupQuarantine {
        quarantine_token: quarantine_token.clone(),
        capability: receipt_capability,
        original_path: receipt_original_path,
        quarantine_path,
        quarantine_dir,
        quarantine_dir_handle: Some(quarantine_dir_handle),
        target_handle: Some(target_handle),
        original_parent_handle,
        original_name,
        target_object_id: receipt_target_object_id,
        target_link_count: receipt_target_link_count,
        summary: receipt_summary.clone(),
        authority: QuarantineAuthority::ActiveConfirmable,
        generation: Uuid::new_v4(),
        _owner_lock: owner_lock,
    };
    let receipt_generation = receipt.generation;
    match cleanup_quarantine_registry().lock() {
        Ok(mut registry) => {
            registry.insert(quarantine_token.clone(), receipt);
        }
        Err(_) => {
            let error = anyhow!("cleanup quarantine registry is unavailable");
            let restore = restore_quarantined_cleanup(&mut receipt);
            restore_root_capability(reserved_capability_for_restore)?;
            restore.map_err(|restore_error| {
                anyhow!(
                    "cleanup quarantine registry failed after move: {error}; restore failed: {restore_error}"
                )
            })?;
            return Err(error);
        }
    }
    schedule_cleanup_quarantine_expiry(quarantine_token.clone(), receipt_generation);
    Ok(RootCleanupQuarantineResponse {
        quarantine_token,
        target: receipt_summary,
        permanent_confirmation_required: true,
    })
}

fn schedule_cleanup_quarantine_expiry(quarantine_token: String, generation: Uuid) {
    tokio::spawn(async move {
        tokio::time::sleep(PENDING_LEASE_LIFETIME).await;
        let _ = expire_cleanup_quarantine_generation(&quarantine_token, generation);
    });
}

fn expire_cleanup_quarantine_generation(quarantine_token: &str, generation: Uuid) -> Result<()> {
    let receipt = cleanup_quarantine_registry()
        .lock()
        .ok()
        .and_then(|mut registry| {
            let receipt = registry.get_mut(quarantine_token)?;
            if receipt.generation != generation
                || receipt.authority != QuarantineAuthority::ActiveConfirmable
            {
                return None;
            }
            receipt.authority = QuarantineAuthority::RestoreOnlyExpired;
            registry.remove(quarantine_token)
        });
    if let Some(mut receipt) = receipt {
        if let Err(error) = restore_quarantined_cleanup(&mut receipt) {
            cleanup_quarantine_registry()
                .lock()
                .map_err(|_| anyhow!("cleanup quarantine registry is unavailable"))?
                .insert(quarantine_token.to_string(), receipt);
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn permanently_delete_quarantined_cleanup(
    request: PermanentlyDeleteQuarantineRequest,
) -> Result<()> {
    let mut registry = cleanup_quarantine_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup quarantine registry is unavailable"))?;
    let receipt = registry
        .get_mut(&request.quarantine_token)
        .ok_or_else(|| anyhow!("cleanup quarantine token is missing or already consumed"))?;
    if receipt.capability != request.capability {
        bail!("permanent cleanup confirmation does not match the quarantined message capability");
    }
    if receipt.authority != QuarantineAuthority::ActiveConfirmable {
        bail!("quarantined cleanup is restore-only and cannot be permanently deleted");
    }
    let target_handle = receipt
        .target_handle
        .as_ref()
        .ok_or_else(|| anyhow!("quarantined cleanup target handle must be reacquired"))?;
    if final_path(target_handle)? != receipt.quarantine_path
        || directory_object_id(target_handle)? != receipt.target_object_id
    {
        bail!("quarantined cleanup target identity changed");
    }
    if let Some(expected) = receipt.target_link_count {
        if expected != 1 || file_link_count(target_handle)? != expected {
            bail!("quarantined cleanup target hard-link count changed");
        }
    }
    let current = cleanup_target_summary(
        &receipt.quarantine_dir,
        &receipt.quarantine_path,
        target_handle,
        receipt.summary.target_type == "empty-directory",
    )?;
    if current.target_type != receipt.summary.target_type
        || current.bytes != receipt.summary.bytes
        || current.modified_millis != receipt.summary.modified_millis
        || current.hash != receipt.summary.hash
    {
        bail!("quarantined cleanup target changed before permanent confirmation");
    }
    let journal_record = CleanupJournalRecord {
        schema_version: 1,
        quarantine_token: receipt.quarantine_token.clone(),
        capability_binding: cleanup_capability_binding(&receipt.capability),
        owner_session_id: receipt.capability.session_id.clone(),
        owner_run_id: receipt.capability.run_id.clone(),
        owner_source_message_id: receipt.capability.source_message_id.clone(),
        original_path: receipt.original_path.clone(),
        original_parent_object_id: directory_object_id(&receipt.original_parent_handle)?,
        quarantine_path: receipt.quarantine_path.clone(),
        quarantine_dir: receipt.quarantine_dir.clone(),
        target_object_id: receipt.target_object_id,
        target_link_count: receipt.target_link_count,
        target_type: cleanup_journal_target_type(&receipt.summary),
        target_bytes: receipt.summary.bytes,
        target_modified_millis: receipt.summary.modified_millis,
        target_hash: receipt.summary.hash.clone(),
    };
    persist_cleanup_journal_phase(&journal_record, "delete-planned")?;
    delete_open_cleanup_target(target_handle)?;
    drop(receipt.target_handle.take());
    let quarantine_dir_handle = receipt.quarantine_dir_handle.take();
    let terminal_receipt = registry
        .remove(&request.quarantine_token)
        .ok_or_else(|| anyhow!("cleanup quarantine token was lost before terminal persistence"))?;
    drop(registry);
    #[cfg(test)]
    run_permanent_delete_before_terminal_hook();
    let terminal_result = persist_cleanup_journal_phase(&journal_record, "deleted");
    drop(terminal_receipt);
    if let Some(quarantine_dir_handle) = quarantine_dir_handle {
        if let Err(error) = delete_live_quarantine_directory(&quarantine_dir_handle) {
            tracing::warn!(
                quarantine_token = journal_record.quarantine_token,
                %error,
                "cleanup delete committed; empty quarantine directory cleanup was deferred"
            );
        }
        drop(quarantine_dir_handle);
    }
    terminal_result
        .context("cleanup delete committed but its terminal journal update needs reconciliation")?;
    Ok(())
}

pub(super) fn restore_quarantined_cleanup_by_request(
    request: PermanentlyDeleteQuarantineRequest,
) -> Result<()> {
    let mut registry = cleanup_quarantine_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup quarantine registry is unavailable"))?;
    let receipt = registry
        .get(&request.quarantine_token)
        .ok_or_else(|| anyhow!("cleanup quarantine token is missing or already consumed"))?;
    if receipt.capability != request.capability {
        bail!("cleanup restore does not match the quarantined message capability");
    }
    let receipt = registry
        .remove(&request.quarantine_token)
        .ok_or_else(|| anyhow!("cleanup quarantine token is missing or already consumed"))?;
    drop(registry);
    let mut receipt = receipt;
    match restore_quarantined_cleanup(&mut receipt) {
        Ok(()) => Ok(()),
        Err(error) => {
            cleanup_quarantine_registry()
                .lock()
                .map_err(|_| anyhow!("cleanup quarantine registry is unavailable"))?
                .insert(request.quarantine_token, receipt);
            Err(error)
        }
    }
}

fn open_cleanup_ancestor_chain(
    root_handle: &File,
    root: &Path,
    target: &Path,
) -> Result<Vec<CleanupAncestor>> {
    let (_, components) = local_drive_components(target)?;
    let mut path = root.to_path_buf();
    let mut ancestors = Vec::with_capacity(components.len().saturating_sub(1));
    for component in components.iter().take(components.len().saturating_sub(1)) {
        let parent = ancestors
            .last()
            .map(|ancestor: &CleanupAncestor| &ancestor.handle)
            .unwrap_or(root_handle);
        let handle = open_relative_directory(parent, component, FILE_OPEN, true)?;
        path.push(component);
        if final_identity(&handle)? != normalize_identity(&path)? {
            bail!("cleanup ancestor identity changed while acquiring handles");
        }
        ancestors.push(CleanupAncestor {
            path: path.clone(),
            object_id: directory_object_id(&handle)?,
            handle,
        });
    }
    Ok(ancestors)
}

fn revalidate_cleanup_ancestor_chain(ancestors: &[CleanupAncestor]) -> Result<()> {
    for ancestor in ancestors {
        if final_identity(&ancestor.handle)? != normalize_identity(&ancestor.path)?
            || directory_object_id(&ancestor.handle)? != ancestor.object_id
        {
            bail!("cleanup ancestor identity changed after audit");
        }
    }
    Ok(())
}

fn revalidate_cleanup_link_count(audit: &RootCleanupAudit) -> Result<()> {
    if let Some(expected) = audit.target_link_count {
        let current = file_link_count(&audit.target_handle)?;
        if expected != 1 || current != expected {
            bail!("cleanup target hard-link count changed after audit");
        }
    }
    Ok(())
}

pub(super) fn cancel_root_cleanup(request: ExecuteRootCleanupRequest) -> Result<()> {
    let mut registry = cleanup_registry()
        .lock()
        .map_err(|_| anyhow!("cleanup audit registry is unavailable"))?;
    let audit = registry
        .get(&request.audit_token)
        .ok_or_else(|| anyhow!("cleanup audit token is missing, expired, or already consumed"))?;
    if audit.capability != request.capability {
        bail!("cleanup cancellation does not match the audited message capability");
    }
    let audit = registry
        .remove(&request.audit_token)
        .ok_or_else(|| anyhow!("cleanup audit token is missing, expired, or already consumed"))?;
    drop(registry);
    restore_root_capability(audit.reserved_capability)
}

fn validate_cleanup_target(root: &Path, target: &Path) -> Result<PathBuf> {
    let (root_drive, root_components) = local_drive_components(root)?;
    let (target_drive, target_components) = local_drive_components(target)?;
    if !root_components.is_empty() || root_drive != target_drive || target_components.is_empty() {
        bail!("cleanup target must be below the confirmed root");
    }
    let mut current = root.to_path_buf();
    for component in target_components {
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            bail!("cleanup target ancestry cannot contain reparse points");
        }
    }
    Ok(current)
}

fn normalize_registered_project_path(path: &str) -> Result<String> {
    let path = Path::new(path);
    let (_, components) = local_drive_components(path)?;
    if components.is_empty() {
        bail!("registered project cannot be a filesystem root");
    }
    normalize_identity(path)
}

fn open_cleanup_target(path: &Path, is_directory: bool) -> Result<File> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("cleanup target has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("cleanup target has no leaf name"))?;
    let parent_chain = open_absolute_directory_chain(parent)?;
    let parent_handle = parent_chain
        .last()
        .ok_or_else(|| anyhow!("cleanup target parent has no handle"))?;
    open_cleanup_target_relative(parent_handle, name, is_directory)
}

fn open_cleanup_object_for_inspection(path: &Path) -> Result<Option<File>> {
    #[cfg(test)]
    if TEST_CLEANUP_INSPECTION_FAILURE_PATH
        .with(|failure_path| failure_path.borrow().as_deref() == Some(path))
    {
        bail!("forced cleanup object inspection failure");
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("cleanup inspection target has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("cleanup inspection target has no leaf name"))?;
    let parent_chain = open_absolute_directory_chain(parent)?;
    let parent_handle = parent_chain
        .last()
        .ok_or_else(|| anyhow!("cleanup inspection target parent has no handle"))?;
    let handle = open_relative_cleanup_object_for_inspection(parent_handle, name)?;
    if let Some(handle) = handle.as_ref() {
        if final_identity(handle)? != normalize_identity(path)? {
            bail!("cleanup inspection target identity escaped its held parent");
        }
    }
    Ok(handle)
}

fn open_cleanup_target_relative(parent: &File, name: &OsStr, is_directory: bool) -> Result<File> {
    let access = if is_directory {
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE | winapi::um::winnt::DELETE
    } else {
        winapi::um::winnt::GENERIC_READ
            | FILE_READ_ATTRIBUTES
            | SYNCHRONIZE
            | winapi::um::winnt::DELETE
    };
    let handle = if is_directory {
        open_relative_directory_with_access(parent, name, FILE_OPEN, true, access, FILE_SHARE_READ)?
    } else {
        open_relative_file_with_access(parent, name, FILE_OPEN, access, FILE_SHARE_READ)?
    };
    handle.ok_or_else(|| anyhow!("cleanup target is missing"))
}

fn cleanup_target_summary(
    root: &Path,
    target: &Path,
    handle: &File,
    is_directory: bool,
) -> Result<RootCleanupTargetSummary> {
    let metadata = handle.metadata()?;
    let modified_millis = metadata
        .modified()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| anyhow!("cleanup target modification time predates the Unix epoch"))?
        .as_millis();
    let hash = if is_directory {
        None
    } else {
        let mut reader = handle.try_clone()?;
        reader.rewind()?;
        let mut hasher = blake3::Hasher::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Some(hasher.finalize().to_hex().to_string())
    };
    let relative_path = target.strip_prefix(root)?.to_string_lossy().into_owned();
    Ok(RootCleanupTargetSummary {
        relative_path,
        target_type: if is_directory {
            "empty-directory"
        } else {
            "file"
        },
        bytes: if is_directory { 0 } else { metadata.len() },
        modified_millis,
        hash,
    })
}

fn delete_open_cleanup_target(handle: &File) -> Result<()> {
    let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    let result = unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle().cast(),
            FileDispositionInfo,
            (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to delete exact cleanup target");
    }
    Ok(())
}

fn rename_open_target_relative(target: &File, parent: &File, name: &OsStr) -> Result<()> {
    rename_open_target_relative_with_replace(target, parent, name, false)
}

#[cfg(test)]
fn file_rename_information_layout(
    pointer_size: usize,
    pointer_alignment: usize,
) -> Option<(usize, usize, usize)> {
    crate::secure_fs::windows::file_rename_information_layout(pointer_size, pointer_alignment)
}
fn rename_open_target_relative_with_replace(
    target: &File,
    parent: &File,
    name: &OsStr,
    replace: bool,
) -> Result<()> {
    crate::secure_fs::windows::rename_open_target_relative_with_replace(
        target, parent, name, replace,
    )
}
fn schedule_cleanup_audit_expiry(audit_token: String) {
    tokio::spawn(async move {
        tokio::time::sleep(PENDING_LEASE_LIFETIME).await;
        let expired = cleanup_registry()
            .lock()
            .ok()
            .and_then(|mut registry| registry.remove(&audit_token));
        if let Some(audit) = expired {
            let _ = restore_root_capability(audit.reserved_capability);
        }
    });
}

fn rollback_empty_created_workspace(lease: &WorkspaceLease) -> Result<()> {
    let leaf = lease
        ._ancestor_chain
        .last()
        .ok_or_else(|| anyhow!("created workspace lease has no leaf handle"))?;
    if final_identity(leaf)? != lease.normalized_identity {
        bail!("created workspace identity changed before rollback");
    }
    if std::fs::read_dir(&lease.working_dir)?.next().is_some() {
        bail!("created workspace is not empty; rollback refused");
    }
    let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    let result = unsafe {
        SetFileInformationByHandle(
            leaf.as_raw_handle().cast(),
            FileDispositionInfo,
            (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to rollback empty created workspace");
    }
    Ok(())
}

fn validate_workspace_lease(lease: &WorkspaceLease, cwd: &Path) -> Result<()> {
    if normalize_identity(cwd)? != lease.normalized_identity {
        bail!("workspace lease cwd does not match its authoritative workspace");
    }
    let handle_identity = final_identity(
        lease
            ._ancestor_chain
            .last()
            .ok_or_else(|| anyhow!("workspace lease has no final handle"))?,
    )?;
    if handle_identity != lease.normalized_identity {
        bail!("workspace lease handle identity changed");
    }
    Ok(())
}

fn acquire_handles<F, G>(
    request: &AcquireWorkspaceLeaseRequest,
    before_canonical_reopen: F,
    before_leaf_create: G,
) -> Result<WorkspaceLease>
where
    F: FnOnce() -> Result<()>,
    G: FnOnce() -> Result<()>,
{
    let requested = Path::new(&request.requested_path);
    let (drive, components) = local_drive_components(requested)?;
    if components.is_empty() {
        bail!("filesystem roots cannot be leased");
    }

    let mut handles = vec![open_volume_root(drive)?];

    let existing_count = match request.expected_state {
        WorkspaceState::Missing => components.len() - 1,
        WorkspaceState::EmptyDirectory | WorkspaceState::NonEmptyDirectory => components.len(),
    };
    for component in components.iter().take(existing_count) {
        let parent = handles.last().expect("root handle exists");
        handles.push(open_relative_directory(parent, component, FILE_OPEN, true)?);
    }

    let expected = normalize_identity(Path::new(&request.expected_identity))?;
    let working_dir = if request.expected_state == WorkspaceState::Missing {
        let parent_path = final_path(handles.last().expect("root handle exists"))?;
        let leaf = components.last().expect("non-root path has a leaf");
        let planned = parent_path.join(leaf);
        if normalize_identity(&planned)? != expected {
            bail!("workspace identity changed since inspection");
        }
        before_canonical_reopen()?;
        let mut canonical_chain = open_absolute_directory_chain(&parent_path)?;
        let canonical_parent = canonical_chain
            .last()
            .ok_or_else(|| anyhow!("canonical workspace parent has no handle"))?;
        ensure_same_directory_object(
            handles
                .last()
                .expect("original workspace parent handle exists"),
            canonical_parent,
        )?;
        before_leaf_create().map_err(path_free_workspace_permission_error)?;
        let leaf_handle = try_create_child_directory(canonical_parent, leaf)
            .map_err(path_free_workspace_permission_error)?
            .ok_or_else(|| anyhow!("workspace component already exists"))?;
        let working_dir = final_path(&leaf_handle)?;
        handles.append(&mut canonical_chain);
        handles.push(leaf_handle);
        working_dir
    } else {
        let requested_final =
            final_path(handles.last().expect("existing workspace handle exists"))?;
        before_canonical_reopen()?;
        let mut canonical_chain = open_absolute_directory_chain(&requested_final)?;
        ensure_same_directory_object(
            handles.last().expect("original workspace handle exists"),
            canonical_chain
                .last()
                .ok_or_else(|| anyhow!("canonical workspace has no final handle"))?,
        )?;
        let working_dir = final_path(
            canonical_chain
                .last()
                .ok_or_else(|| anyhow!("canonical workspace has no final handle"))?,
        )?;
        handles.append(&mut canonical_chain);
        working_dir
    };

    let normalized_identity = normalize_identity(&working_dir)?;
    if normalized_identity != expected {
        bail!("workspace identity changed since inspection");
    }
    Ok(WorkspaceLease {
        lease_id: String::new(),
        _ancestor_chain: handles,
        working_dir,
        normalized_identity,
        created: request.expected_state == WorkspaceState::Missing,
        owner_session_id: None,
    })
}

fn open_absolute_directory_chain(path: &Path) -> Result<Vec<File>> {
    let (drive, components) = local_drive_components(path)?;
    let mut handles = vec![open_volume_root(drive)?];
    let mut expected = PathBuf::from(format!("{}:\\", drive as char));
    for component in &components {
        let parent = handles.last().expect("root handle exists");
        let handle = open_relative_directory(parent, component, FILE_OPEN, true)?;
        expected.push(component);
        if handle.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || final_identity(&handle)? != normalize_identity(&expected)?
        {
            bail!("directory chain contains a reparse point or changed identity");
        }
        handles.push(handle);
    }
    Ok(handles)
}

fn open_volume_root(drive: u8) -> Result<File> {
    let root_path = format!("{}:\\", drive as char);
    OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(&root_path)
        .with_context(|| format!("failed to open workspace volume root {root_path}"))
}

fn local_drive_components(path: &Path) -> Result<(u8, Vec<OsString>)> {
    let mut iter = path.components();
    let drive = match iter.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) => drive,
            _ => bail!("only local drive-letter workspaces are supported"),
        },
        _ => bail!("workspace path must be an absolute local drive path"),
    };
    if !matches!(iter.next(), Some(Component::RootDir)) {
        bail!("workspace path must be absolute");
    }
    let mut components = Vec::new();
    for component in iter {
        match component {
            Component::Normal(name) => components.push(name.to_os_string()),
            _ => bail!("workspace path contains unsupported components"),
        }
    }
    Ok((drive.to_ascii_uppercase(), components))
}

fn open_relative_directory(
    parent: &File,
    name: &OsStr,
    disposition: u32,
    no_follow: bool,
) -> Result<File> {
    crate::secure_fs::windows::open_relative_directory(parent, name, disposition, no_follow)
}

pub(super) fn try_create_child_directory(parent: &File, name: &OsStr) -> Result<Option<File>> {
    crate::secure_fs::windows::try_create_child_directory(parent, name)
}

fn try_create_cleanup_rename_root_directory(parent: &File, name: &OsStr) -> Result<Option<File>> {
    open_relative_directory_with_access(
        parent,
        name,
        FILE_CREATE,
        true,
        FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )
}

fn open_relative_directory_with_access(
    parent: &File,
    name: &OsStr,
    disposition: u32,
    no_follow: bool,
    desired_access: u32,
    share_access: u32,
) -> Result<Option<File>> {
    crate::secure_fs::windows::open_relative_directory_with_access(
        parent,
        name,
        disposition,
        no_follow,
        desired_access,
        share_access,
    )
}

fn open_relative_file_with_access(
    parent: &File,
    name: &OsStr,
    disposition: u32,
    desired_access: u32,
    share_access: u32,
) -> Result<Option<File>> {
    crate::secure_fs::windows::open_relative_file_with_access(
        parent,
        name,
        disposition,
        desired_access,
        share_access,
    )
}

fn open_relative_cleanup_object_for_inspection(
    parent: &File,
    name: &OsStr,
) -> Result<Option<File>> {
    crate::secure_fs::windows::open_relative_cleanup_object_for_inspection(parent, name)
}

fn final_path(file: &File) -> Result<PathBuf> {
    let handle = file.as_raw_handle().cast();
    let required = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            ptr::null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if required == 0 {
        return Err(std::io::Error::last_os_error()).context("failed to size final workspace path");
    }
    let mut buffer = vec![0u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(std::io::Error::last_os_error())
            .context("failed to resolve final workspace path");
    }
    let raw = OsString::from_wide(&buffer[..written as usize]);
    let text = raw.to_string_lossy();
    let dos_path = text
        .strip_prefix(r"\\?\")
        .ok_or_else(|| anyhow!("workspace did not resolve to a local DOS path"))?;
    if dos_path.starts_with("UNC\\") {
        bail!("UNC workspaces are not supported by the Windows lease MVP");
    }
    Ok(PathBuf::from(dos_path))
}

fn final_identity(file: &File) -> Result<String> {
    normalize_identity(&final_path(file)?)
}

fn directory_object_id(file: &File) -> Result<DirectoryObjectId> {
    directory_object_id_from_queries(file_id_info_directory_object_id(file), || {
        legacy_directory_object_id(file)
    })
    .context("无法确认项目目录的稳定身份。请确认该目录位于支持稳定文件 ID 的本地磁盘，然后重试")
}

fn file_link_count(file: &File) -> Result<u32> {
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let success = unsafe {
        GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if success == 0 {
        return Err(io::Error::last_os_error()).context("failed to query cleanup hard-link count");
    }
    Ok(unsafe { information.assume_init() }.nNumberOfLinks)
}

fn file_id_info_directory_object_id(file: &File) -> io::Result<DirectoryObjectId> {
    let mut information = MaybeUninit::<FILE_ID_INFO>::zeroed();
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle().cast(),
            FileIdInfo,
            information.as_mut_ptr().cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    Ok(DirectoryObjectId::FileIdInfo {
        volume_serial_number: information.VolumeSerialNumber,
        file_id: information.FileId.Identifier,
    })
}

fn legacy_directory_object_id(file: &File) -> io::Result<DirectoryObjectId> {
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let success = unsafe {
        GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    let file_index = ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64;
    Ok(DirectoryObjectId::LegacyFileIndex {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index,
    })
}

fn directory_object_id_from_queries<F>(
    file_id_info: io::Result<DirectoryObjectId>,
    legacy_file_index: F,
) -> io::Result<DirectoryObjectId>
where
    F: FnOnce() -> io::Result<DirectoryObjectId>,
{
    match file_id_info {
        Ok(identity) => Ok(identity),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(code)
                    if code == ERROR_INVALID_PARAMETER as i32 || code == ERROR_NOT_SUPPORTED as i32
            ) =>
        {
            legacy_file_index()
        }
        Err(error) => Err(error),
    }
}

fn ensure_same_directory_object(original: &File, reopened: &File) -> Result<()> {
    if directory_object_id(original)? != directory_object_id(reopened)? {
        bail!("canonical workspace path reopened as a different directory object");
    }
    Ok(())
}

fn normalize_identity(path: &Path) -> Result<String> {
    let text = path
        .to_str()
        .ok_or_else(|| anyhow!("workspace path is not valid Unicode"))?
        .replace('/', "\\");
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    if text.starts_with("UNC\\") || text.starts_with(r"\\") {
        bail!("UNC workspaces are not supported by the Windows lease MVP");
    }
    Ok(text.trim_end_matches('\\').to_lowercase())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::string_slice)]

    use super::*;

    #[test]
    fn file_rename_information_layout_matches_32_and_64_bit_windows_abi() {
        assert_eq!(file_rename_information_layout(4, 4), Some((4, 8, 12)));
        assert_eq!(file_rename_information_layout(8, 8), Some((8, 16, 20)));
        assert_eq!(file_rename_information_layout(16, 16), None);
    }

    #[test]
    fn cleanup_journal_object_identity_rejects_unknown_and_malformed_fields() {
        let identity = DirectoryObjectId::FileIdInfo {
            volume_serial_number: 7,
            file_id: [3; 16],
        };
        let mut value = serde_json::to_value(identity).unwrap();
        value["FileIdInfo"]["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<DirectoryObjectId>(value).is_err());
        assert!(
            serde_json::from_value::<DirectoryObjectId>(serde_json::json!({
                "FileIdInfo": {"volume_serial_number": 7, "file_id": [1, 2]}
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<DirectoryObjectId>(serde_json::json!({
                "Unknown": {}
            }))
            .is_err()
        );
    }
    use std::fs;
    use std::process::Command;

    fn create_junction(link: &Path, target: &Path) -> Result<()> {
        let output = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .context("failed to launch mklink")?;
        if !output.status.success() {
            bail!(
                "mklink failed: stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim(),
            );
        }
        Ok(())
    }

    fn request(path: &Path, state: WorkspaceState) -> AcquireWorkspaceLeaseRequest {
        AcquireWorkspaceLeaseRequest {
            requested_path: path.to_string_lossy().into_owned(),
            expected_state: state,
            expected_identity: normalize_identity(path).unwrap(),
        }
    }

    #[test]
    fn project_child_names_are_single_safe_semantic_components() {
        assert!(validate_project_child_name("invoice-parser").is_ok());
        assert!(validate_project_child_name("库存管理系统").is_ok());
        assert!(validate_project_child_name("发票解析器").is_ok());
        assert!(validate_project_child_name(&"项".repeat(48)).is_ok());
        assert!(validate_project_child_name(&"项".repeat(49)).is_err());
        assert!(validate_project_child_name("café").is_ok());
        assert!(validate_project_child_name("cafe\u{301}").is_err());
        for invalid in [
            "",
            "../escape",
            "nested\\child",
            "库存/管理",
            "name_underscore",
            "CON",
        ] {
            assert!(
                validate_project_child_name(invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    #[test]
    fn resource_link_handle_read_enforces_utf8_and_size_limit() {
        let workspace = tempfile::tempdir().unwrap();
        let valid = workspace.path().join("valid.txt");
        fs::write(&valid, "库存管理系统").unwrap();
        let (_, contents) = read_workspace_file_by_handle(workspace.path(), &valid).unwrap();
        assert_eq!(contents, "库存管理系统");

        let invalid = workspace.path().join("invalid.txt");
        fs::write(&invalid, [0xff, 0xfe]).unwrap();
        assert!(read_workspace_file_by_handle(workspace.path(), &invalid).is_err());

        let oversized = workspace.path().join("oversized.txt");
        let file = File::create(&oversized).unwrap();
        file.set_len(MAX_RESOURCE_LINK_BYTES + 1).unwrap();
        assert!(read_workspace_file_by_handle(workspace.path(), &oversized).is_err());
    }

    #[test]
    fn project_markers_on_the_confirmed_root_are_detected() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();

        assert!(directory_has_project_marker(root.path()).unwrap());
    }

    #[test]
    fn registered_project_metadata_requires_working_dirs_and_authoritative_identity() {
        let missing = HashMap::new();
        assert!(registered_project_identities(&missing).is_err());

        let malformed = HashMap::from([
            ("workingDirs".to_string(), serde_json::json!("D:\\project")),
            (
                "codeproWorkspaceIdentity".to_string(),
                serde_json::json!("D:\\project"),
            ),
        ]);
        assert!(registered_project_identities(&malformed).is_err());

        let mismatched = HashMap::from([
            (
                "workingDirs".to_string(),
                serde_json::json!(["D:\\project"]),
            ),
            (
                "codeproWorkspaceIdentity".to_string(),
                serde_json::json!("D:\\other"),
            ),
        ]);
        assert!(registered_project_identities(&mismatched).is_err());

        for relative in ["project", "D:", r"\\server\share\project"] {
            let relative_metadata = HashMap::from([
                ("workingDirs".to_string(), serde_json::json!([relative])),
                (
                    "codeproWorkspaceIdentity".to_string(),
                    serde_json::json!(relative),
                ),
            ]);
            assert!(registered_project_identities(&relative_metadata).is_err());
        }

        let valid = HashMap::from([
            (
                "workingDirs".to_string(),
                serde_json::json!(["D:\\project"]),
            ),
            (
                "codeproWorkspaceIdentity".to_string(),
                serde_json::json!("d:\\project"),
            ),
        ]);
        assert_eq!(
            registered_project_identities(&valid).unwrap(),
            vec!["d:\\project"]
        );
    }

    #[test]
    fn restricted_disk_usage_accepts_only_a_root_and_does_not_allocate_a_lease() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .components()
            .take(2)
            .collect::<PathBuf>();
        let before_pending = registry().lock().unwrap().pending.len();
        let usage = inspect_root_disk_usage(&root).unwrap();
        assert!(usage.capacity_bytes >= usage.available_bytes);
        assert_eq!(registry().lock().unwrap().pending.len(), before_pending);
        assert!(inspect_root_disk_usage(Path::new(env!("CARGO_MANIFEST_DIR"))).is_err());
    }

    fn drive_root(path: &Path) -> PathBuf {
        path.components().take(2).collect()
    }

    fn cleanup_audit_tempdir() -> tempfile::TempDir {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        tempfile::Builder::new()
            .prefix("codebuddy-cleanup-audit-")
            .tempdir_in(root)
            .unwrap()
    }

    fn cleanup_capability(root: &Path) -> RootCapabilityContext {
        issue_root_capability(
            "cleanup-session",
            "cleanup-run",
            "cleanup-message",
            Some(root),
            RootCapabilityKind::CleanupAudit,
        )
        .unwrap()
    }

    fn open_readonly_cleanup_test_file(path: &Path) -> File {
        let parent_chain = open_absolute_directory_chain(path.parent().unwrap()).unwrap();
        open_relative_file_with_access(
            parent_chain.last().unwrap(),
            path.file_name().unwrap(),
            FILE_OPEN,
            winapi::um::winnt::GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ,
        )
        .unwrap()
        .unwrap()
    }

    fn recovery_record(
        parent: &Path,
        token: &str,
        capability: &RootCapabilityContext,
        original_name: &str,
        contents: &[u8],
    ) -> CleanupJournalRecord {
        let original_path = parent.join(original_name);
        let quarantine_dir = parent.join(format!(".codeagentpro-quarantine-{token}"));
        let quarantine_path = quarantine_dir.join("target");
        fs::create_dir(&quarantine_dir).unwrap();
        fs::write(&quarantine_path, contents).unwrap();
        let target_handle = open_cleanup_target(&quarantine_path, false).unwrap();
        let summary = cleanup_target_summary(
            &drive_root(&quarantine_path),
            &quarantine_path,
            &target_handle,
            false,
        )
        .unwrap();
        let original_parent_object_id = directory_object_id(
            open_absolute_directory_chain(parent)
                .unwrap()
                .last()
                .unwrap(),
        )
        .unwrap();
        CleanupJournalRecord {
            schema_version: 1,
            quarantine_token: token.to_string(),
            capability_binding: cleanup_capability_binding(capability),
            owner_session_id: capability.session_id.clone(),
            owner_run_id: capability.run_id.clone(),
            owner_source_message_id: capability.source_message_id.clone(),
            original_path,
            original_parent_object_id,
            quarantine_path,
            quarantine_dir,
            target_object_id: directory_object_id(&target_handle).unwrap(),
            target_link_count: Some(1),
            target_type: CleanupJournalTargetType::File,
            target_bytes: summary.bytes,
            target_modified_millis: summary.modified_millis,
            target_hash: summary.hash,
        }
    }

    #[test]
    fn r4_core5_cleanup_phase_matrix_keeps_terminal_states_immutable() {
        use CleanupJournalPhase::*;

        for (from, allowed) in [
            (
                Planned,
                vec![Planned, Quarantined, RestorePlanned, Restored, Orphan],
            ),
            (
                Quarantined,
                vec![Quarantined, RestorePlanned, Restored, DeletePlanned, Orphan],
            ),
            (RestorePlanned, vec![RestorePlanned, Restored, Orphan]),
            (
                DeletePlanned,
                vec![DeletePlanned, RestorePlanned, Restored, Deleted, Orphan],
            ),
            (Orphan, vec![Orphan, RestorePlanned, Restored, Deleted]),
            (Restored, vec![]),
            (Deleted, vec![]),
        ] {
            for next in [
                Planned,
                Quarantined,
                RestorePlanned,
                Restored,
                DeletePlanned,
                Deleted,
                Orphan,
            ] {
                assert_eq!(
                    from.can_transition_to(next),
                    allowed.contains(&next),
                    "unexpected cleanup transition {from:?} -> {next:?}"
                );
            }
        }
        assert!(Restored.is_terminal());
        assert!(Deleted.is_terminal());
        assert!(!Orphan.is_terminal());
    }

    #[test]
    fn r4_core5_planned_quarantined_restore_and_delete_planned_crashes_restore_original() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "crash-session".to_string(),
            run_id: "crash-run".to_string(),
            source_message_id: "crash-message".to_string(),
            nonce: "crash-nonce".to_string(),
        };
        for phase in [
            CleanupJournalPhase::Planned,
            CleanupJournalPhase::Quarantined,
            CleanupJournalPhase::RestorePlanned,
            CleanupJournalPhase::DeletePlanned,
        ] {
            let token = Uuid::new_v4().to_string();
            let record = recovery_record(
                temp.path(),
                &token,
                &capability,
                &format!("{phase:?}.tmp"),
                format!("{phase:?}").as_bytes(),
            );
            persist_cleanup_journal_phase(&record, "planned").unwrap();
            if phase != CleanupJournalPhase::Planned {
                persist_cleanup_journal_phase(&record, "quarantined").unwrap();
            }
            match phase {
                CleanupJournalPhase::RestorePlanned => {
                    persist_cleanup_journal_phase(&record, "restore-planned").unwrap()
                }
                CleanupJournalPhase::DeletePlanned => {
                    persist_cleanup_journal_phase(&record, "delete-planned").unwrap()
                }
                _ => {}
            }
            let entry =
                read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                    .unwrap();

            reconcile_cleanup_journal_record(entry).unwrap();

            assert!(record.original_path.exists(), "failed phase {phase:?}");
            assert!(!record.quarantine_path.exists(), "failed phase {phase:?}");
            assert_eq!(
                read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                    .unwrap()
                    .phase,
                CleanupJournalPhase::Restored
            );
        }
    }

    #[test]
    fn r4_core5_retry_cleanup_recovery_preserves_unheld_quarantine_directory() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "retry-directory-session".to_string(),
            run_id: "retry-directory-run".to_string(),
            source_message_id: "retry-directory-message".to_string(),
            nonce: "retry-directory-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "retry-directory.tmp",
            b"retry directory cleanup",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();

        let response = retry_cleanup_recovery_original(RetryCleanupRecoveryRequest {
            capability,
            quarantine_token: token.clone(),
        })
        .unwrap();

        assert!(response.restored);
        assert_eq!(
            fs::read(&record.original_path).unwrap(),
            b"retry directory cleanup"
        );
        assert!(record.quarantine_dir.is_dir());
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Restored
        );
    }

    #[test]
    fn r4_core5_delete_planned_preserves_unheld_quarantine_directory_and_persists_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "delete-directory-session".to_string(),
            run_id: "delete-directory-run".to_string(),
            source_message_id: "delete-directory-message".to_string(),
            nonce: "delete-directory-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "delete-directory.tmp",
            b"delete directory cleanup",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();
        persist_cleanup_journal_phase(&record, "delete-planned").unwrap();
        fs::remove_file(&record.quarantine_path).unwrap();
        assert!(record.quarantine_dir.is_dir());
        let entry =
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap();

        reconcile_cleanup_journal_record(entry).unwrap();

        assert!(record.quarantine_dir.is_dir());
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Deleted
        );
    }

    #[test]
    fn r4_core5_retry_delete_planned_missing_target_recovers_to_deleted_after_persist_fault() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "retry-delete-planned-session".to_string(),
            run_id: "retry-delete-planned-run".to_string(),
            source_message_id: "retry-delete-planned-message".to_string(),
            nonce: "retry-delete-planned-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "retry-delete-planned.tmp",
            b"delete already committed",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();
        persist_cleanup_journal_phase(&record, "delete-planned").unwrap();
        fs::remove_file(&record.quarantine_path).unwrap();

        {
            let _fault = TestCleanupJournalFaultGuard::enter(CleanupJournalPhase::Deleted, false);
            assert!(
                retry_cleanup_recovery_original(RetryCleanupRecoveryRequest {
                    capability: capability.clone(),
                    quarantine_token: token.clone(),
                })
                .is_err()
            );
        }
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::DeletePlanned
        );

        fs::write(&record.original_path, b"retry replacement occupant").unwrap();
        let replacement_handle = open_readonly_cleanup_test_file(&record.original_path);
        let replacement_id = directory_object_id(&replacement_handle).unwrap();

        let response = retry_cleanup_recovery_original(RetryCleanupRecoveryRequest {
            capability,
            quarantine_token: token.clone(),
        })
        .unwrap();

        assert!(!response.restored);
        assert_eq!(
            fs::read(&record.original_path).unwrap(),
            b"retry replacement occupant"
        );
        assert_eq!(
            directory_object_id(&replacement_handle).unwrap(),
            replacement_id
        );
        assert_eq!(
            final_identity(&replacement_handle).unwrap(),
            normalize_identity(&record.original_path).unwrap()
        );
        assert!(record.quarantine_dir.is_dir());
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Deleted
        );
    }

    #[test]
    fn r4_core5_reconcile_delete_planned_fault_then_reconcile_finishes_deleted_not_orphan() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "reconcile-delete-planned-session".to_string(),
            run_id: "reconcile-delete-planned-run".to_string(),
            source_message_id: "reconcile-delete-planned-message".to_string(),
            nonce: "reconcile-delete-planned-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "reconcile-delete-planned.tmp",
            b"delete committed before reconciliation",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();
        persist_cleanup_journal_phase(&record, "delete-planned").unwrap();
        fs::remove_file(&record.quarantine_path).unwrap();

        {
            let _fault = TestCleanupJournalFaultGuard::enter(CleanupJournalPhase::Deleted, false);
            assert!(reconcile_cleanup_quarantine_journal().is_err());
        }
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::DeletePlanned
        );

        fs::write(&record.original_path, b"reconcile replacement occupant").unwrap();
        let replacement_handle = open_readonly_cleanup_test_file(&record.original_path);
        let replacement_id = directory_object_id(&replacement_handle).unwrap();

        reconcile_cleanup_quarantine_journal().unwrap();

        assert_eq!(
            fs::read(&record.original_path).unwrap(),
            b"reconcile replacement occupant"
        );
        assert_eq!(
            directory_object_id(&replacement_handle).unwrap(),
            replacement_id
        );
        assert_eq!(
            final_identity(&replacement_handle).unwrap(),
            normalize_identity(&record.original_path).unwrap()
        );
        assert!(record.quarantine_dir.is_dir());
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Deleted
        );
    }

    #[test]
    fn r4_core5_reconcile_delete_planned_missing_quarantine_exact_original_is_restored() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "reconcile-exact-original-session".to_string(),
            run_id: "reconcile-exact-original-run".to_string(),
            source_message_id: "reconcile-exact-original-message".to_string(),
            nonce: "reconcile-exact-original-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "reconcile-exact-original.tmp",
            b"exact original after delete planning",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();
        persist_cleanup_journal_phase(&record, "delete-planned").unwrap();
        fs::rename(&record.quarantine_path, &record.original_path).unwrap();
        let original_handle = open_readonly_cleanup_test_file(&record.original_path);

        let diagnostics =
            list_cleanup_recovery_diagnostics(ListCleanupRecoveryRequest { capability }).unwrap();
        assert_eq!(diagnostics.recoveries.len(), 1);
        assert!(diagnostics.recoveries[0].retry_original_available);
        reconcile_cleanup_quarantine_journal().unwrap();

        assert_eq!(
            fs::read(&record.original_path).unwrap(),
            b"exact original after delete planning"
        );
        assert_eq!(
            directory_object_id(&original_handle).unwrap(),
            record.target_object_id
        );
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Restored
        );
    }

    #[test]
    fn r4_core5_retry_delete_planned_missing_quarantine_exact_original_is_restored() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "retry-exact-original-session".to_string(),
            run_id: "retry-exact-original-run".to_string(),
            source_message_id: "retry-exact-original-message".to_string(),
            nonce: "retry-exact-original-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "retry-exact-original.tmp",
            b"exact original before retry",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();
        persist_cleanup_journal_phase(&record, "delete-planned").unwrap();
        fs::rename(&record.quarantine_path, &record.original_path).unwrap();
        let original_handle = open_readonly_cleanup_test_file(&record.original_path);

        let diagnostics = list_cleanup_recovery_diagnostics(ListCleanupRecoveryRequest {
            capability: capability.clone(),
        })
        .unwrap();
        assert_eq!(diagnostics.recoveries.len(), 1);
        assert!(diagnostics.recoveries[0].retry_original_available);
        let response = retry_cleanup_recovery_original(RetryCleanupRecoveryRequest {
            capability,
            quarantine_token: token.clone(),
        })
        .unwrap();

        assert!(response.restored);
        assert_eq!(
            fs::read(&record.original_path).unwrap(),
            b"exact original before retry"
        );
        assert_eq!(
            directory_object_id(&original_handle).unwrap(),
            record.target_object_id
        );
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Restored
        );
    }

    #[test]
    fn r4_core5_reconcile_quarantine_presence_error_is_not_treated_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "reconcile-presence-error-session".to_string(),
            run_id: "reconcile-presence-error-run".to_string(),
            source_message_id: "reconcile-presence-error-message".to_string(),
            nonce: "reconcile-presence-error-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "reconcile-presence-error.tmp",
            b"remain quarantined on inspection error",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();

        {
            let _fault = TestCleanupInspectionFaultGuard::enter(record.quarantine_path.clone());
            assert!(reconcile_cleanup_quarantine_journal().is_err());
        }

        assert_eq!(
            fs::read(&record.quarantine_path).unwrap(),
            b"remain quarantined on inspection error"
        );
        assert!(!record.original_path.exists());
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Quarantined
        );
    }

    #[test]
    fn r4_core5_retry_quarantine_presence_error_is_not_treated_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "retry-presence-error-session".to_string(),
            run_id: "retry-presence-error-run".to_string(),
            source_message_id: "retry-presence-error-message".to_string(),
            nonce: "retry-presence-error-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "retry-presence-error.tmp",
            b"remain quarantined before retry",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();

        {
            let _fault = TestCleanupInspectionFaultGuard::enter(record.quarantine_path.clone());
            assert!(
                retry_cleanup_recovery_original(RetryCleanupRecoveryRequest {
                    capability,
                    quarantine_token: token.clone(),
                })
                .is_err()
            );
        }

        assert_eq!(
            fs::read(&record.quarantine_path).unwrap(),
            b"remain quarantined before retry"
        );
        assert!(!record.original_path.exists());
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Quarantined
        );
    }

    #[test]
    fn r4_core5_startup_reconcile_never_deletes_replacement_quarantine_directory() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "replacement-directory-session".to_string(),
            run_id: "replacement-directory-run".to_string(),
            source_message_id: "replacement-directory-message".to_string(),
            nonce: "replacement-directory-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "replacement-directory.tmp",
            b"replacement directory cleanup",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();
        fs::rename(&record.quarantine_path, &record.original_path).unwrap();
        let original_wrapper = temp.path().join("original-quarantine-wrapper");
        fs::rename(&record.quarantine_dir, &original_wrapper).unwrap();
        fs::create_dir(&record.quarantine_dir).unwrap();
        let entry =
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap();

        reconcile_cleanup_journal_record(entry).unwrap();

        assert_eq!(
            fs::read(&record.original_path).unwrap(),
            b"replacement directory cleanup"
        );
        assert!(original_wrapper.is_dir());
        assert!(record.quarantine_dir.is_dir());
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Restored
        );
    }

    #[test]
    fn r4_core5_orphan_does_not_starve_later_delete_commit() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "matrix-session".to_string(),
            run_id: "matrix-run".to_string(),
            source_message_id: "matrix-message".to_string(),
            nonce: "matrix-nonce".to_string(),
        };
        let orphan = recovery_record(
            temp.path(),
            "00000000-0000-4000-8000-000000000001",
            &capability,
            "occupied.tmp",
            b"orphan",
        );
        fs::write(&orphan.original_path, b"occupant").unwrap();
        persist_cleanup_journal_phase(&orphan, "planned").unwrap();
        persist_cleanup_journal_phase(&orphan, "quarantined").unwrap();

        let deleted = recovery_record(
            temp.path(),
            "ffffffff-ffff-4fff-bfff-ffffffffffff",
            &capability,
            "deleted.tmp",
            b"deleted",
        );
        persist_cleanup_journal_phase(&deleted, "planned").unwrap();
        persist_cleanup_journal_phase(&deleted, "quarantined").unwrap();
        persist_cleanup_journal_phase(&deleted, "delete-planned").unwrap();
        fs::remove_file(&deleted.quarantine_path).unwrap();
        fs::remove_dir(&deleted.quarantine_dir).unwrap();

        let error = reconcile_cleanup_quarantine_journal().unwrap_err();
        assert!(error.to_string().contains("requires attention"));
        let orphan_entry = read_cleanup_journal_entry(
            &cleanup_journal_dir().join(format!("{}.json", orphan.quarantine_token)),
        )
        .unwrap();
        let deleted_entry = read_cleanup_journal_entry(
            &cleanup_journal_dir().join(format!("{}.json", deleted.quarantine_token)),
        )
        .unwrap();
        assert_eq!(orphan_entry.phase, CleanupJournalPhase::Orphan);
        assert_eq!(deleted_entry.phase, CleanupJournalPhase::Deleted);
        assert!(!cleanup_retry_original_available(deleted_entry.phase, &deleted).unwrap());
        assert!(persist_cleanup_journal_phase(&deleted, "orphan").is_err());
    }

    #[tokio::test]
    async fn r4_core5_close_waits_for_in_flight_access_and_rejects_new_dispatches() {
        let session_id = format!("close-race-{}", Uuid::new_v4());
        let permit = acquire_session_access(&session_id).unwrap();
        let barrier = begin_session_close(&session_id).unwrap();
        assert!(acquire_session_access(&session_id).is_err());

        let waiting = tokio::spawn(async move { barrier.wait_for_idle().await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(permit);
        waiting.await.unwrap().unwrap();

        reopen_session_access(&session_id).unwrap();
        assert!(acquire_session_access(&session_id).is_ok());
    }

    #[tokio::test]
    async fn failed_lifecycle_transaction_reopens_session_access() {
        let session_id = format!("failed-lifecycle-{}", Uuid::new_v4());
        {
            let transaction = begin_session_lifecycle_transaction(&session_id).unwrap();
            transaction.wait_for_idle().await.unwrap();
            assert!(acquire_session_access(&session_id).is_err());
        }
        assert!(acquire_session_access(&session_id).is_ok());
    }

    #[tokio::test]
    async fn committed_lifecycle_transaction_remains_closed() {
        let session_id = format!("committed-lifecycle-{}", Uuid::new_v4());
        let transaction = begin_session_lifecycle_transaction(&session_id).unwrap();
        transaction.wait_for_idle().await.unwrap();
        transaction.commit_closed();
        assert!(acquire_session_access(&session_id).is_err());
        reopen_session_access(&session_id).unwrap();
    }

    #[tokio::test]
    async fn restored_capability_uses_a_new_generation_that_survives_the_old_timer() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let context = cleanup_capability(&root);
        let reservation =
            reserve_root_capability(&context, &root, RootCapabilityKind::CleanupAudit).unwrap();
        let capability = reservation.commit().unwrap();
        let old_generation = capability.generation;
        restore_root_capability(capability).unwrap();

        expire_root_capability_generation(&context.nonce, old_generation);
        assert!(reserve_root_capability(&context, &root, RootCapabilityKind::CleanupAudit).is_ok());
        capability_registry().lock().unwrap().remove(&context.nonce);
    }

    #[tokio::test]
    async fn repeated_successful_allocation_returns_the_same_receipt_for_the_same_nonce() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let session_id = format!("allocation-session-{}", Uuid::new_v4());
        let capability = issue_root_capability(
            &session_id,
            "allocation-run",
            "allocation-message",
            Some(&root),
            RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let original_capability = capability_registry()
            .lock()
            .unwrap()
            .get(&capability.nonce)
            .unwrap()
            .clone();
        let suggested_name = format!(
            "capability-retry-{}",
            &Uuid::new_v4().simple().to_string()[..12]
        );
        let request = || AllocateWorkspaceChildRequest {
            container_path: root.to_string_lossy().into_owned(),
            suggested_name: suggested_name.clone(),
            capability: capability.clone(),
        };

        let error = allocate_workspace_child_with_hook(request(), || {
            Err(io::Error::from_raw_os_error(5).into())
        })
        .unwrap_err();
        assert_eq!(
            workspace_allocation_permission_error_data(&error).unwrap(),
            serde_json::json!({
                "code": "workspace_permission_denied",
                "retryable": true,
                "capabilityPreserved": true,
            })
        );
        let preserved = capability_registry()
            .lock()
            .unwrap()
            .get(&capability.nonce)
            .unwrap()
            .clone();
        assert_eq!(preserved.context, original_capability.context);
        assert_eq!(preserved.generation, original_capability.generation);
        assert_eq!(preserved.expires_at, original_capability.expires_at);
        assert!(!preserved.reserved);

        let response = allocate_workspace_child_with_hook(request(), || Ok(())).unwrap();
        assert!(!capability_registry()
            .lock()
            .unwrap()
            .contains_key(&capability.nonce));
        assert_eq!(
            registry()
                .lock()
                .unwrap()
                .pending
                .values()
                .filter(|lease| lease.owner_session_id.as_deref() == Some(session_id.as_str()))
                .count(),
            1
        );
        assert!(Path::new(&response.working_dir).is_dir());
        let duplicate = allocate_workspace_child_with_hook(request(), || Ok(())).unwrap();
        assert_eq!(duplicate.lease_id, response.lease_id);
        assert_eq!(duplicate.working_dir, response.working_dir);
        assert_eq!(duplicate.normalized_identity, response.normalized_identity);
        let mut conflicting = request();
        conflicting.suggested_name.push_str("-changed");
        let conflict = allocate_workspace_child_with_hook(conflicting, || Ok(())).unwrap_err();
        assert!(conflict
            .to_string()
            .contains("nonce does not match its original request"));
        assert_eq!(
            registry()
                .lock()
                .unwrap()
                .pending
                .values()
                .filter(|lease| lease.owner_session_id.as_deref() == Some(session_id.as_str()))
                .count(),
            1
        );
        release_workspace_lease(&response.lease_id).unwrap();
        assert!(!Path::new(&response.working_dir).exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_allocation_with_the_same_nonce_creates_one_child() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let session_id = format!("concurrent-allocation-{}", Uuid::new_v4());
        let capability = issue_root_capability(
            &session_id,
            "concurrent-run",
            "concurrent-message",
            Some(&root),
            RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let suggested_name = format!(
            "concurrent-child-{}",
            &Uuid::new_v4().simple().to_string()[..12]
        );
        let barrier = Arc::new(std::sync::Barrier::new(3));

        let start_first = barrier.clone();
        let first_capability = capability.clone();
        let first_root = root.clone();
        let first_name = suggested_name.clone();
        let first = tokio::task::spawn_blocking(move || {
            start_first.wait();
            allocate_workspace_child(AllocateWorkspaceChildRequest {
                container_path: first_root.to_string_lossy().into_owned(),
                suggested_name: first_name,
                capability: first_capability,
            })
            .unwrap()
        });
        let start_second = barrier.clone();
        let second_capability = capability.clone();
        let second_root = root.clone();
        let second_name = suggested_name.clone();
        let second = tokio::task::spawn_blocking(move || {
            start_second.wait();
            allocate_workspace_child(AllocateWorkspaceChildRequest {
                container_path: second_root.to_string_lossy().into_owned(),
                suggested_name: second_name,
                capability: second_capability,
            })
            .unwrap()
        });
        barrier.wait();
        let responses = [first.await.unwrap(), second.await.unwrap()];

        assert_eq!(responses[0].lease_id, responses[1].lease_id);
        assert_eq!(responses[0].working_dir, responses[1].working_dir);
        assert!(!root.join(format!("{suggested_name}-2")).exists());
        release_workspace_lease(&responses[0].lease_id).unwrap();
    }

    #[tokio::test]
    async fn r4_core5_failure_after_child_creation_consumes_capability_and_creates_no_suffix() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let capability = issue_root_capability(
            "after-create-session",
            "after-create-run",
            "after-create-message",
            Some(&root),
            RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let suggested_name = format!(
            "after-create-{}",
            &Uuid::new_v4().simple().to_string()[..12]
        );
        let request = || AllocateWorkspaceChildRequest {
            container_path: root.to_string_lossy().into_owned(),
            suggested_name: suggested_name.clone(),
            capability: capability.clone(),
        };

        let error = allocate_workspace_child_with_lifecycle_hooks(
            request(),
            || Ok(()),
            |_| bail!("injected failure after child creation"),
            bind_allocated_workspace_owner,
            release_workspace_lease,
        )
        .unwrap_err();

        assert!(error.to_string().contains("after child creation"));
        assert!(!capability_registry()
            .lock()
            .unwrap()
            .contains_key(&capability.nonce));
        assert!(allocate_workspace_child(request()).is_err());
        assert!(!root.join(&suggested_name).exists());
        assert!(!root.join(format!("{suggested_name}-2")).exists());
    }

    #[tokio::test]
    async fn r4_core5_ownership_bind_failure_consumes_capability_and_creates_no_suffix() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let capability = issue_root_capability(
            "bind-failure-session",
            "bind-failure-run",
            "bind-failure-message",
            Some(&root),
            RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let suggested_name = format!(
            "bind-failure-{}",
            &Uuid::new_v4().simple().to_string()[..12]
        );
        let request = || AllocateWorkspaceChildRequest {
            container_path: root.to_string_lossy().into_owned(),
            suggested_name: suggested_name.clone(),
            capability: capability.clone(),
        };

        let error = allocate_workspace_child_with_lifecycle_hooks(
            request(),
            || Ok(()),
            |_| Ok(()),
            |_, _| bail!("injected ownership bind failure"),
            release_workspace_lease,
        )
        .unwrap_err();

        assert!(error.to_string().contains("ownership bind failure"));
        assert!(!capability_registry()
            .lock()
            .unwrap()
            .contains_key(&capability.nonce));
        assert!(allocate_workspace_child(request()).is_err());
        assert!(!root.join(&suggested_name).exists());
        assert!(!root.join(format!("{suggested_name}-2")).exists());
    }

    #[tokio::test]
    async fn r4_core5_rollback_failure_poisoning_rejects_retry_without_a_second_suffix() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let capability = issue_root_capability(
            "rollback-failure-session",
            "rollback-failure-run",
            "rollback-failure-message",
            Some(&root),
            RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let suggested_name = format!(
            "rollback-failure-{}",
            &Uuid::new_v4().simple().to_string()[..12]
        );
        let request = || AllocateWorkspaceChildRequest {
            container_path: root.to_string_lossy().into_owned(),
            suggested_name: suggested_name.clone(),
            capability: capability.clone(),
        };
        let created_lease_id = std::cell::RefCell::new(None);

        let error = allocate_workspace_child_with_lifecycle_hooks(
            request(),
            || Ok(()),
            |response| {
                created_lease_id.replace(Some(response.lease_id.clone()));
                bail!("injected post-create failure")
            },
            bind_allocated_workspace_owner,
            |_| bail!("injected rollback failure"),
        )
        .unwrap_err();

        assert!(error.to_string().contains("rollback failure"));
        assert!(!capability_registry()
            .lock()
            .unwrap()
            .contains_key(&capability.nonce));
        assert!(allocate_workspace_child(request()).is_err());
        assert!(root.join(&suggested_name).is_dir());
        assert!(!root.join(format!("{suggested_name}-2")).exists());

        let lease_id = created_lease_id.into_inner().expect("created lease id");
        release_workspace_lease(&lease_id).unwrap();
        assert!(!root.join(&suggested_name).exists());
    }

    #[test]
    fn r4_core5_permission_error_contract_is_structured_stable_and_path_free() {
        for error in [
            anyhow::Error::new(io::Error::from_raw_os_error(5)),
            anyhow!(r"Access is denied: D:\private\project"),
            anyhow!(r"NtCreateFile D:\private\project failed with NTSTATUS 0xc0000022"),
        ] {
            let classified = path_free_workspace_permission_error(error);
            let data = workspace_allocation_permission_error_data(&classified).unwrap();
            assert_eq!(data["code"], WORKSPACE_PERMISSION_DENIED_CODE);
            assert_eq!(data["retryable"], true);
            assert_eq!(data["capabilityPreserved"], true);
            let serialized = serde_json::to_string(&data).unwrap();
            assert!(!serialized.contains("private"));
            assert!(!serialized.contains("project"));
        }
    }

    #[tokio::test]
    async fn cleanup_requires_a_single_use_audit_token_before_deleting_exact_fixture() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("cleanup-fixture.tmp");
        fs::write(&target, b"fixture").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let response = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        assert!(target.exists());
        assert_eq!(response.target.bytes, 7);
        assert_eq!(response.target.target_type, "file");
        assert!(response.target.hash.is_some());

        let mut mismatched_capability = capability.clone();
        mismatched_capability.source_message_id = "different-message".to_string();
        assert!(execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: response.audit_token.clone(),
            capability: mismatched_capability,
        })
        .is_err());
        assert!(target.exists());

        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: response.audit_token.clone(),
            capability: capability.clone(),
        })
        .unwrap();
        assert!(!target.exists());
        assert!(execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: response.audit_token,
            capability: capability.clone(),
        })
        .is_err());
        permanently_delete_quarantined_cleanup(PermanentlyDeleteQuarantineRequest {
            quarantine_token: quarantine.quarantine_token,
            capability,
        })
        .unwrap();
    }

    #[test]
    fn startup_reconcile_restores_a_crash_after_quarantine_move() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let original = temp.path().join("recover.tmp");
        let token = Uuid::new_v4().to_string();
        let quarantine_dir = temp
            .path()
            .join(format!(".codeagentpro-quarantine-{token}"));
        let quarantine_path = quarantine_dir.join("target");
        fs::create_dir(&quarantine_dir).unwrap();
        fs::write(&quarantine_path, b"recoverable").unwrap();
        let target_handle = open_cleanup_target(&quarantine_path, false).unwrap();
        let target_summary = cleanup_target_summary(
            &drive_root(&quarantine_path),
            &quarantine_path,
            &target_handle,
            false,
        )
        .unwrap();
        let record = CleanupJournalRecord {
            schema_version: 1,
            quarantine_token: token.clone(),
            capability_binding: "a".repeat(64),
            owner_session_id: "session-a".to_string(),
            owner_run_id: "run-a".to_string(),
            owner_source_message_id: "message-a".to_string(),
            original_path: original.clone(),
            original_parent_object_id: directory_object_id(
                open_absolute_directory_chain(original.parent().unwrap())
                    .unwrap()
                    .last()
                    .unwrap(),
            )
            .unwrap(),
            quarantine_path: quarantine_path.clone(),
            quarantine_dir: quarantine_dir.clone(),
            target_object_id: directory_object_id(&target_handle).unwrap(),
            target_link_count: Some(1),
            target_type: cleanup_journal_target_type(&target_summary),
            target_bytes: target_summary.bytes,
            target_modified_millis: target_summary.modified_millis,
            target_hash: target_summary.hash,
        };
        drop(target_handle);
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();

        reconcile_cleanup_quarantine_journal().unwrap();

        assert_eq!(fs::read(&original).unwrap(), b"recoverable");
        assert!(!quarantine_path.exists());
        assert!(cleanup_journal_dir()
            .join(format!("{token}.json"))
            .is_file());
    }

    #[test]
    fn cleanup_journal_atomic_replace_and_integrity_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let token = Uuid::new_v4().to_string();
        let original = temp.path().join("original.tmp");
        let quarantine_dir = temp
            .path()
            .join(format!(".codeagentpro-quarantine-{token}"));
        let quarantine_path = quarantine_dir.join("target");
        fs::create_dir(&quarantine_dir).unwrap();
        fs::write(&quarantine_path, b"signed bytes").unwrap();
        let target_handle = open_cleanup_target(&quarantine_path, false).unwrap();
        let target_summary = cleanup_target_summary(
            &drive_root(&quarantine_path),
            &quarantine_path,
            &target_handle,
            false,
        )
        .unwrap();
        let record = CleanupJournalRecord {
            schema_version: 1,
            quarantine_token: token.clone(),
            capability_binding: "c".repeat(64),
            owner_session_id: "session-c".to_string(),
            owner_run_id: "run-c".to_string(),
            owner_source_message_id: "message-c".to_string(),
            original_path: original,
            original_parent_object_id: directory_object_id(
                open_absolute_directory_chain(temp.path())
                    .unwrap()
                    .last()
                    .unwrap(),
            )
            .unwrap(),
            quarantine_path,
            quarantine_dir,
            target_object_id: directory_object_id(&target_handle).unwrap(),
            target_link_count: Some(1),
            target_type: CleanupJournalTargetType::File,
            target_bytes: target_summary.bytes,
            target_modified_millis: target_summary.modified_millis,
            target_hash: target_summary.hash,
        };
        drop(target_handle);
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        let journal_path = cleanup_journal_dir().join(format!("{token}.json"));

        {
            let _fault =
                TestCleanupJournalFaultGuard::enter(CleanupJournalPhase::Quarantined, false);
            assert!(persist_cleanup_journal_phase(&record, "quarantined").is_err());
        }
        let entry: CleanupJournalEntry =
            serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
        assert_eq!(entry.phase, CleanupJournalPhase::Planned);

        {
            let _fault =
                TestCleanupJournalFaultGuard::enter(CleanupJournalPhase::Quarantined, true);
            assert!(persist_cleanup_journal_phase(&record, "quarantined").is_err());
        }
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
        assert_eq!(value["phase"], "quarantined");
        value["record"]["targetBytes"] = serde_json::json!(999);
        fs::write(&journal_path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(reconcile_cleanup_quarantine_journal().is_err());
    }

    #[test]
    fn r4_core5_persist_journal_presence_error_cannot_bypass_existing_entry_validation() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "persist-probe-session".to_string(),
            run_id: "persist-probe-run".to_string(),
            source_message_id: "persist-probe-message".to_string(),
            nonce: "persist-probe-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "persist-probe.tmp",
            b"existing journal must be validated",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        let journal_path = cleanup_journal_dir().join(format!("{token}.json"));

        {
            let _fault = TestCleanupInspectionFaultGuard::enter(journal_path.clone());
            assert!(persist_cleanup_journal_phase(&record, "quarantined").is_err());
        }

        let entry = read_cleanup_journal_entry(&journal_path).unwrap();
        assert_eq!(entry.phase, CleanupJournalPhase::Planned);
        let key = cleanup_journal_signing_key_unlocked().unwrap();
        assert_eq!(
            entry.mac,
            cleanup_journal_mac(&key, entry.phase, &entry.record).unwrap()
        );
        assert_eq!(entry.record, record);
    }

    #[test]
    fn r4_core5_reconcile_journal_directory_presence_error_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "reconcile-dir-probe-session".to_string(),
            run_id: "reconcile-dir-probe-run".to_string(),
            source_message_id: "reconcile-dir-probe-message".to_string(),
            nonce: "reconcile-dir-probe-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "reconcile-dir-probe.tmp",
            b"remain quarantined on journal dir probe error",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();

        {
            let _fault = TestCleanupInspectionFaultGuard::enter(cleanup_journal_dir());
            assert!(reconcile_cleanup_quarantine_journal().is_err());
        }

        assert_eq!(
            fs::read(&record.quarantine_path).unwrap(),
            b"remain quarantined on journal dir probe error"
        );
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Quarantined
        );
    }

    #[test]
    fn r4_core5_list_journal_directory_presence_error_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "list-dir-probe-session".to_string(),
            run_id: "list-dir-probe-run".to_string(),
            source_message_id: "list-dir-probe-message".to_string(),
            nonce: "list-dir-probe-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "list-dir-probe.tmp",
            b"diagnostic listing must fail closed",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();

        let error = {
            let _fault = TestCleanupInspectionFaultGuard::enter(cleanup_journal_dir());
            list_cleanup_recovery_diagnostics(ListCleanupRecoveryRequest { capability })
                .unwrap_err()
        };

        assert!(error
            .to_string()
            .contains("forced cleanup object inspection failure"));
        assert_eq!(
            fs::read(&record.quarantine_path).unwrap(),
            b"diagnostic listing must fail closed"
        );
    }

    #[test]
    fn r4_core5_ensure_session_terminal_journal_presence_error_never_allows_nonterminal() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let capability = RootCapabilityContext {
            session_id: "ensure-dir-probe-session".to_string(),
            run_id: "ensure-dir-probe-run".to_string(),
            source_message_id: "ensure-dir-probe-message".to_string(),
            nonce: "ensure-dir-probe-nonce".to_string(),
        };
        let token = Uuid::new_v4().to_string();
        let record = recovery_record(
            temp.path(),
            &token,
            &capability,
            "ensure-dir-probe.tmp",
            b"nonterminal must not be allowed",
        );
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();

        let error = {
            let _fault = TestCleanupInspectionFaultGuard::enter(cleanup_journal_dir());
            ensure_session_cleanup_journal_terminal(&capability.session_id).unwrap_err()
        };

        assert!(error
            .to_string()
            .contains("forced cleanup object inspection failure"));
        assert_eq!(
            fs::read(&record.quarantine_path).unwrap(),
            b"nonterminal must not be allowed"
        );
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Quarantined
        );
    }

    #[tokio::test]
    async fn pre_move_journal_failure_removes_only_the_new_empty_quarantine() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("pre-move.tmp");
        fs::write(&target, b"preserve").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        {
            let _fault = TestCleanupJournalFaultGuard::enter(CleanupJournalPhase::Planned, false);
            assert!(execute_root_cleanup(ExecuteRootCleanupRequest {
                audit_token: audit.audit_token,
                capability,
            })
            .is_err());
        }
        assert_eq!(fs::read(&target).unwrap(), b"preserve");
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".codeagentpro-quarantine-")
        }));
    }

    #[tokio::test]
    async fn session_revoke_restores_quarantined_bytes_and_consumes_receipt() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("revoke.tmp");
        fs::write(&target, b"restore on close").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: audit.audit_token,
            capability: capability.clone(),
        })
        .unwrap();
        assert!(!target.exists());

        revoke_session_workspace_authority(&capability.session_id).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"restore on close");
        assert!(
            permanently_delete_quarantined_cleanup(PermanentlyDeleteQuarantineRequest {
                quarantine_token: quarantine.quarantine_token,
                capability,
            })
            .is_err()
        );
    }

    #[tokio::test]
    async fn startup_reconcile_skips_a_quarantine_owned_by_a_live_receipt() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("live-owner.tmp");
        fs::write(&target, b"live receipt").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: audit.audit_token,
            capability: capability.clone(),
        })
        .unwrap();

        reconcile_cleanup_quarantine_journal().unwrap();
        assert!(!target.exists());
        restore_quarantined_cleanup_by_request(PermanentlyDeleteQuarantineRequest {
            quarantine_token: quarantine.quarantine_token,
            capability,
        })
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"live receipt");
    }

    #[tokio::test]
    async fn failed_revoke_restore_permanently_downgrades_receipt_to_restore_only() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("restore-only.tmp");
        fs::write(&target, b"quarantined bytes").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: audit.audit_token,
            capability: capability.clone(),
        })
        .unwrap();
        fs::write(&target, b"occupant").unwrap();

        assert!(revoke_session_workspace_authority(&capability.session_id).is_err());
        assert!(
            permanently_delete_quarantined_cleanup(PermanentlyDeleteQuarantineRequest {
                quarantine_token: quarantine.quarantine_token.clone(),
                capability: capability.clone(),
            })
            .is_err()
        );
        fs::remove_file(&target).unwrap();
        restore_quarantined_cleanup_by_request(PermanentlyDeleteQuarantineRequest {
            quarantine_token: quarantine.quarantine_token,
            capability,
        })
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"quarantined bytes");
    }

    #[tokio::test]
    async fn expired_generation_cannot_regain_permanent_delete_authority() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("expired.tmp");
        fs::write(&target, b"expired bytes").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: audit.audit_token,
            capability: capability.clone(),
        })
        .unwrap();
        let generation = cleanup_quarantine_registry()
            .lock()
            .unwrap()
            .get(&quarantine.quarantine_token)
            .unwrap()
            .generation;
        fs::write(&target, b"occupant").unwrap();

        assert!(
            expire_cleanup_quarantine_generation(&quarantine.quarantine_token, generation).is_err()
        );
        assert!(
            permanently_delete_quarantined_cleanup(PermanentlyDeleteQuarantineRequest {
                quarantine_token: quarantine.quarantine_token.clone(),
                capability: capability.clone(),
            })
            .is_err()
        );
        fs::remove_file(&target).unwrap();
        restore_quarantined_cleanup_by_request(PermanentlyDeleteQuarantineRequest {
            quarantine_token: quarantine.quarantine_token,
            capability,
        })
        .unwrap();
    }

    #[derive(Clone, Copy)]
    enum ExecuteRestoredFailureScenario {
        QuarantineDirectoryValidation,
        TargetIdentity,
        PostMoveValidation,
        QuarantinedJournal,
    }

    fn assert_execute_restored_failure_is_terminal(
        scenario: ExecuteRestoredFailureScenario,
        prefix: &str,
        expected_error: &str,
    ) {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let temp = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(&root)
            .unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("restored-after-execute-error.tmp");
        fs::write(&target, b"preserve after execute error").unwrap();
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();

        let execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _execute_fault = match scenario {
                ExecuteRestoredFailureScenario::QuarantineDirectoryValidation => {
                    Some(TestExecuteRestoredErrorGuard::enter(
                        TestExecuteRestoredErrorPoint::QuarantineDirectoryValidation,
                    ))
                }
                ExecuteRestoredFailureScenario::TargetIdentity => {
                    Some(TestExecuteRestoredErrorGuard::enter(
                        TestExecuteRestoredErrorPoint::TargetIdentity,
                    ))
                }
                ExecuteRestoredFailureScenario::PostMoveValidation => {
                    Some(TestExecuteRestoredErrorGuard::enter(
                        TestExecuteRestoredErrorPoint::PostMoveValidation,
                    ))
                }
                ExecuteRestoredFailureScenario::QuarantinedJournal => None,
            };
            let _rollback_fault = matches!(
                scenario,
                ExecuteRestoredFailureScenario::QuarantineDirectoryValidation
            )
            .then(TestCreatedQuarantineRollbackDeleteFaultGuard::enter);
            let _wrapper_fault = (!matches!(
                scenario,
                ExecuteRestoredFailureScenario::QuarantineDirectoryValidation
            ))
            .then(TestQuarantineDirectoryDeleteFaultGuard::enter);
            let _journal_fault =
                matches!(scenario, ExecuteRestoredFailureScenario::QuarantinedJournal).then(|| {
                    TestCleanupJournalFaultGuard::enter(CleanupJournalPhase::Quarantined, false)
                });
            execute_root_cleanup(ExecuteRootCleanupRequest {
                audit_token: audit.audit_token,
                capability: capability.clone(),
            })
        }));

        let result = execution.expect("execute cleanup restored-error handling must not panic");
        let error = result.unwrap_err();
        assert!(
            error.to_string().contains(expected_error),
            "unexpected execute error: {error:#}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"preserve after execute error");
        let journal_files = fs::read_dir(cleanup_journal_dir())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().extension() == Some(OsStr::new("json")))
            .collect::<Vec<_>>();
        assert_eq!(journal_files.len(), 1);
        let entry = read_cleanup_journal_entry(&journal_files[0].path()).unwrap();
        assert_eq!(entry.phase, CleanupJournalPhase::Restored);
        assert!(
            entry.record.quarantine_dir.is_dir(),
            "the exact wrapper delete fault must defer wrapper cleanup"
        );

        let retry = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        cancel_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: retry.audit_token,
            capability,
        })
        .unwrap();
    }

    #[tokio::test]
    async fn r4_core5_execute_quarantine_directory_validation_error_is_restored_terminal() {
        assert_execute_restored_failure_is_terminal(
            ExecuteRestoredFailureScenario::QuarantineDirectoryValidation,
            "codepro-execute-directory-validation-",
            "cleanup quarantine directory could not be safely reopened after the move",
        );
    }

    #[tokio::test]
    async fn r4_core5_execute_target_identity_error_is_restored_terminal() {
        assert_execute_restored_failure_is_terminal(
            ExecuteRestoredFailureScenario::TargetIdentity,
            "codepro-execute-target-identity-",
            "cleanup target identity changed before quarantine move",
        );
    }

    #[tokio::test]
    async fn r4_core5_execute_post_move_validation_error_is_restored_terminal() {
        assert_execute_restored_failure_is_terminal(
            ExecuteRestoredFailureScenario::PostMoveValidation,
            "codepro-execute-post-move-",
            "forced post-move cleanup validation failure",
        );
    }

    #[tokio::test]
    async fn r4_core5_execute_quarantined_journal_error_is_restored_terminal() {
        assert_execute_restored_failure_is_terminal(
            ExecuteRestoredFailureScenario::QuarantinedJournal,
            "codepro-execute-quarantined-journal-",
            "forced cleanup journal failure before atomic replace",
        );
    }

    #[tokio::test]
    async fn r4_core5_execute_restored_terminal_failure_preserves_original_error_chain() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let temp = tempfile::Builder::new()
            .prefix("codepro-execute-restored-double-fault-")
            .tempdir_in(&root)
            .unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("restored-double-fault.tmp");
        fs::write(&target, b"preserve through double fault").unwrap();
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();

        let error = {
            let _execute_fault = TestExecuteRestoredErrorGuard::enter(
                TestExecuteRestoredErrorPoint::PostMoveValidation,
            );
            let _terminal_fault =
                TestCleanupJournalFaultGuard::enter(CleanupJournalPhase::Restored, false);
            execute_root_cleanup(ExecuteRootCleanupRequest {
                audit_token: audit.audit_token,
                capability,
            })
            .unwrap_err()
        };

        let chain = error.chain().map(ToString::to_string).collect::<Vec<_>>();
        assert!(chain[0].contains("forced cleanup journal failure before atomic replace"));
        assert!(chain
            .iter()
            .any(|cause| cause == "forced post-move cleanup validation failure"));
        assert!(chain
            .iter()
            .any(|cause| cause == "forced post-move cleanup validation root cause"));
        assert_eq!(fs::read(&target).unwrap(), b"preserve through double fault");
    }

    #[test]
    fn r4_core5_created_quarantine_rollback_delete_failure_returns_without_panicking() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let temp = tempfile::Builder::new()
            .prefix("codepro-created-quarantine-rollback-")
            .tempdir_in(&root)
            .unwrap();
        let parent_chain = open_absolute_directory_chain(temp.path()).unwrap();
        let name = OsStr::new(".codeagentpro-quarantine-rollback-fault");
        let path = temp.path().join(name);
        let handle = try_create_cleanup_rename_root_directory(parent_chain.last().unwrap(), name)
            .unwrap()
            .unwrap();
        let guard = CreatedQuarantineDirGuard::new(path.clone(), handle);

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _fault = TestCreatedQuarantineRollbackDeleteFaultGuard::enter();
            guard.rollback()
        }));

        let error = outcome
            .expect("rollback delete failure must not panic")
            .unwrap_err();
        assert!(error.chain().any(|cause| {
            cause
                .to_string()
                .contains("forced created quarantine directory rollback delete failure")
        }));
        assert!(error
            .to_string()
            .contains(&path.to_string_lossy().to_string()));
        assert!(error.to_string().contains("manual cleanup is required"));
        assert!(path.is_dir());
        let renamed = temp.path().join("rollback-wrapper-handles-released");
        fs::rename(&path, &renamed).unwrap();
        assert!(renamed.is_dir());
    }

    #[tokio::test]
    async fn r4_core5_permanent_delete_holds_owner_lock_until_deleted_is_persisted() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let temp = tempfile::Builder::new()
            .prefix("codepro-permanent-delete-owner-lock-")
            .tempdir_in(&root)
            .unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("owner-lock.tmp");
        fs::write(&target, b"owner lock until terminal evidence").unwrap();
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: audit.audit_token,
            capability: capability.clone(),
        })
        .unwrap();
        let token = quarantine.quarantine_token.clone();
        let observed_retry = std::rc::Rc::new(std::cell::RefCell::new(None));
        let hook_result = std::rc::Rc::clone(&observed_retry);
        let retry_capability = capability.clone();
        let retry_token = token.clone();
        let _hook = TestPermanentDeleteBeforeTerminalHookGuard::enter(move || {
            hook_result.replace(Some(retry_cleanup_recovery_original(
                RetryCleanupRecoveryRequest {
                    capability: retry_capability,
                    quarantine_token: retry_token,
                },
            )));
        });

        permanently_delete_quarantined_cleanup(PermanentlyDeleteQuarantineRequest {
            quarantine_token: token.clone(),
            capability,
        })
        .unwrap();

        let retry_error = observed_retry
            .borrow_mut()
            .take()
            .expect("permanent delete hook must run")
            .unwrap_err();
        assert!(retry_error
            .to_string()
            .contains("cleanup recovery is still owned by a live session"));
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Deleted
        );
    }

    #[tokio::test]
    async fn r4_core5_permanent_delete_commits_before_wrapper_cleanup_failure() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let temp = tempfile::Builder::new()
            .prefix("codepro-permanent-delete-commit-")
            .tempdir_in(&root)
            .unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp
            .path()
            .join("delete-committed-before-directory-cleanup.tmp");
        fs::write(&target, b"permanent delete commit").unwrap();
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: audit.audit_token,
            capability: capability.clone(),
        })
        .unwrap();
        let token = quarantine.quarantine_token.clone();
        let (quarantine_path, quarantine_dir) = {
            let registry = cleanup_quarantine_registry().lock().unwrap();
            let receipt = registry.get(&token).unwrap();
            (
                receipt.quarantine_path.clone(),
                receipt.quarantine_dir.clone(),
            )
        };

        {
            let _fault = TestQuarantineDirectoryDeleteFaultGuard::enter();
            permanently_delete_quarantined_cleanup(PermanentlyDeleteQuarantineRequest {
                quarantine_token: token.clone(),
                capability: capability.clone(),
            })
            .unwrap();
        }

        assert!(!quarantine_path.exists());
        assert!(quarantine_dir.is_dir());
        assert!(!cleanup_quarantine_registry()
            .lock()
            .unwrap()
            .contains_key(&token));
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")))
                .unwrap()
                .phase,
            CleanupJournalPhase::Deleted
        );
        assert!(
            permanently_delete_quarantined_cleanup(PermanentlyDeleteQuarantineRequest {
                quarantine_token: token,
                capability,
            })
            .is_err(),
            "a committed permanent delete must not revive its receipt"
        );
    }

    #[tokio::test]
    async fn restore_commit_is_terminal_when_empty_quarantine_directory_cleanup_fails() {
        let root = drive_root(Path::new(env!("CARGO_MANIFEST_DIR")));
        let temp = tempfile::Builder::new()
            .prefix("codepro-restore-commit-")
            .tempdir_in(&root)
            .unwrap();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("committed-before-directory-cleanup.tmp");
        fs::write(&target, b"restore commit").unwrap();
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: audit.audit_token,
            capability: capability.clone(),
        })
        .unwrap();
        let token = quarantine.quarantine_token.clone();
        let quarantine_dir = cleanup_quarantine_registry()
            .lock()
            .unwrap()
            .get(&token)
            .unwrap()
            .quarantine_dir
            .clone();

        {
            let _fault = TestQuarantineDirectoryDeleteFaultGuard::enter();
            restore_quarantined_cleanup_by_request(PermanentlyDeleteQuarantineRequest {
                quarantine_token: token.clone(),
                capability: capability.clone(),
            })
            .unwrap();
        }

        assert_eq!(fs::read(&target).unwrap(), b"restore commit");
        assert!(quarantine_dir.is_dir());
        assert!(!cleanup_quarantine_registry()
            .lock()
            .unwrap()
            .contains_key(&token));
        assert_eq!(
            read_cleanup_journal_entry(&cleanup_journal_dir().join(format!("{token}.json")),)
                .unwrap()
                .phase,
            CleanupJournalPhase::Restored
        );
        assert!(
            restore_quarantined_cleanup_by_request(PermanentlyDeleteQuarantineRequest {
                quarantine_token: token,
                capability,
            })
            .is_err(),
            "a committed restore must not be reinserted as retryable"
        );
    }

    #[tokio::test]
    async fn restored_filesystem_commit_is_not_reclassified_when_terminal_evidence_reports_failure()
    {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("terminal-evidence.tmp");
        fs::write(&target, b"restore commit").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let audit = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let quarantine = execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: audit.audit_token,
            capability: capability.clone(),
        })
        .unwrap();
        {
            let _fault = TestCleanupJournalFaultGuard::enter(CleanupJournalPhase::Restored, true);
            restore_quarantined_cleanup_by_request(PermanentlyDeleteQuarantineRequest {
                quarantine_token: quarantine.quarantine_token,
                capability,
            })
            .unwrap();
        }
        assert_eq!(fs::read(&target).unwrap(), b"restore commit");
        reconcile_cleanup_quarantine_journal().unwrap();
    }

    #[test]
    fn startup_reconcile_persists_orphan_when_original_name_is_occupied() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let original = temp.path().join("occupied.tmp");
        let token = Uuid::new_v4().to_string();
        let quarantine_dir = temp
            .path()
            .join(format!(".codeagentpro-quarantine-{token}"));
        let quarantine_path = quarantine_dir.join("target");
        fs::create_dir(&quarantine_dir).unwrap();
        fs::write(&original, b"new occupant").unwrap();
        fs::write(&quarantine_path, b"recoverable").unwrap();
        let target_handle = open_cleanup_target(&quarantine_path, false).unwrap();
        let target_summary = cleanup_target_summary(
            &drive_root(&quarantine_path),
            &quarantine_path,
            &target_handle,
            false,
        )
        .unwrap();
        let recovery_capability = RootCapabilityContext {
            session_id: "session-b".to_string(),
            run_id: "run-b".to_string(),
            source_message_id: "message-b".to_string(),
            nonce: "recovery-authority-b".to_string(),
        };
        let record = CleanupJournalRecord {
            schema_version: 1,
            quarantine_token: token.clone(),
            capability_binding: cleanup_capability_binding(&recovery_capability),
            owner_session_id: "session-b".to_string(),
            owner_run_id: "run-b".to_string(),
            owner_source_message_id: "message-b".to_string(),
            original_path: original.clone(),
            original_parent_object_id: directory_object_id(
                open_absolute_directory_chain(original.parent().unwrap())
                    .unwrap()
                    .last()
                    .unwrap(),
            )
            .unwrap(),
            quarantine_path: quarantine_path.clone(),
            quarantine_dir,
            target_object_id: directory_object_id(&target_handle).unwrap(),
            target_link_count: Some(1),
            target_type: cleanup_journal_target_type(&target_summary),
            target_bytes: target_summary.bytes,
            target_modified_millis: target_summary.modified_millis,
            target_hash: target_summary.hash,
        };
        drop(target_handle);
        persist_cleanup_journal_phase(&record, "planned").unwrap();
        persist_cleanup_journal_phase(&record, "quarantined").unwrap();

        assert!(reconcile_cleanup_quarantine_journal().is_err());

        assert_eq!(fs::read(&original).unwrap(), b"new occupant");
        assert_eq!(fs::read(&quarantine_path).unwrap(), b"recoverable");
        assert!(cleanup_journal_dir()
            .join(format!("{token}.json"))
            .is_file());
        let diagnostics = list_cleanup_recovery_diagnostics(ListCleanupRecoveryRequest {
            capability: recovery_capability.clone(),
        })
        .unwrap();
        assert_eq!(diagnostics.recoveries.len(), 1);
        assert_eq!(diagnostics.recoveries[0].quarantine_token, token);
        assert!(!diagnostics.recoveries[0].retry_original_available);
        let wrong_capability = RootCapabilityContext {
            session_id: "other-session".to_string(),
            ..recovery_capability.clone()
        };
        assert!(
            list_cleanup_recovery_diagnostics(ListCleanupRecoveryRequest {
                capability: wrong_capability.clone(),
            })
            .unwrap()
            .recoveries
            .is_empty()
        );
        assert!(
            retry_cleanup_recovery_original(RetryCleanupRecoveryRequest {
                capability: wrong_capability,
                quarantine_token: token.clone(),
            })
            .is_err()
        );
        assert!(ensure_session_cleanup_journal_terminal("session-b").is_err());

        fs::remove_file(&original).unwrap();
        let retryable = list_cleanup_recovery_diagnostics(ListCleanupRecoveryRequest {
            capability: recovery_capability.clone(),
        })
        .unwrap();
        assert!(retryable.recoveries[0].retry_original_available);
        let recovery = retry_cleanup_recovery_original(RetryCleanupRecoveryRequest {
            capability: recovery_capability.clone(),
            quarantine_token: token.clone(),
        })
        .unwrap();
        assert!(recovery.restored);
        assert_eq!(fs::read(&original).unwrap(), b"recoverable");
        assert!(ensure_session_cleanup_journal_terminal("session-b").is_ok());
        assert!(
            retry_cleanup_recovery_original(RetryCleanupRecoveryRequest {
                capability: recovery_capability,
                quarantine_token: token,
            })
            .is_err()
        );
    }

    #[tokio::test]
    async fn cleanup_rechecks_project_markers_added_after_audit() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("post-audit.tmp");
        fs::write(&target, b"fixture").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let response = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();

        fs::create_dir(temp.path().join(".hg")).unwrap();
        assert!(execute_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: response.audit_token,
            capability: capability.clone(),
        })
        .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"fixture");

        fs::remove_dir(temp.path().join(".hg")).unwrap();
        let retry = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        cancel_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: retry.audit_token,
            capability,
        })
        .unwrap();
    }

    #[tokio::test]
    async fn cleanup_marker_race_after_first_check_fails_without_deleting_target() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("race.tmp");
        fs::write(&target, b"preserve").unwrap();
        let marker = temp.path().join(".svn");
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let response = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();

        let result = execute_root_cleanup_with_hook(
            ExecuteRootCleanupRequest {
                audit_token: response.audit_token,
                capability,
            },
            || {
                fs::create_dir(&marker)?;
                Ok(())
            },
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"preserve");
        assert!(marker.is_dir());
    }

    #[tokio::test]
    async fn cleanup_rejects_existing_and_post_audit_hard_links() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let cache = temp.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let source = temp.path().join("project-data.txt");
        fs::write(&source, b"preserve").unwrap();
        let linked_target = cache.join("linked.tmp");
        fs::hard_link(&source, &linked_target).unwrap();
        let root = drive_root(&linked_target);
        assert!(audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![linked_target.to_string_lossy().into_owned()],
            capability: cleanup_capability(&root),
        })
        .is_err());
        assert_eq!(fs::read(&source).unwrap(), b"preserve");

        let target = cache.join("race.tmp");
        fs::write(&target, b"preserve-race").unwrap();
        let capability = cleanup_capability(&root);
        let response = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        let post_audit_link = temp.path().join("post-audit-link.tmp");
        let link_result = fs::hard_link(&target, &post_audit_link);
        if link_result.is_ok() {
            assert!(execute_root_cleanup(ExecuteRootCleanupRequest {
                audit_token: response.audit_token,
                capability,
            })
            .is_err());
        } else {
            cancel_root_cleanup(ExecuteRootCleanupRequest {
                audit_token: response.audit_token,
                capability,
            })
            .unwrap();
        }
        assert_eq!(fs::read(&target).unwrap(), b"preserve-race");
    }

    #[tokio::test]
    async fn cleanup_cancel_is_write_zero_and_project_targets_fail_closed() {
        let temp = cleanup_audit_tempdir();
        let _journal = TestCleanupJournalRootGuard::enter(temp.path().join("journal"));
        let target = temp.path().join("keep.tmp");
        fs::write(&target, b"keep").unwrap();
        let root = drive_root(&target);
        let capability = cleanup_capability(&root);
        let response = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        cancel_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: response.audit_token,
            capability: capability.clone(),
        })
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"keep");

        let retry = audit_root_cleanup(AuditRootCleanupRequest {
            root_path: root.to_string_lossy().into_owned(),
            targets: vec![target.to_string_lossy().into_owned()],
            capability: capability.clone(),
        })
        .unwrap();
        cancel_root_cleanup(ExecuteRootCleanupRequest {
            audit_token: retry.audit_token,
            capability,
        })
        .unwrap();

        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::write(project.join("Cargo.toml"), b"[package]").unwrap();
        let project_target = project.join("cache.tmp");
        fs::write(&project_target, b"cache").unwrap();
        let project_root = drive_root(&project_target);
        assert!(audit_root_cleanup(AuditRootCleanupRequest {
            root_path: project_root.to_string_lossy().into_owned(),
            targets: vec![project_target.to_string_lossy().into_owned()],
            capability: cleanup_capability(&project_root),
        })
        .is_err());
    }

    #[test]
    fn locked_parent_cannot_be_replaced_before_handle_relative_leaf_create() {
        let temp = tempfile::tempdir().unwrap();
        let reviewed_parent = temp.path().join("reviewed-parent");
        let preserved_parent = temp.path().join("reviewed-parent-preserved");
        let changed_target = temp.path().join("changed-target");
        fs::create_dir(&reviewed_parent).unwrap();
        fs::create_dir(&changed_target).unwrap();
        let requested = reviewed_parent.join("new-app");
        let mut replacement_succeeded = false;

        let response =
            acquire_workspace_lease_with_hook(request(&requested, WorkspaceState::Missing), || {
                if fs::rename(&reviewed_parent, &preserved_parent).is_ok() {
                    replacement_succeeded = true;
                    create_junction(&reviewed_parent, &changed_target)?;
                }
                Ok(())
            })
            .unwrap();

        assert!(!replacement_succeeded);
        assert!(requested.is_dir());
        assert!(!changed_target.join("new-app").exists());
        release_workspace_lease(&response.lease_id).unwrap();
    }

    #[test]
    fn releasing_an_unconsumed_missing_lease_removes_only_its_empty_created_leaf() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("container");
        fs::create_dir(&parent).unwrap();
        let requested = parent.join("semantic-project");

        let response =
            acquire_workspace_lease(request(&requested, WorkspaceState::Missing)).unwrap();
        assert!(requested.is_dir());

        release_workspace_lease(&response.lease_id).unwrap();

        assert!(!requested.exists());
        assert!(parent.is_dir());
    }

    #[test]
    fn rollback_refuses_to_delete_a_created_leaf_that_is_no_longer_empty() {
        let temp = tempfile::tempdir().unwrap();
        let requested = temp.path().join("semantic-project");
        let response =
            acquire_workspace_lease(request(&requested, WorkspaceState::Missing)).unwrap();
        fs::write(requested.join("foreign.txt"), b"preserve").unwrap();

        let error = release_workspace_lease(&response.lease_id).unwrap_err();

        assert!(error.to_string().contains("rollback refused"));
        assert_eq!(
            fs::read(requested.join("foreign.txt")).unwrap(),
            b"preserve"
        );
    }

    #[test]
    fn locked_ancestor_chain_cannot_be_replaced_before_leaf_create() {
        let temp = tempfile::tempdir().unwrap();
        let reviewed_ancestor = temp.path().join("reviewed-ancestor");
        let preserved_ancestor = temp.path().join("reviewed-ancestor-preserved");
        let reviewed_parent = reviewed_ancestor.join("workspace");
        let changed_ancestor = temp.path().join("changed-ancestor");
        let changed_parent = changed_ancestor.join("workspace");
        fs::create_dir_all(&reviewed_parent).unwrap();
        fs::create_dir_all(&changed_parent).unwrap();
        let requested = reviewed_parent.join("new-app");
        let mut replacement_succeeded = false;

        let response =
            acquire_workspace_lease_with_hook(request(&requested, WorkspaceState::Missing), || {
                if fs::rename(&reviewed_ancestor, &preserved_ancestor).is_ok() {
                    replacement_succeeded = true;
                    create_junction(&reviewed_ancestor, &changed_ancestor)?;
                }
                Ok(())
            })
            .unwrap();

        assert!(!replacement_succeeded);
        assert!(requested.is_dir());
        assert!(!changed_parent.join("new-app").exists());
        release_workspace_lease(&response.lease_id).unwrap();
    }

    #[test]
    fn original_parent_handle_blocks_canonical_ancestor_swap_before_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let canonical_ancestor = temp.path().join("canonical-ancestor");
        let preserved_ancestor = temp.path().join("canonical-ancestor-preserved");
        let canonical_parent = canonical_ancestor.join("workspace");
        let alias = temp.path().join("workspace-alias");
        let requested = alias.join("new-app");
        let canonical_workspace = canonical_parent.join("new-app");
        fs::create_dir_all(&canonical_parent).unwrap();
        create_junction(&alias, &canonical_parent).unwrap();
        let mut replacement_completed = false;

        let result = acquire_workspace_lease_with_hooks(
            AcquireWorkspaceLeaseRequest {
                requested_path: requested.to_string_lossy().into_owned(),
                expected_state: WorkspaceState::Missing,
                expected_identity: normalize_identity(&canonical_workspace).unwrap(),
            },
            || {
                if fs::rename(&canonical_ancestor, &preserved_ancestor).is_ok() {
                    fs::create_dir_all(&canonical_parent)?;
                    replacement_completed = true;
                }
                Ok(())
            },
            || Ok(()),
        );

        assert!(result.is_err());
        assert!(!canonical_workspace.exists());
        assert!(!preserved_ancestor
            .join("workspace")
            .join("new-app")
            .exists());
        assert!(!replacement_completed);
    }

    #[test]
    fn different_directory_objects_fail_stable_file_id_comparison() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let first_chain = open_absolute_directory_chain(&first).unwrap();
        let second_chain = open_absolute_directory_chain(&second).unwrap();

        assert!(ensure_same_directory_object(
            first_chain.last().unwrap(),
            first_chain.last().unwrap()
        )
        .is_ok());
        assert!(ensure_same_directory_object(
            first_chain.last().unwrap(),
            second_chain.last().unwrap()
        )
        .is_err());
    }

    #[test]
    fn unsupported_file_id_info_falls_back_to_legacy_directory_identity() {
        let expected = DirectoryObjectId::LegacyFileIndex {
            volume_serial_number: 0xdc78_53fd,
            file_index: 0x0123_4567_89ab_cdef,
        };
        let actual = directory_object_id_from_queries(
            Err(std::io::Error::from_raw_os_error(
                winapi::shared::winerror::ERROR_INVALID_PARAMETER as i32,
            )),
            || Ok(expected),
        )
        .unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn unexpected_file_id_info_failure_never_downgrades_to_legacy_identity() {
        let mut legacy_called = false;
        let error = directory_object_id_from_queries(
            Err(std::io::Error::from_raw_os_error(
                winapi::shared::winerror::ERROR_ACCESS_DENIED as i32,
            )),
            || {
                legacy_called = true;
                Ok(DirectoryObjectId::LegacyFileIndex {
                    volume_serial_number: 1,
                    file_index: 2,
                })
            },
        )
        .unwrap_err();

        assert!(!legacy_called);
        assert_eq!(
            error.raw_os_error(),
            Some(winapi::shared::winerror::ERROR_ACCESS_DENIED as i32)
        );
    }

    #[test]
    fn configured_exfat_directory_uses_stable_legacy_identity_and_rejects_another_object() {
        let Some(path) = std::env::var_os("CODEPRO_EXFAT_LEASE_TEST_DIR").map(PathBuf::from) else {
            return;
        };
        assert!(
            path.is_dir(),
            "configured exFAT fixture must be an existing directory"
        );

        let first_chain = open_absolute_directory_chain(&path).unwrap();
        let reopened_chain = open_absolute_directory_chain(&path).unwrap();
        let first = first_chain.last().unwrap();
        let reopened = reopened_chain.last().unwrap();
        assert!(matches!(
            directory_object_id(first).unwrap(),
            DirectoryObjectId::LegacyFileIndex { .. }
        ));
        ensure_same_directory_object(first, reopened).unwrap();

        let replacement = tempfile::Builder::new()
            .prefix("codepro-lease-object-")
            .tempdir_in(&path)
            .unwrap();
        let replacement_chain = open_absolute_directory_chain(replacement.path()).unwrap();
        assert!(ensure_same_directory_object(first, replacement_chain.last().unwrap()).is_err());
    }

    #[test]
    fn configured_exfat_workspace_supports_existing_and_missing_lease_lifecycles() {
        let Some(path) = std::env::var_os("CODEPRO_EXFAT_LEASE_TEST_DIR").map(PathBuf::from) else {
            return;
        };
        assert!(
            path.is_dir(),
            "configured exFAT fixture must be an existing directory"
        );

        let state = if fs::read_dir(&path).unwrap().next().is_some() {
            WorkspaceState::NonEmptyDirectory
        } else {
            WorkspaceState::EmptyDirectory
        };
        let existing = acquire_workspace_lease(request(&path, state)).unwrap();
        let existing = consume_workspace_lease(&existing.lease_id, &path).unwrap();
        validate_consumed_workspace_lease(&existing, &path).unwrap();
        drop(existing);

        let created_path = path.join(format!("codepro-lease-create-{}", Uuid::new_v4()));
        assert!(!created_path.exists());
        let created =
            acquire_workspace_lease(request(&created_path, WorkspaceState::Missing)).unwrap();
        assert!(created.created);
        assert!(created_path.is_dir());
        let created = consume_workspace_lease(&created.lease_id, &created_path).unwrap();
        validate_consumed_workspace_lease(&created, &created_path).unwrap();
        drop(created);
        fs::remove_dir(&created_path).unwrap();
        assert!(!created_path.exists());
    }

    #[test]
    fn competing_reparse_leaf_wins_name_but_never_receives_a_workspace_create() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("parent");
        let changed_target = temp.path().join("changed-target");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&changed_target).unwrap();
        let requested = parent.join("new-app");
        let mut fixture_target = None;

        let result =
            acquire_workspace_lease_with_hook(request(&requested, WorkspaceState::Missing), || {
                create_junction(&requested, &changed_target)?;
                let resolved = fs::canonicalize(&requested)
                    .context("created junction did not resolve inside the race hook")?;
                let expected = fs::canonicalize(&changed_target)?;
                if resolved != expected {
                    bail!(
                        "created junction resolved to {} instead of {}",
                        resolved.display(),
                        expected.display()
                    );
                }
                fixture_target = Some(resolved);
                Ok(())
            });

        let error = result.expect_err("a competing reparse leaf must reject acquisition");
        assert!(
            fixture_target.is_some(),
            "fixture failed before Native create: {error:#}"
        );
        assert!(fs::symlink_metadata(&requested).is_ok());
        assert_eq!(
            fs::canonicalize(&requested).unwrap(),
            fixture_target.unwrap()
        );
        assert!(fs::read_dir(&changed_target).unwrap().next().is_none());
    }

    #[test]
    fn retargeted_junction_alias_cannot_redirect_handle_relative_leaf_create() {
        let temp = tempfile::tempdir().unwrap();
        let reviewed_target = temp.path().join("reviewed-target");
        let changed_target = temp.path().join("changed-target");
        let alias = temp.path().join("workspace-alias");
        fs::create_dir(&reviewed_target).unwrap();
        fs::create_dir(&changed_target).unwrap();
        create_junction(&alias, &reviewed_target).unwrap();
        let requested = alias.join("new-app");
        let canonical_workspace = reviewed_target.join("new-app");
        let request = AcquireWorkspaceLeaseRequest {
            requested_path: requested.to_string_lossy().into_owned(),
            expected_state: WorkspaceState::Missing,
            expected_identity: normalize_identity(&canonical_workspace).unwrap(),
        };

        let result = acquire_workspace_lease_with_hook(request, || {
            fs::remove_dir(&alias)?;
            create_junction(&alias, &changed_target)
        });

        assert!(result.is_err());
        assert!(!canonical_workspace.exists());
        assert!(!changed_target.join("new-app").exists());
    }

    #[test]
    fn lease_token_is_single_use_and_cwd_mismatch_does_not_consume_authority() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();

        let first =
            acquire_workspace_lease(request(&workspace, WorkspaceState::EmptyDirectory)).unwrap();
        let consumed = consume_workspace_lease(&first.lease_id, &workspace).unwrap();
        assert!(consume_workspace_lease(&first.lease_id, &workspace).is_err());
        drop(consumed);

        let second =
            acquire_workspace_lease(request(&workspace, WorkspaceState::EmptyDirectory)).unwrap();
        let wrong_cwd = temp.path().join("other");
        fs::create_dir(&wrong_cwd).unwrap();
        assert!(consume_workspace_lease(&second.lease_id, &wrong_cwd).is_err());
        assert!(consume_workspace_lease(&second.lease_id, &workspace).is_ok());
    }

    #[test]
    fn duplicate_session_binding_fails_without_replacing_the_authoritative_lease() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();

        let first =
            acquire_workspace_lease(request(&workspace, WorkspaceState::EmptyDirectory)).unwrap();
        let first = consume_workspace_lease(&first.lease_id, &workspace).unwrap();
        bind_workspace_lease("duplicate-session", first).unwrap();

        let second =
            acquire_workspace_lease(request(&workspace, WorkspaceState::EmptyDirectory)).unwrap();
        let second = consume_workspace_lease(&second.lease_id, &workspace).unwrap();
        assert!(bind_workspace_lease("duplicate-session", second).is_err());
        assert!(validate_session_workspace_lease("duplicate-session", &workspace).is_ok());
        release_session_workspace_lease("duplicate-session").unwrap();
    }

    #[test]
    fn cleanup_reconcile_once_retries_after_a_transient_failure() {
        let state = Mutex::new(false);
        let attempts = std::cell::Cell::new(0_u8);
        let first = reconcile_cleanup_quarantine_journal_with_state(&state, || {
            attempts.set(attempts.get() + 1);
            bail!("transient journal failure")
        });
        assert!(first.is_err());
        reconcile_cleanup_quarantine_journal_with_state(&state, || {
            attempts.set(attempts.get() + 1);
            Ok(())
        })
        .unwrap();
        reconcile_cleanup_quarantine_journal_with_state(&state, || {
            attempts.set(attempts.get() + 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(attempts.get(), 2);
    }

    #[test]
    fn injected_journal_context_rejects_directory_path_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let journal = temp.path().join("journal");
        let _journal_root = TestCleanupJournalRootGuard::enter(journal.clone());
        fs::write(journal.join("visible.json"), b"{}").unwrap();
        let held = open_cleanup_journal_dir().unwrap();
        let names = cleanup_journal_directory_entries(&held)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&OsString::from("visible.json")));

        let displaced = temp.path().join("journal-displaced");
        if fs::rename(&journal, &displaced).is_ok() {
            fs::create_dir(&journal).unwrap();
            fs::write(journal.join("forged.json"), b"{}").unwrap();
            assert!(cleanup_journal_directory_entries(&held).is_err());
        } else {
            assert!(journal.is_dir());
            assert!(cleanup_journal_directory_entries(&held).is_ok());
        }
    }
}
