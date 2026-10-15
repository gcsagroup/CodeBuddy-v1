//! Handle-backed filesystem primitives extracted from onboarding.
//!
//! Existing caller policies still apply. In particular, Unix onboarding mutations remain
//! disabled, and Windows file creation retains its original path-based semantics.

#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(windows)]
pub(crate) mod windows;

use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use winapi::um::fileapi::{
    GetFinalPathNameByHandleW, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
};
#[cfg(windows)]
use winapi::um::minwinbase::FileDispositionInfo;
#[cfg(windows)]
use winapi::um::winnt::{DELETE, FILE_READ_ATTRIBUTES, GENERIC_WRITE};

pub(crate) struct SecureDirectory {
    path: PathBuf,
    handle: Option<File>,
    owned: bool,
    #[cfg(unix)]
    bindings: Vec<DirectoryBinding>,
}

#[cfg(unix)]
struct DirectoryBinding {
    parent: File,
    name: OsString,
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn unix_entry_identity_at(parent: &File, name: &OsStr) -> io::Result<(u64, u64)> {
    use std::mem::MaybeUninit;
    use std::os::fd::AsRawFd;

    let name = unix_name(name).map_err(io::Error::other)?;
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok((stat.st_dev as u64, stat.st_ino as u64))
}

#[cfg(unix)]
fn unix_entry_matches(parent: &File, name: &OsStr, device: u64, inode: u64) -> bool {
    unix_entry_identity_at(parent, name)
        .map(|current| current == (device, inode))
        .unwrap_or(false)
}

impl SecureDirectory {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(all(windows, test))]
    pub(crate) fn handle_for_test(&self) -> Option<&File> {
        self.handle.as_ref()
    }

    #[cfg(all(windows, test))]
    pub(crate) fn owned_for_test(&self) -> bool {
        self.owned
    }

    #[cfg(windows)]
    pub(crate) fn open_config(path: &Path) -> anyhow::Result<Self> {
        Self::open_windows(path, false)
    }

    #[cfg(unix)]
    pub(crate) fn open_config(path: &Path) -> anyhow::Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;

        let parent_path = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("target configuration directory has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("target configuration directory has no name"))?;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let parent = options.open(parent_path)?;
        Self::open_unix_at(&parent, name, path.to_path_buf(), false, Vec::new(), None)
    }

    #[cfg(windows)]
    fn open_windows(path: &Path, owned: bool) -> anyhow::Result<Self> {
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;

        let mut options = OpenOptions::new();
        let access = FILE_READ_ATTRIBUTES | if owned { DELETE } else { 0 };
        options
            .access_mode(access)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        let handle = options.open(path)?;
        Self::from_windows_handle(path, handle, owned)
    }

    #[cfg(windows)]
    fn from_windows_handle(path: &Path, handle: File, owned: bool) -> anyhow::Result<Self> {
        if let Err(error) = ensure_open_directory_identity(&handle, path) {
            if owned && mark_handle_for_deletion(&handle).is_err() {
                anyhow::bail!("skill installation failed and rollback did not complete");
            }
            return Err(error);
        }
        Ok(Self {
            path: path.to_path_buf(),
            handle: Some(handle),
            owned,
        })
    }

    #[cfg(unix)]
    fn open_unix_at(
        parent: &File,
        name: &OsStr,
        path: PathBuf,
        owned: bool,
        mut bindings: Vec<DirectoryBinding>,
        expected_created_identity: Option<(u64, u64)>,
    ) -> anyhow::Result<Self> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::MetadataExt;

        let name_c = unix_name(name)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let handle = unsafe { File::from_raw_fd(fd) };
        let metadata = handle.metadata()?;
        anyhow::ensure!(metadata.is_dir(), "target skill directory is not direct");
        if let Some((device, inode)) = expected_created_identity {
            anyhow::ensure!(
                metadata.dev() == device && metadata.ino() == inode,
                "created skill directory identity changed before it could be secured"
            );
        }
        bindings.push(DirectoryBinding {
            parent: parent.try_clone()?,
            name: name.to_os_string(),
            device: metadata.dev(),
            inode: metadata.ino(),
        });
        let directory = Self {
            path,
            handle: Some(handle),
            owned,
            bindings,
        };
        directory.ensure_bound()?;
        Ok(directory)
    }

    pub(crate) fn create_child(&self, name: &OsStr) -> anyhow::Result<(Self, bool)> {
        self.create_child_with_hook(name, |_| Ok(()))
    }

    pub(crate) fn create_child_with_hook<AfterCreate>(
        &self,
        name: &OsStr,
        after_create: AfterCreate,
    ) -> anyhow::Result<(Self, bool)>
    where
        AfterCreate: FnOnce(&Path) -> anyhow::Result<()>,
    {
        ensure_single_component(name)?;
        self.ensure_bound()?;
        let child_path = self.path.join(name);

        #[cfg(windows)]
        {
            let parent = self
                .handle
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("secure directory handle is unavailable"))?;
            let (mut directory, created) = match windows::try_create_child_directory(parent, name)?
            {
                Some(handle) => (Self::from_windows_handle(&child_path, handle, true)?, true),
                None => (
                    Self::from_windows_handle(
                        &child_path,
                        windows::open_child_directory(parent, name)?,
                        false,
                    )?,
                    false,
                ),
            };
            let secured = (|| -> anyhow::Result<()> {
                if created {
                    after_create(&child_path)?;
                }
                directory.ensure_bound()
            })();
            if let Err(error) = secured {
                let cleanup_result = directory.remove_owned();
                if cleanup_result.is_err() {
                    anyhow::bail!("skill installation failed and rollback did not complete");
                }
                return Err(error);
            }
            Ok((directory, created))
        }

        #[cfg(unix)]
        {
            let created = {
                use std::os::fd::AsRawFd;
                let name_c = unix_name(name)?;
                let result = unsafe {
                    libc::mkdirat(
                        self.handle
                            .as_ref()
                            .ok_or_else(|| {
                                anyhow::anyhow!("secure directory handle is unavailable")
                            })?
                            .as_raw_fd(),
                        name_c.as_ptr(),
                        0o777,
                    )
                };
                if result == 0 {
                    true
                } else {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::AlreadyExists {
                        false
                    } else {
                        return Err(error.into());
                    }
                }
            };

            let created_identity = if created {
                Some(unix_entry_identity_at(
                    self.handle
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("secure directory handle is unavailable"))?,
                    name,
                )?)
            } else {
                None
            };

            let opened = (|| -> anyhow::Result<Self> {
                if created {
                    after_create(&child_path)?;
                }
                Self::open_unix_at(
                    self.handle
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("secure directory handle is unavailable"))?,
                    name,
                    child_path.clone(),
                    created,
                    self.clone_bindings()?,
                    created_identity,
                )
            })();
            match opened {
                Ok(directory) => Ok((directory, created)),
                Err(error) => {
                    let cleanup_result = if created {
                        self.remove_unopened_child(
                            name,
                            created_identity.ok_or_else(|| {
                                anyhow::anyhow!("created directory identity is unavailable")
                            })?,
                        )
                    } else {
                        Ok(())
                    };
                    if cleanup_result.is_err() {
                        anyhow::bail!("skill installation failed and rollback did not complete");
                    }
                    Err(error)
                }
            }
        }
    }

    #[cfg(unix)]
    fn clone_bindings(&self) -> io::Result<Vec<DirectoryBinding>> {
        self.bindings
            .iter()
            .map(|binding| {
                Ok(DirectoryBinding {
                    parent: binding.parent.try_clone()?,
                    name: binding.name.clone(),
                    device: binding.device,
                    inode: binding.inode,
                })
            })
            .collect()
    }

    #[cfg(unix)]
    fn remove_unopened_child(&self, name: &OsStr, expected_identity: (u64, u64)) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let handle = self
            .handle
            .as_ref()
            .ok_or_else(|| io::Error::other("secure directory handle is unavailable"))?;
        if !unix_entry_matches(handle, name, expected_identity.0, expected_identity.1) {
            return Err(io::Error::other(
                "created skill directory identity changed before cleanup",
            ));
        }
        let name = unix_name(name).map_err(io::Error::other)?;
        let result =
            unsafe { libc::unlinkat(handle.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    #[cfg(windows)]
    pub(crate) fn ensure_bound(&self) -> anyhow::Result<()> {
        ensure_open_directory_identity(
            self.handle
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("secure directory handle is unavailable"))?,
            &self.path,
        )
    }

    #[cfg(unix)]
    pub(crate) fn ensure_bound(&self) -> anyhow::Result<()> {
        use std::mem::MaybeUninit;
        use std::os::fd::AsRawFd;

        for binding in &self.bindings {
            let name = unix_name(&binding.name)?;
            let mut stat = MaybeUninit::<libc::stat>::uninit();
            let result = unsafe {
                libc::fstatat(
                    binding.parent.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result != 0 {
                anyhow::bail!("target skill directory identity changed during installation");
            }
            let stat = unsafe { stat.assume_init() };
            anyhow::ensure!(
                stat.st_dev as u64 == binding.device && stat.st_ino as u64 == binding.inode,
                "target skill directory identity changed during installation"
            );
        }
        Ok(())
    }

    pub(crate) fn remove_owned(&mut self) -> io::Result<()> {
        if !self.owned {
            self.handle.take();
            return Ok(());
        }

        #[cfg(windows)]
        {
            let result = mark_handle_for_deletion(
                self.handle
                    .as_ref()
                    .ok_or_else(|| io::Error::other("secure directory handle is unavailable"))?,
            );
            self.handle.take();
            result
        }

        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let binding = self
                .bindings
                .last()
                .ok_or_else(|| io::Error::other("secure directory binding is unavailable"))?;
            if !unix_entry_matches(
                &binding.parent,
                &binding.name,
                binding.device,
                binding.inode,
            ) {
                return Err(io::Error::other(
                    "created skill directory identity changed before rollback",
                ));
            }
            let name = unix_name(&binding.name).map_err(io::Error::other)?;
            let result = unsafe {
                libc::unlinkat(
                    binding.parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::AT_REMOVEDIR,
                )
            };
            self.handle.take();
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }
}

pub(crate) struct SecureFile {
    handle: Option<File>,
    #[cfg(unix)]
    parent: File,
    #[cfg(unix)]
    name: OsString,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl SecureFile {
    pub(crate) fn create(parent: &SecureDirectory, name: &OsStr) -> anyhow::Result<Self> {
        ensure_single_component(name)?;
        parent.ensure_bound()?;

        #[cfg(windows)]
        {
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            const FILE_SHARE_READ: u32 = 0x0000_0001;
            const FILE_SHARE_WRITE: u32 = 0x0000_0002;
            let mut options = OpenOptions::new();
            options
                .write(true)
                .access_mode(GENERIC_WRITE | DELETE)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .create_new(true);
            let handle = options.open(parent.path.join(name))?;
            Ok(Self {
                handle: Some(handle),
            })
        }

        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            use std::os::unix::fs::MetadataExt;
            let parent_handle = parent
                .handle
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("secure directory handle is unavailable"))?;
            let name_c = unix_name(name)?;
            let fd = unsafe {
                libc::openat(
                    parent_handle.as_raw_fd(),
                    name_c.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_CLOEXEC
                        | libc::O_NOFOLLOW,
                    0o666,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error().into());
            }
            let handle = unsafe { File::from_raw_fd(fd) };
            let metadata = handle.metadata()?;
            Ok(Self {
                handle: Some(handle),
                parent: parent_handle.try_clone()?,
                name: name.to_os_string(),
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
    }

    pub(crate) fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.handle
            .as_mut()
            .ok_or_else(|| io::Error::other("secure file handle is unavailable"))?
            .write_all(bytes)
    }

    pub(crate) fn remove_owned(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            let result = mark_handle_for_deletion(
                self.handle
                    .as_ref()
                    .ok_or_else(|| io::Error::other("secure file handle is unavailable"))?,
            );
            self.handle.take();
            result
        }

        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if !unix_entry_matches(&self.parent, &self.name, self.device, self.inode) {
                return Err(io::Error::other(
                    "created skill file identity changed before rollback",
                ));
            }
            let name = unix_name(&self.name).map_err(io::Error::other)?;
            let result = unsafe { libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), 0) };
            self.handle.take();
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }
}

fn ensure_single_component(name: &OsStr) -> anyhow::Result<()> {
    let path = Path::new(name);
    let mut components = path.components();
    anyhow::ensure!(
        matches!(components.next(), Some(std::path::Component::Normal(_)))
            && components.next().is_none(),
        "authorized skill path component is not direct"
    );
    Ok(())
}

#[cfg(unix)]
fn unix_name(name: &OsStr) -> anyhow::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    Ok(std::ffi::CString::new(name.as_bytes())?)
}

#[cfg(windows)]
fn mark_handle_for_deletion(handle: &File) -> io::Result<()> {
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
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn ensure_open_directory_identity(handle: &File, path: &Path) -> anyhow::Result<()> {
    let opened = handle.metadata()?;
    anyhow::ensure!(
        opened.is_dir() && !metadata_is_link_or_reparse_point(&opened),
        "target skills root is not a direct directory"
    );

    let current = fs::symlink_metadata(path)?;
    anyhow::ensure!(
        current.file_type().is_dir() && !metadata_is_link_or_reparse_point(&current),
        "target skills root identity changed during installation"
    );
    let current_path = path.canonicalize()?;
    let opened_path = opened_file_path(handle, path)?;
    anyhow::ensure!(
        paths_equal_for_security(&opened_path, &current_path),
        "target skills root identity changed during installation"
    );
    Ok(())
}

#[cfg(unix)]
pub(crate) fn metadata_is_link_or_reparse_point(_: &std::fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
pub(crate) fn metadata_is_link_or_reparse_point(metadata: &std::fs::Metadata) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(unix)]
pub(crate) fn opened_file_path(file: &File, path: &Path) -> io::Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let opened_metadata = file.metadata()?;
    let canonical = path.canonicalize()?;
    let path_metadata = fs::metadata(&canonical)?;
    if opened_metadata.dev() != path_metadata.dev() || opened_metadata.ino() != path_metadata.ino()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened onboarding import file identity changed",
        ));
    }
    Ok(canonical)
}

#[cfg(windows)]
pub(crate) fn opened_file_path(file: &File, _: &Path) -> io::Result<PathBuf> {
    const FILE_NAME_NORMALIZED: u32 = 0;
    const VOLUME_NAME_DOS: u32 = 0;
    let handle = file.as_raw_handle().cast();
    let required = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            std::ptr::null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if required == 0 {
        return Err(io::Error::last_os_error());
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
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..written as usize],
    )))
}

#[cfg(windows)]
pub(crate) fn paths_equal_for_security(left: &Path, right: &Path) -> bool {
    fn without_verbatim_prefix(path: &Path) -> String {
        let value = path.to_string_lossy();
        value
            .strip_prefix(r"\\?\")
            .unwrap_or(&value)
            .replace('/', "\\")
    }
    without_verbatim_prefix(left).eq_ignore_ascii_case(&without_verbatim_prefix(right))
}

#[cfg(not(windows))]
pub(crate) fn paths_equal_for_security(left: &Path, right: &Path) -> bool {
    left == right
}
