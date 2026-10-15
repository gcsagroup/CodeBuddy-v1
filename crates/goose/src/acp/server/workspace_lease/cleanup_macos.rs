//! Read-only cleanup preparation. This module never creates authority or mutates a target.
//! Passing inspection is not permission to rename/unlink by path on POSIX.
use super::normalize_identity;
use crate::secure_fs::macos::{
    final_path, open_directory_chain, open_file_at, validate_directory_chain, validate_entry,
};
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{File, Metadata};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

include!("cleanup_policy.rs");

#[cfg(test)]
thread_local! {
    pub(super) static TEST_REGISTERED_PROJECT_IDENTITIES: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
}

fn normalize_registered_project_path(path: &str) -> Result<String> {
    let identity = normalize_identity(Path::new(path))?;
    if identity == "/" {
        bail!("registered project cannot be a filesystem root");
    }
    Ok(identity)
}

#[derive(Debug, PartialEq, Eq)]
struct TargetVersion {
    device: u64,
    inode: u64,
    bytes: u64,
    links: u64,
    modified: (i64, i64),
    changed: (i64, i64),
    mode: u32,
}
impl From<&Metadata> for TargetVersion {
    fn from(m: &Metadata) -> Self {
        Self {
            device: m.dev(),
            inode: m.ino(),
            bytes: m.len(),
            links: m.nlink(),
            modified: (m.mtime(), m.mtime_nsec()),
            changed: (m.ctime(), m.ctime_nsec()),
            mode: m.mode(),
        }
    }
}

pub(super) struct Inspection {
    root: PathBuf,
    path: PathBuf,
    parents: Vec<File>,
    file: File,
    version: TargetVersion,
    pub(super) summary: RootCleanupTargetSummary,
}

// Registry access fails closed; callers cannot substitute an empty project list.
pub(super) fn inspect(root: &Path, target: &Path) -> Result<Inspection> {
    inspect_with_projects(
        root,
        target,
        &registered_project_identities_for_cleanup()?,
        || Ok(()),
    )
}

fn inspect_with_projects(
    root: &Path,
    target: &Path,
    projects: &[String],
    after_read: impl FnOnce() -> Result<()>,
) -> Result<Inspection> {
    super::validate_root_container_path(root)?;
    normalize_identity(target)?;
    if target == root {
        bail!("cleanup target must be below the confirmed root");
    }
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("cleanup target has no parent"))?;
    let name = target
        .file_name()
        .ok_or_else(|| anyhow!("cleanup target has no leaf"))?;
    ensure_cleanup_allowlisted(root, target)?;
    let parents = open_directory_chain(parent)?;
    let file = open_file_at(parents.last().expect("root exists"), name)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() && !metadata.is_dir() {
        bail!("cleanup target must be a regular file or empty directory");
    }
    if metadata.is_file() && metadata.nlink() != 1 {
        bail!("cleanup refuses files with multiple hard links");
    }
    reject_cleanup_project_overlap(root, target, projects)?;
    let summary = summarize(root, target, &file, &metadata)?;
    let inspection = Inspection {
        root: root.into(),
        path: target.into(),
        parents,
        file,
        version: TargetVersion::from(&metadata),
        summary,
    };
    after_read()?;
    inspection.validate_binding()?;
    reject_cleanup_project_overlap(root, target, projects)?;
    inspection.validate_binding()?;
    Ok(inspection)
}

impl Inspection {
    fn validate_binding(&self) -> Result<()> {
        let parent = self.path.parent().expect("inspected parent");
        validate_directory_chain(parent, &self.parents)?;
        validate_entry(
            self.parents.last().expect("root exists"),
            self.path.file_name().expect("inspected leaf"),
            &self.file,
        )?;
        if final_path(&self.file)? != self.path
            || TargetVersion::from(&self.file.metadata()?) != self.version
        {
            bail!("cleanup target changed during or after inspection");
        }
        Ok(())
    }

    pub(super) fn revalidate(&self) -> Result<()> {
        self.revalidate_with_projects(&registered_project_identities_for_cleanup()?)
    }

    fn revalidate_with_projects(&self, projects: &[String]) -> Result<()> {
        self.validate_binding()?;
        reject_cleanup_project_overlap(&self.root, &self.path, projects)?;
        let current = summarize(&self.root, &self.path, &self.file, &self.file.metadata()?)?;
        self.validate_binding()?;
        if current.hash != self.summary.hash || current.target_type != self.summary.target_type {
            bail!("cleanup target contents changed after inspection");
        }
        Ok(())
    }
}

fn summarize(
    root: &Path,
    path: &Path,
    file: &File,
    before: &Metadata,
) -> Result<RootCleanupTargetSummary> {
    let hash = if before.is_dir() {
        ensure_empty_directory(file)?;
        None
    } else {
        let mut hasher = blake3::Hasher::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut offset = 0u64;
        // Bound reading by the inspected size: a concurrent writer cannot extend this loop.
        while offset < before.len() {
            let count = (before.len() - offset).min(buffer.len() as u64) as usize;
            let read = file.read_at(&mut buffer[..count], offset)?;
            if read == 0 {
                bail!("cleanup file shrank during inspection");
            }
            hasher.update(&buffer[..read]);
            offset += read as u64;
        }
        Some(hasher.finalize().to_hex().to_string())
    };
    if TargetVersion::from(before) != TargetVersion::from(&file.metadata()?) {
        bail!("cleanup target changed during inspection");
    }
    Ok(RootCleanupTargetSummary {
        relative_path: path
            .strip_prefix(root)?
            .to_str()
            .ok_or_else(|| anyhow!("cleanup path is not Unicode"))?
            .into(),
        target_type: if before.is_dir() {
            "empty-directory"
        } else {
            "file"
        },
        bytes: if before.is_dir() { 0 } else { before.len() },
        modified_millis: before
            .modified()?
            .duration_since(SystemTime::UNIX_EPOCH)
            .context("cleanup modification time predates the Unix epoch")?
            .as_millis(),
        hash,
    })
}

fn ensure_empty_directory(file: &File) -> Result<()> {
    // Open a fresh stream relative to the held object, not its replaceable pathname.
    let fd = unsafe {
        libc::openat(
            file.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error()).context("failed to inspect cleanup directory");
    }
    let duplicate = unsafe { File::from_raw_fd(fd) };
    let stream = unsafe { libc::fdopendir(duplicate.as_raw_fd()) };
    if stream.is_null() {
        return Err(std::io::Error::last_os_error())
            .context("failed to open cleanup directory stream");
    }
    std::mem::forget(duplicate); // fdopendir owns this descriptor after success.
    struct Stream(*mut libc::DIR);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let stream = Stream(stream);
    loop {
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(0) {
                return Err(error).context("failed to read cleanup directory");
            }
            return Ok(());
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            bail!("non-empty directories require a narrower exact cleanup target");
        }
    }
}

#[cfg(test)]
#[path = "cleanup_macos_tests.rs"]
mod tests;
