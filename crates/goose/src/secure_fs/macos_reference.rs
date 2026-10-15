//! Directory object references bridge the missing POSIX delete-by-descriptor operation.
//! CoreServices FSRef APIs are deprecated; keep them confined to directory creation/rollback.
//! Capture from a held directory in a fresh thread, never from an untrusted absolute path or
//! a truncated catalog node ID. The thread-local cwd disappears when that thread exits.
use anyhow::{anyhow, bail, Context, Result};
use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::os::fd::AsRawFd;

#[repr(C)]
#[derive(Debug)]
pub(crate) struct DirectoryReference([u8; 80]);

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn FSPathMakeRefWithOptions(
        path: *const u8,
        options: u32,
        reference: *mut DirectoryReference,
        is_directory: *mut u8,
    ) -> i32;
    fn FSDeleteObject(reference: *const DirectoryReference) -> i16;
    fn FSCompareFSRefs(left: *const DirectoryReference, right: *const DirectoryReference) -> i16;
    fn FSCreateDirectoryUnicode(
        parent: *const DirectoryReference,
        name_length: u32,
        name: *const u16,
        which_info: u32,
        catalog_info: *const c_void,
        created: *mut DirectoryReference,
        new_spec: *mut c_void,
        new_directory_id: *mut u32,
    ) -> i16;
}

unsafe extern "C" {
    fn pthread_fchdir_np(fd: libc::c_int) -> libc::c_int;
}

impl DirectoryReference {
    pub(super) fn from_directory(directory: &File) -> Result<Self> {
        if !directory.metadata()?.is_dir() {
            bail!("object reference requires a directory descriptor");
        }
        std::thread::scope(|scope| {
            std::thread::Builder::new()
                .name("workspace-reference".into())
                .spawn_scoped(scope, || {
                    if unsafe { pthread_fchdir_np(directory.as_raw_fd()) } != 0 {
                        return Err(std::io::Error::last_os_error())
                            .context("failed to bind directory reference thread");
                    }
                    let mut reference = Self([0; 80]);
                    let mut is_directory = 0;
                    let status = unsafe {
                        FSPathMakeRefWithOptions(
                            c".".as_ptr().cast(),
                            1,
                            &mut reference,
                            &mut is_directory,
                        )
                    };
                    if status != 0 || is_directory == 0 {
                        bail!("failed to capture held directory reference (OSStatus {status})");
                    }
                    Ok(reference)
                })?
                .join()
                .map_err(|_| anyhow!("directory reference thread failed"))?
        })
    }

    pub(super) fn create_child(&self, name: &OsStr) -> Result<Self> {
        super::super::ensure_single_component(name)?;
        let name: Vec<u16> = name
            .to_str()
            .ok_or_else(|| anyhow!("workspace name is not Unicode"))?
            .encode_utf16()
            .collect();
        let mut reference = Self([0; 80]);
        let status = unsafe {
            FSCreateDirectoryUnicode(
                self,
                name.len().try_into()?,
                name.as_ptr(),
                0,
                std::ptr::null(),
                &mut reference,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            // afpAccessDenied: creation was rejected, so no child needs rollback.
            if status == -5000 {
                return Err(super::DirectoryCreationPermissionDenied.into());
            }
            bail!("failed to create workspace directory (OSErr {status})");
        }
        Ok(reference)
    }

    pub(super) fn matches(&self, other: &Self) -> bool {
        unsafe { FSCompareFSRefs(self, other) == 0 }
    }

    pub(crate) fn remove_empty(&self) -> Result<()> {
        let status = unsafe { FSDeleteObject(self) };
        // fnfErr means the exact created object has already gone. Never look up its old name.
        if status != 0 && status != -43 {
            bail!("failed to rollback exact empty workspace directory (OSErr {status}); directory preserved");
        }
        Ok(())
    }
}
