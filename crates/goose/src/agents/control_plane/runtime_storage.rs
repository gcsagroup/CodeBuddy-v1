use super::{CodeProRuntimeError, RuntimeRunBinding};
use crate::agents::protocol::RunId;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(super) const RUNTIME_BINDING_FILE_NAME: &str = "runtime-binding.v1.json";
const REGISTRATION_COMPLETE_FILE_NAME: &str = "runtime-registration.v1.complete";
pub(super) const RUNTIME_BINDING_SCHEMA_VERSION: u16 = 1;
const MAX_BINDING_BYTES: u64 = 16 * 1024;

pub(super) fn read_binding(path: &Path) -> Result<RuntimeRunBinding, CodeProRuntimeError> {
    let length = std::fs::metadata(path)
        .map_err(|error| io_error(path, error))?
        .len();
    if length > MAX_BINDING_BYTES {
        return Err(CodeProRuntimeError::InvalidData(
            "runtime binding exceeds its safety limit".to_string(),
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| io_error(path, error))?
        .take(MAX_BINDING_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    let binding: RuntimeRunBinding = serde_json::from_slice(&bytes)
        .map_err(|error| CodeProRuntimeError::InvalidData(error.to_string()))?;
    if binding.schema_version != RUNTIME_BINDING_SCHEMA_VERSION {
        return Err(CodeProRuntimeError::InvalidData(
            "unsupported runtime binding schema version".to_string(),
        ));
    }
    if binding.session_id.trim().is_empty() || binding.goal.trim().is_empty() {
        return Err(CodeProRuntimeError::InvalidData(
            "runtime binding contains an empty session or goal".to_string(),
        ));
    }
    Ok(binding)
}

pub(super) fn registration_complete_path(root: &Path, run_id: &RunId) -> PathBuf {
    root.join(run_id.as_str())
        .join(REGISTRATION_COMPLETE_FILE_NAME)
}

pub(super) fn write_registration_complete(
    root: &Path,
    run_id: &RunId,
) -> Result<(), CodeProRuntimeError> {
    let path = registration_complete_path(root, run_id);
    match OpenOptions::new().create_new(true).write(true).open(&path) {
        Ok(mut file) => {
            file.write_all(b"complete\n")
                .map_err(|error| io_error(&path, error))?;
            file.flush().map_err(|error| io_error(&path, error))?;
            file.sync_all().map_err(|error| io_error(&path, error))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(io_error(&path, error)),
    }
}

pub(super) fn io_error(path: impl AsRef<Path>, error: std::io::Error) -> CodeProRuntimeError {
    CodeProRuntimeError::Io {
        path: path.as_ref().to_path_buf(),
        message: error.to_string(),
    }
}
