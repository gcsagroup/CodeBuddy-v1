#[cfg(windows)]
use crate::subprocess::SubprocessExt;
use async_trait::async_trait;
#[cfg(windows)]
use std::process::Stdio;
use std::sync::Arc;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
const TASKKILL_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(windows)]
const CONFIRM_ATTEMPTS: usize = 20;
#[cfg(windows)]
const CONFIRM_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(windows)]
const MAX_DIAGNOSTIC_CHARS: usize = 1_024;

#[derive(Debug)]
pub struct SystemProcessGroupOwner {
    #[cfg(windows)]
    job: winapi::um::winnt::HANDLE,
    #[cfg(unix)]
    process_group_id: std::sync::atomic::AtomicI32,
}

unsafe impl Send for SystemProcessGroupOwner {}
unsafe impl Sync for SystemProcessGroupOwner {}

impl SystemProcessGroupOwner {
    pub fn new() -> Result<Arc<Self>, ProcessTreeError> {
        #[cfg(windows)]
        {
            let job = create_kill_on_close_job()?;
            Ok(Arc::new(Self { job }))
        }
        #[cfg(unix)]
        {
            Ok(Arc::new(Self {
                process_group_id: std::sync::atomic::AtomicI32::new(0),
            }))
        }
        #[cfg(not(any(windows, unix)))]
        {
            Err(ProcessTreeError::UnsupportedPlatform)
        }
    }

    pub fn configure_command(&self, command: &mut tokio::process::Command) {
        #[cfg(windows)]
        {
            const CREATE_SUSPENDED: u32 = 0x0000_0004;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            command.process_group(0);
        }
    }

    pub fn attach(&self, child: &tokio::process::Child) -> Result<(), ProcessTreeError> {
        let process_id = child.id().ok_or(ProcessTreeError::InvalidProcessId)?;
        #[cfg(windows)]
        {
            let process_handle = child
                .raw_handle()
                .ok_or(ProcessTreeError::InvalidProcessId)?
                as winapi::um::winnt::HANDLE;
            assign_process_to_job(self.job, process_handle, process_id)?;
        }
        #[cfg(unix)]
        self.process_group_id
            .store(process_id as i32, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    pub fn resume(&self, child: &tokio::process::Child) -> Result<(), ProcessTreeError> {
        #[cfg(windows)]
        resume_suspended_process(child.id().ok_or(ProcessTreeError::InvalidProcessId)?)?;
        #[cfg(not(windows))]
        let _ = child;
        Ok(())
    }

    pub fn terminate_group(&self) -> Result<(), ProcessTreeError> {
        #[cfg(windows)]
        return terminate_job(self.job);
        #[cfg(unix)]
        {
            let group = self
                .process_group_id
                .load(std::sync::atomic::Ordering::Acquire);
            if group <= 0 {
                return Ok(());
            }
            let result = unsafe { libc::kill(-group, libc::SIGKILL) };
            if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(ProcessTreeError::StatusProbe {
                    process_id: group as u32,
                    message: std::io::Error::last_os_error().to_string(),
                })
            }
        }
        #[cfg(not(any(windows, unix)))]
        Err(ProcessTreeError::UnsupportedPlatform)
    }

    pub async fn wait_empty(&self, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.is_empty().unwrap_or(false) {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    pub(crate) fn is_empty(&self) -> Result<bool, ProcessTreeError> {
        #[cfg(windows)]
        return job_is_empty(self.job);
        #[cfg(unix)]
        {
            let group = self
                .process_group_id
                .load(std::sync::atomic::Ordering::Acquire);
            if group <= 0 {
                return Ok(true);
            }
            let result = unsafe { libc::kill(-group, 0) };
            Ok(result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH))
        }
        #[cfg(not(any(windows, unix)))]
        Err(ProcessTreeError::UnsupportedPlatform)
    }

    /// Bind a listener PID to this retained OS owner, never to a remembered PID.
    pub(crate) fn contains_process(&self, process_id: u32) -> Result<bool, ProcessTreeError> {
        #[cfg(windows)]
        unsafe {
            use winapi::shared::minwindef::{BOOL, DWORD, FALSE};
            use winapi::um::winnt::HANDLE;
            extern "system" {
                fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
                fn IsProcessInJob(process: HANDLE, job: HANDLE, result: *mut BOOL) -> BOOL;
            }
            let process = OpenProcess(0x1000, FALSE, process_id);
            if process.is_null() {
                return Err(ProcessTreeError::StatusProbe {
                    process_id,
                    message: std::io::Error::last_os_error().to_string(),
                });
            }
            let mut result = FALSE;
            let ok = IsProcessInJob(process, self.job, &mut result);
            let error = std::io::Error::last_os_error();
            winapi::um::handleapi::CloseHandle(process);
            if ok == 0 {
                return Err(ProcessTreeError::StatusProbe {
                    process_id,
                    message: error.to_string(),
                });
            }
            Ok(result != FALSE)
        }
        #[cfg(unix)]
        {
            let group = self
                .process_group_id
                .load(std::sync::atomic::Ordering::Acquire);
            Ok(group > 0 && unsafe { libc::getpgid(process_id as i32) } == group)
        }
        #[cfg(not(any(windows, unix)))]
        Err(ProcessTreeError::UnsupportedPlatform)
    }
}

impl crate::session::SessionProcessOwner for SystemProcessGroupOwner {
    fn terminate(&self) -> Result<(), String> {
        self.terminate_group().map_err(|error| error.to_string())
    }

    fn is_empty(&self) -> Result<bool, String> {
        SystemProcessGroupOwner::is_empty(self).map_err(|error| error.to_string())
    }
}

#[cfg(windows)]
impl Drop for SystemProcessGroupOwner {
    fn drop(&mut self) {
        unsafe {
            winapi::um::handleapi::CloseHandle(self.job);
        }
    }
}

#[cfg(unix)]
impl Drop for SystemProcessGroupOwner {
    fn drop(&mut self) {
        let _ = self.terminate_group();
    }
}

#[cfg(windows)]
fn create_kill_on_close_job() -> Result<winapi::um::winnt::HANDLE, ProcessTreeError> {
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};
    use winapi::shared::minwindef::{BOOL, DWORD, LPVOID};
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECTINFOCLASS,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    extern "system" {
        fn CreateJobObjectW(attributes: LPVOID, name: *const u16) -> winapi::um::winnt::HANDLE;
        fn SetInformationJobObject(
            job: winapi::um::winnt::HANDLE,
            class: JOBOBJECTINFOCLASS,
            info: LPVOID,
            length: DWORD,
        ) -> BOOL;
    }
    unsafe {
        let job = CreateJobObjectW(null_mut(), null());
        if job.is_null() {
            return Err(ProcessTreeError::Spawn {
                process_id: 0,
                message: std::io::Error::last_os_error().to_string(),
            });
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut limits as *mut _ as LPVOID,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
        ) == 0
        {
            let error = std::io::Error::last_os_error();
            winapi::um::handleapi::CloseHandle(job);
            return Err(ProcessTreeError::Spawn {
                process_id: 0,
                message: error.to_string(),
            });
        }
        Ok(job)
    }
}

#[cfg(windows)]
fn assign_process_to_job(
    job: winapi::um::winnt::HANDLE,
    process: winapi::um::winnt::HANDLE,
    process_id: u32,
) -> Result<(), ProcessTreeError> {
    use winapi::shared::minwindef::BOOL;
    extern "system" {
        fn AssignProcessToJobObject(
            job: winapi::um::winnt::HANDLE,
            process: winapi::um::winnt::HANDLE,
        ) -> BOOL;
    }
    if unsafe { AssignProcessToJobObject(job, process) } == 0 {
        return Err(ProcessTreeError::StatusProbe {
            process_id,
            message: format!(
                "AssignProcessToJobObject failed: {}",
                std::io::Error::last_os_error()
            ),
        });
    }
    Ok(())
}

#[cfg(windows)]
fn resume_suspended_process(process_id: u32) -> Result<(), ProcessTreeError> {
    use std::mem::{size_of, zeroed};
    use winapi::shared::minwindef::{BOOL, DWORD, FALSE};
    use winapi::um::winnt::{HANDLE, THREAD_SUSPEND_RESUME};
    const TH32CS_SNAPTHREAD: DWORD = 0x0000_0004;
    const INVALID_HANDLE_VALUE: HANDLE = -1_isize as HANDLE;
    #[repr(C)]
    struct ThreadEntry32 {
        size: DWORD,
        usage: DWORD,
        thread_id: DWORD,
        owner_process_id: DWORD,
        base_priority: i32,
        delta_priority: i32,
        flags: DWORD,
    }
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: DWORD, process_id: DWORD) -> HANDLE;
        fn Thread32First(snapshot: HANDLE, entry: *mut ThreadEntry32) -> BOOL;
        fn Thread32Next(snapshot: HANDLE, entry: *mut ThreadEntry32) -> BOOL;
        fn OpenThread(access: DWORD, inherit: BOOL, thread_id: DWORD) -> HANDLE;
        fn ResumeThread(thread: HANDLE) -> DWORD;
    }
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(ProcessTreeError::StatusProbe {
                process_id,
                message: std::io::Error::last_os_error().to_string(),
            });
        }
        let mut entry: ThreadEntry32 = zeroed();
        entry.size = size_of::<ThreadEntry32>() as DWORD;
        let mut found = false;
        let mut has_entry = Thread32First(snapshot, &mut entry) != 0;
        while has_entry {
            if entry.owner_process_id == process_id {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, FALSE, entry.thread_id);
                if !thread.is_null() {
                    found = ResumeThread(thread) != u32::MAX;
                    winapi::um::handleapi::CloseHandle(thread);
                    if found {
                        break;
                    }
                }
            }
            has_entry = Thread32Next(snapshot, &mut entry) != 0;
        }
        winapi::um::handleapi::CloseHandle(snapshot);
        if !found {
            return Err(ProcessTreeError::StatusProbe {
                process_id,
                message: "failed to resume the suspended primary thread".to_string(),
            });
        }
    }
    Ok(())
}

#[cfg(windows)]
fn terminate_job(job: winapi::um::winnt::HANDLE) -> Result<(), ProcessTreeError> {
    use winapi::shared::minwindef::{BOOL, UINT};
    extern "system" {
        fn TerminateJobObject(job: winapi::um::winnt::HANDLE, exit_code: UINT) -> BOOL;
    }
    if unsafe { TerminateJobObject(job, 1) } == 0 {
        return Err(ProcessTreeError::StatusProbe {
            process_id: 0,
            message: std::io::Error::last_os_error().to_string(),
        });
    }
    Ok(())
}

#[cfg(windows)]
fn job_is_empty(job: winapi::um::winnt::HANDLE) -> Result<bool, ProcessTreeError> {
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;
    use winapi::shared::minwindef::{BOOL, DWORD, LPVOID};
    use winapi::um::winnt::{
        JobObjectBasicAccountingInformation, JOBOBJECTINFOCLASS,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    };
    extern "system" {
        fn QueryInformationJobObject(
            job: winapi::um::winnt::HANDLE,
            class: JOBOBJECTINFOCLASS,
            info: LPVOID,
            length: DWORD,
            returned: *mut DWORD,
        ) -> BOOL;
    }
    unsafe {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
        if QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &mut accounting as *mut _ as LPVOID,
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as DWORD,
            null_mut(),
        ) == 0
        {
            return Err(ProcessTreeError::StatusProbe {
                process_id: 0,
                message: std::io::Error::last_os_error().to_string(),
            });
        }
        Ok(accounting.ActiveProcesses == 0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessTreeStopOutcome {
    Terminated,
    AlreadyExited,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessTreeStop {
    pub process_id: u32,
    pub outcome: ProcessTreeStopOutcome,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProcessTreeError {
    #[error("process id must be non-zero")]
    InvalidProcessId,
    #[error("process-tree termination is unsupported on this platform")]
    UnsupportedPlatform,
    #[error("failed to inspect process {process_id}: {message}")]
    StatusProbe { process_id: u32, message: String },
    #[error("failed to start taskkill for process {process_id}: {message}")]
    Spawn { process_id: u32, message: String },
    #[error("taskkill timed out for process {0}")]
    Timeout(u32),
    #[error("taskkill failed for process {process_id} with exit code {exit_code:?}: {diagnostic}")]
    CommandFailed {
        process_id: u32,
        exit_code: Option<i32>,
        diagnostic: String,
    },
    #[error("process tree {0} is still running after the termination request")]
    StillRunning(u32),
}

#[async_trait]
pub trait ProcessTreeTerminator: Send + Sync {
    async fn terminate_tree(&self, process_id: u32) -> Result<ProcessTreeStop, ProcessTreeError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemProcessTreeTerminator;

#[async_trait]
impl ProcessTreeTerminator for SystemProcessTreeTerminator {
    async fn terminate_tree(&self, process_id: u32) -> Result<ProcessTreeStop, ProcessTreeError> {
        if process_id == 0 {
            return Err(ProcessTreeError::InvalidProcessId);
        }
        terminate_tree_platform(process_id).await
    }
}

#[cfg(windows)]
async fn terminate_tree_platform(process_id: u32) -> Result<ProcessTreeStop, ProcessTreeError> {
    let Some(process) = WindowsProcessProbe::open(process_id)? else {
        return Ok(ProcessTreeStop {
            process_id,
            outcome: ProcessTreeStopOutcome::AlreadyExited,
        });
    };
    if !process.is_running()? {
        return Ok(ProcessTreeStop {
            process_id,
            outcome: ProcessTreeStopOutcome::AlreadyExited,
        });
    }

    let mut command = tokio::process::Command::new("taskkill.exe");
    command
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .set_no_window();
    let output = tokio::time::timeout(TASKKILL_TIMEOUT, command.output())
        .await
        .map_err(|_| ProcessTreeError::Timeout(process_id))?
        .map_err(|error| ProcessTreeError::Spawn {
            process_id,
            message: bounded_text(&error.to_string()),
        })?;

    if !output.status.success() {
        if !process.is_running()? {
            return Ok(ProcessTreeStop {
                process_id,
                outcome: ProcessTreeStopOutcome::AlreadyExited,
            });
        }
        return Err(ProcessTreeError::CommandFailed {
            process_id,
            exit_code: output.status.code(),
            diagnostic: bounded_output(&output.stdout, &output.stderr),
        });
    }

    for _ in 0..CONFIRM_ATTEMPTS {
        if !process.is_running()? {
            return Ok(ProcessTreeStop {
                process_id,
                outcome: ProcessTreeStopOutcome::Terminated,
            });
        }
        tokio::time::sleep(CONFIRM_INTERVAL).await;
    }
    Err(ProcessTreeError::StillRunning(process_id))
}

#[cfg(not(windows))]
async fn terminate_tree_platform(_process_id: u32) -> Result<ProcessTreeStop, ProcessTreeError> {
    Err(ProcessTreeError::UnsupportedPlatform)
}

#[cfg(windows)]
struct WindowsProcessProbe {
    process_id: u32,
    handle: winapi::um::winnt::HANDLE,
}

#[cfg(windows)]
// SAFETY: Windows kernel process handles are valid across threads. This wrapper owns the handle,
// exposes no borrowed pointer, and closes it exactly once in Drop after the async operation ends.
unsafe impl Send for WindowsProcessProbe {}

#[cfg(windows)]
impl WindowsProcessProbe {
    fn open(process_id: u32) -> Result<Option<Self>, ProcessTreeError> {
        use winapi::shared::winerror::ERROR_INVALID_PARAMETER;
        use winapi::um::errhandlingapi::GetLastError;
        use winapi::um::processthreadsapi::OpenProcess;
        use winapi::um::winnt::{PROCESS_QUERY_LIMITED_INFORMATION, SYNCHRONIZE};

        unsafe {
            let handle = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                0,
                process_id,
            );
            if handle.is_null() {
                let error = GetLastError();
                if error == ERROR_INVALID_PARAMETER {
                    return Ok(None);
                }
                return Err(ProcessTreeError::StatusProbe {
                    process_id,
                    message: format!("OpenProcess failed with Windows error {error}"),
                });
            }
            Ok(Some(Self { process_id, handle }))
        }
    }

    fn is_running(&self) -> Result<bool, ProcessTreeError> {
        use winapi::um::errhandlingapi::GetLastError;
        use winapi::um::minwinbase::STILL_ACTIVE;
        use winapi::um::processthreadsapi::GetExitCodeProcess;

        unsafe {
            let mut exit_code = 0_u32;
            let result = GetExitCodeProcess(self.handle, &mut exit_code);
            if result == 0 {
                let error = GetLastError();
                return Err(ProcessTreeError::StatusProbe {
                    process_id: self.process_id,
                    message: format!("GetExitCodeProcess failed with Windows error {error}"),
                });
            }
            Ok(exit_code == STILL_ACTIVE)
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsProcessProbe {
    fn drop(&mut self) {
        use winapi::um::handleapi::CloseHandle;

        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
fn bounded_output(stdout: &[u8], stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    let combined = if stderr.trim().is_empty() {
        stdout.into_owned()
    } else if stdout.trim().is_empty() {
        stderr.into_owned()
    } else {
        format!("{} | {}", stderr.trim(), stdout.trim())
    };
    bounded_text(&combined)
}

#[cfg(windows)]
fn bounded_text(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(MAX_DIAGNOSTIC_CHARS).collect()
}
