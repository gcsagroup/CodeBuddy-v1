use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ToolExtensionSource {
    Platform,
    Builtin,
    ExternalStdio,
    ExternalHttp,
    Frontend,
    InlinePython,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ToolSecurityProfile {
    pub source: ToolExtensionSource,
    pub permission_class: Option<CodeProPermissionClass>,
}
