//! macOS descriptor operations. Callers retain ownership of authorization and lifecycle state.
use super::{unix_entry_identity_at, unix_name};
use anyhow::{bail, Context, Result};
use std::ffi::{CStr, OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

#[path = "macos_reference.rs"]
mod reference;
pub(crate) use reference::DirectoryReference;

#[derive(Debug)]
pub(crate) struct CreatedDirectory {
    pub(crate) file: File,
    pub(crate) reference: DirectoryReference,
}

#[derive(Debug, thiserror::Error)]
#[error("workspace directory creation permission denied")]
pub(crate) struct DirectoryCreationPermissionDenied;

pub(crate) fn object_id(file: &File) -> io::Result<(u64, u64)> {
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

pub(crate) fn final_path(file: &File) -> Result<PathBuf> {
    let mut buffer = vec![0 as libc::c_char; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error()).context("failed to resolve held workspace path");
    }
    let bytes = unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_bytes();
    Ok(PathBuf::from(OsString::from_vec(bytes.to_vec())))
}

pub(crate) fn open_directory_at(parent: &File, name: &OsStr) -> Result<File> {
    super::ensure_single_component(name)?;
    let name = unix_name(name)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd == -1 {
        return Err(io::Error::last_os_error()).context("failed to open workspace directory");
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub(crate) fn open_file_at(parent: &File, name: &OsStr) -> Result<File> {
    super::ensure_single_component(name)?;
    let encoded = unix_name(name)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            encoded.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd == -1 {
        return Err(io::Error::last_os_error()).context("failed to open workspace file");
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub(crate) fn validate_entry(parent: &File, name: &OsStr, file: &File) -> Result<()> {
    if unix_entry_identity_at(parent, name)? != object_id(file)? {
        bail!("workspace file binding changed");
    }
    Ok(())
}

pub(crate) fn open_directory_chain(path: &Path) -> Result<Vec<File>> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        bail!("workspace path must be absolute and contain no parent components");
    }
    let mut handles = vec![OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")?];
    for component in path.components() {
        if let Component::Normal(name) = component {
            handles.push(open_directory_at(
                handles.last().expect("root exists"),
                name,
            )?);
        }
    }
    validate_directory_chain(path, &handles)?;
    Ok(handles)
}

pub(crate) fn validate_directory_chain(path: &Path, handles: &[File]) -> Result<()> {
    let names: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect();
    if handles.len() != names.len() + 1 {
        bail!("workspace descriptor chain length changed");
    }
    for (index, name) in names.iter().enumerate() {
        if unix_entry_identity_at(&handles[index], name)? != object_id(&handles[index + 1])? {
            bail!("workspace directory binding changed");
        }
    }
    Ok(())
}

pub(crate) fn create_directory_at(parent: &File, name: &OsStr) -> Result<CreatedDirectory> {
    create_directory_with_hook(parent, name, || Ok(()))
}

fn create_directory_with_hook(
    parent: &File,
    name: &OsStr,
    after_create: impl FnOnce() -> Result<()>,
) -> Result<CreatedDirectory> {
    unix_name(name)?;
    let created = DirectoryReference::from_directory(parent)?.create_child(name)?;
    let result = (|| {
        after_create()?;
        let handle = open_directory_at(parent, name)?;
        if !created.matches(&DirectoryReference::from_directory(&handle)?) {
            bail!("created workspace directory was replaced");
        }
        if unsafe { libc::fchmod(handle.as_raw_fd(), 0o700) } != 0 {
            return Err(io::Error::last_os_error())
                .context("failed to set workspace directory permissions");
        }
        Ok(handle)
    })();
    if let Err(error) = &result {
        created
            .remove_empty()
            .with_context(|| format!("{error}; created directory rollback failed"))?;
    }
    result.map(|file| CreatedDirectory {
        file,
        reference: created,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollback_uses_the_held_object_and_preserves_nonempty_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let chain = open_directory_chain(&root).unwrap();
        let directory = create_directory_at(chain.last().unwrap(), OsStr::new("original")).unwrap();
        let original = root.join("original");
        let moved = root.join("moved");
        std::fs::rename(&original, &moved).unwrap();
        std::fs::create_dir(&original).unwrap();
        std::fs::write(original.join("replacement.txt"), "replacement").unwrap();
        std::fs::write(moved.join("owned.txt"), "keep").unwrap();
        let cwd = std::env::current_dir().unwrap();
        assert!(directory.reference.remove_empty().is_err());
        assert_eq!(
            std::fs::read_to_string(moved.join("owned.txt")).unwrap(),
            "keep"
        );
        std::fs::remove_file(moved.join("owned.txt")).unwrap();
        directory.reference.remove_empty().unwrap();
        assert!(!moved.exists());
        assert_eq!(
            std::fs::read_to_string(original.join("replacement.txt")).unwrap(),
            "replacement"
        );
        assert_eq!(std::env::current_dir().unwrap(), cwd);
    }

    #[test]
    fn rollback_keeps_replacement_when_created_object_was_unlinked() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let chain = open_directory_chain(&root).unwrap();
        let created = create_directory_at(chain.last().unwrap(), OsStr::new("created")).unwrap();
        let path = root.join("created");
        std::fs::remove_dir(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        // Keep the replacement empty so an incorrect path-based delete would actually remove it.
        created.reference.remove_empty().unwrap();
        assert!(path.is_dir());
        assert_ne!(
            object_id(&created.file).unwrap().1,
            path.metadata().unwrap().ino()
        );
    }

    #[test]
    fn creation_rejects_a_replacement_before_descriptor_capture() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let chain = open_directory_chain(&root).unwrap();
        let original = root.join("original");
        let moved = root.join("moved");
        let result =
            create_directory_with_hook(chain.last().unwrap(), OsStr::new("original"), || {
                std::fs::rename(&original, &moved)?;
                std::fs::create_dir(&original)?;
                std::fs::write(original.join("foreign.txt"), "preserve")?;
                Ok(())
            });
        assert!(result.unwrap_err().to_string().contains("replaced"));
        assert!(!moved.exists());
        assert_eq!(
            std::fs::read_to_string(original.join("foreign.txt")).unwrap(),
            "preserve"
        );
    }

    #[test]
    fn post_creation_permission_failure_is_rolled_back_without_retry_classification() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let chain = open_directory_chain(&root).unwrap();
        let error =
            create_directory_with_hook(chain.last().unwrap(), OsStr::new("created"), || {
                Err(io::Error::from_raw_os_error(libc::EACCES).into())
            })
            .unwrap_err();
        assert!(!error.is::<DirectoryCreationPermissionDenied>());
        assert!(!root.join("created").exists());
    }
}
