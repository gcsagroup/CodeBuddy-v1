//! Windows handle-relative leaf operations; existing access flags and errors are preserved.

use anyhow::{anyhow, bail, Result};
use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::ptr;

const FILE_LIST_DIRECTORY: u32 = 0x0001;
const FILE_READ_ATTRIBUTES: u32 = 0x0080;
const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_OPEN: u32 = 0x0000_0001;
const FILE_CREATE: u32 = 0x0000_0002;
const STATUS_OBJECT_NAME_COLLISION: NtStatus = 0xC000_0035_u32 as NtStatus;
const STATUS_OBJECT_NAME_NOT_FOUND: NtStatus = 0xC000_0034_u32 as NtStatus;
const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;

type Handle = *mut c_void;
type NtStatus = i32;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: Handle,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}

#[repr(C)]
struct IoStatusBlock {
    status: isize,
    information: usize,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file_handle: *mut Handle,
        desired_access: u32,
        object_attributes: *mut ObjectAttributes,
        io_status_block: *mut IoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut c_void,
        ea_length: u32,
    ) -> NtStatus;
    fn NtSetInformationFile(
        file_handle: Handle,
        io_status_block: *mut IoStatusBlock,
        file_information: *mut c_void,
        length: u32,
        file_information_class: u32,
    ) -> NtStatus;
}

#[link(name = "kernel32")]
unsafe extern "system" {}

pub(crate) fn file_rename_information_layout(
    pointer_size: usize,
    pointer_alignment: usize,
) -> Option<(usize, usize, usize)> {
    if !matches!(pointer_size, 4 | 8) || pointer_alignment != pointer_size {
        return None;
    }
    let root_directory_offset = (1 + pointer_alignment - 1) & !(pointer_alignment - 1);
    let file_name_length_offset = root_directory_offset.checked_add(pointer_size)?;
    let file_name_offset = file_name_length_offset.checked_add(std::mem::size_of::<u32>())?;
    Some((
        root_directory_offset,
        file_name_length_offset,
        file_name_offset,
    ))
}

pub(crate) fn rename_open_target_relative_with_replace(
    target: &File,
    parent: &File,
    name: &OsStr,
    replace: bool,
) -> Result<()> {
    if name.is_empty() || Path::new(name).components().count() != 1 {
        bail!("cleanup rename destination must be a single path segment");
    }
    let wide = name.encode_wide().collect::<Vec<_>>();
    let name_bytes = wide
        .len()
        .checked_mul(2)
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| anyhow!("cleanup rename destination is too long"))?;
    let (root_directory_offset, file_name_length_offset, file_name_offset) =
        file_rename_information_layout(std::mem::size_of::<usize>(), std::mem::align_of::<usize>())
            .ok_or_else(|| anyhow!("cleanup rename ABI is unsupported on this pointer layout"))?;
    let mut info = vec![0u8; file_name_offset + name_bytes as usize];
    info[0] = u8::from(replace);
    info[root_directory_offset..root_directory_offset + std::mem::size_of::<usize>()]
        .copy_from_slice(&(parent.as_raw_handle() as usize).to_ne_bytes());
    info[file_name_length_offset..file_name_offset].copy_from_slice(&name_bytes.to_ne_bytes());
    for (index, unit) in wide.iter().enumerate() {
        let offset = file_name_offset + index * 2;
        info[offset..offset + 2].copy_from_slice(&unit.to_ne_bytes());
    }
    const FILE_RENAME_INFORMATION_CLASS: u32 = 10;
    let mut io_status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let status = unsafe {
        NtSetInformationFile(
            target.as_raw_handle().cast(),
            &mut io_status,
            info.as_mut_ptr().cast(),
            u32::try_from(info.len()).map_err(|_| anyhow!("cleanup rename buffer is too large"))?,
            FILE_RENAME_INFORMATION_CLASS,
        )
    };
    if status < 0 {
        bail!(
            "handle-relative cleanup rename failed with NTSTATUS 0x{:08x}",
            status as u32
        );
    }
    Ok(())
}

pub(crate) fn open_relative_directory(
    parent: &File,
    name: &OsStr,
    disposition: u32,
    no_follow: bool,
) -> Result<File> {
    open_relative_directory_with_access(
        parent,
        name,
        disposition,
        no_follow,
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )?
    .ok_or_else(|| anyhow!("workspace component already exists"))
}

pub(crate) fn open_child_directory(parent: &File, name: &OsStr) -> Result<File> {
    open_relative_directory(parent, name, FILE_OPEN, true)
}

pub(crate) fn try_create_child_directory(parent: &File, name: &OsStr) -> Result<Option<File>> {
    open_relative_directory_with_access(
        parent,
        name,
        FILE_CREATE,
        true,
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE | winapi::um::winnt::DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )
}

pub(crate) fn open_relative_directory_with_access(
    parent: &File,
    name: &OsStr,
    disposition: u32,
    no_follow: bool,
    desired_access: u32,
    share_access: u32,
) -> Result<Option<File>> {
    if name.is_empty() || Path::new(name).components().count() != 1 {
        bail!("workspace component must be a single path segment");
    }
    let mut wide: Vec<u16> = name.encode_wide().collect();
    let byte_len = wide
        .len()
        .checked_mul(2)
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| anyhow!("workspace component is too long"))?;
    let mut unicode = UnicodeString {
        length: byte_len,
        maximum_length: byte_len,
        buffer: wide.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle().cast(),
        object_name: &mut unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: ptr::null_mut(),
        security_quality_of_service: ptr::null_mut(),
    };
    let mut io_status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle: Handle = ptr::null_mut();
    let mut create_options = FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT;
    if no_follow {
        create_options |= FILE_OPEN_REPARSE_POINT;
    }
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &mut attributes,
            &mut io_status,
            ptr::null_mut(),
            0,
            share_access,
            disposition,
            create_options,
            ptr::null_mut(),
            0,
        )
    };
    if status == STATUS_OBJECT_NAME_COLLISION {
        return Ok(None);
    }
    if status < 0 || handle.is_null() {
        bail!(
            "NtCreateFile failed for workspace component with NTSTATUS 0x{:08x}",
            status as u32
        );
    }
    Ok(Some(unsafe { File::from_raw_handle(handle.cast()) }))
}

pub(crate) fn open_relative_file_with_access(
    parent: &File,
    name: &OsStr,
    disposition: u32,
    desired_access: u32,
    share_access: u32,
) -> Result<Option<File>> {
    if name.is_empty() || Path::new(name).components().count() != 1 {
        bail!("journal leaf must be a single path segment");
    }
    let mut wide = name.encode_wide().collect::<Vec<_>>();
    let byte_len = wide
        .len()
        .checked_mul(2)
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| anyhow!("journal leaf name is too long"))?;
    let mut unicode = UnicodeString {
        length: byte_len,
        maximum_length: byte_len,
        buffer: wide.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle().cast(),
        object_name: &mut unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: ptr::null_mut(),
        security_quality_of_service: ptr::null_mut(),
    };
    let mut io_status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle: Handle = ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &mut attributes,
            &mut io_status,
            ptr::null_mut(),
            0,
            share_access,
            disposition,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            ptr::null_mut(),
            0,
        )
    };
    if matches!(
        status,
        STATUS_OBJECT_NAME_COLLISION | STATUS_OBJECT_NAME_NOT_FOUND
    ) {
        return Ok(None);
    }
    if status < 0 || handle.is_null() {
        bail!(
            "NtCreateFile failed for journal leaf with NTSTATUS 0x{:08x}",
            status as u32
        );
    }
    Ok(Some(unsafe { File::from_raw_handle(handle.cast()) }))
}

pub(crate) fn open_relative_cleanup_object_for_inspection(
    parent: &File,
    name: &OsStr,
) -> Result<Option<File>> {
    if name.is_empty() || Path::new(name).components().count() != 1 {
        bail!("cleanup inspection leaf must be a single path segment");
    }
    let mut wide = name.encode_wide().collect::<Vec<_>>();
    let byte_len = wide
        .len()
        .checked_mul(2)
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| anyhow!("cleanup inspection leaf name is too long"))?;
    let mut unicode = UnicodeString {
        length: byte_len,
        maximum_length: byte_len,
        buffer: wide.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle().cast(),
        object_name: &mut unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: ptr::null_mut(),
        security_quality_of_service: ptr::null_mut(),
    };
    let mut io_status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle: Handle = ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            winapi::um::winnt::GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &mut attributes,
            &mut io_status,
            ptr::null_mut(),
            0,
            FILE_SHARE_READ,
            FILE_OPEN,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            ptr::null_mut(),
            0,
        )
    };
    if status == STATUS_OBJECT_NAME_NOT_FOUND {
        return Ok(None);
    }
    if status < 0 || handle.is_null() {
        bail!(
            "NtCreateFile failed for cleanup inspection leaf with NTSTATUS 0x{:08x}",
            status as u32
        );
    }
    Ok(Some(unsafe { File::from_raw_handle(handle.cast()) }))
}
