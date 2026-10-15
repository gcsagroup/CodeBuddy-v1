//! Fresh OS observations for the existing Reviewer prerequisite gate.
//! These are not task authorization or acceptance receipts.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct DesktopEnvironment {
    pub desktop_available: bool,
    pub permission_available: bool,
}

impl DesktopEnvironment {
    pub async fn current() -> Self {
        #[cfg(windows)]
        {
            Self::windows(current_process_can_access_input_desktop())
        }
        #[cfg(target_os = "macos")]
        {
            // Same native sibling invoked by qwen-computer-use/native_runtime.go.
            // Invoke it directly so a timed-out probe has no wrapper child to leak.
            let result = match std::env::current_exe() {
                Ok(path) => {
                    probe_native_at(
                        &path.with_file_name("qwen-computer-runtime"),
                        std::time::Duration::from_secs(3),
                    )
                    .await
                }
                Err(error) => Err(error.into()),
            };
            result.unwrap_or_else(|error| {
                tracing::warn!(%error, "Mac desktop prerequisite probe unavailable");
                Self::default()
            })
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            Self::default()
        }
    }

    #[cfg(any(windows, test))]
    fn windows(input_desktop_accessible: bool) -> Self {
        Self {
            desktop_available: input_desktop_accessible,
            permission_available: true,
        }
    }
}

#[cfg(windows)]
fn current_process_can_access_input_desktop() -> bool {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, desired_access: u32) -> *mut c_void;
        fn CloseDesktop(desktop: *mut c_void) -> i32;
    }

    const DESKTOP_READOBJECTS: u32 = 0x0001;
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        return false;
    }
    unsafe {
        CloseDesktop(desktop);
    }
    true
}

#[cfg(any(target_os = "macos", test))]
fn parse_native_probe(bytes: &[u8]) -> anyhow::Result<DesktopEnvironment> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        ok: bool,
        desktop_environment: NativeEnvironment,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeEnvironment {
        schema_version: u32,
        platform: String,
        desktop_available: bool,
        permission_available: bool,
    }
    let response: Response = serde_json::from_slice(bytes)?;
    let native = response.desktop_environment;
    anyhow::ensure!(
        response.ok && native.schema_version == 1 && native.platform == "macos",
        "unsupported native desktop diagnostic"
    );
    Ok(DesktopEnvironment {
        desktop_available: native.desktop_available,
        permission_available: native.permission_available,
    })
}

#[cfg(any(target_os = "macos", test))]
async fn probe_native_at(
    executable: &std::path::Path,
    timeout: std::time::Duration,
) -> anyhow::Result<DesktopEnvironment> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const MAX_BYTES: u64 = 64 * 1024;
    let mut child = tokio::process::Command::new(executable)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let result = tokio::time::timeout(timeout, async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("missing probe stdin"))?;
        stdin.write_all(br#"{"tool":"doctor"}"#).await?;
        stdin.shutdown().await?;
        drop(stdin);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("missing probe stdout"))?;
        let mut bytes = Vec::new();
        stdout.take(MAX_BYTES + 1).read_to_end(&mut bytes).await?;
        anyhow::ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "oversized desktop diagnostic"
        );
        anyhow::ensure!(child.wait().await?.success(), "native desktop probe failed");
        parse_native_probe(&bytes)
    })
    .await;
    match result {
        Ok(Ok(environment)) => Ok(environment),
        failure => {
            // Kill and reap the one owned probe; cancellation also kills on drop.
            let _ = child.kill().await;
            match failure {
                Ok(Err(error)) => Err(error),
                Err(_) => Err(anyhow::anyhow!("native desktop probe timed out")),
                Ok(Ok(_)) => unreachable!(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_desktop_probe_preserves_input_desktop_semantics() {
        assert!(DesktopEnvironment::windows(true).desktop_available);
        assert!(!DesktopEnvironment::windows(false).desktop_available);
        assert!(DesktopEnvironment::windows(false).permission_available);
    }

    #[test]
    fn native_desktop_probe_consumes_structured_readiness_only() {
        for (desktop, permission) in [(true, true), (true, false), (false, true), (false, false)] {
            let response = serde_json::json!({"ok":true,"text":"Desktop ready!",
                "desktopEnvironment":{"schemaVersion":1,"platform":"macos",
                "desktopAvailable":desktop,"permissionAvailable":permission}});
            assert_eq!(
                parse_native_probe(&serde_json::to_vec(&response).unwrap()).unwrap(),
                DesktopEnvironment {
                    desktop_available: desktop,
                    permission_available: permission
                }
            );
        }
    }

    #[test]
    fn native_desktop_probe_rejects_old_partial_and_invalid_contracts() {
        let good = serde_json::json!({"ok":true,"desktopEnvironment":{"schemaVersion":1,
            "platform":"macos","desktopAvailable":true,"permissionAvailable":true}});
        for field in [
            "schemaVersion",
            "platform",
            "desktopAvailable",
            "permissionAvailable",
        ] {
            let mut value = good.clone();
            value["desktopEnvironment"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(parse_native_probe(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for (field, value) in [
            ("schemaVersion", serde_json::json!(2)),
            ("platform", serde_json::json!("windows")),
            ("desktopAvailable", serde_json::json!("true")),
        ] {
            let mut response = good.clone();
            response["desktopEnvironment"][field] = value;
            assert!(parse_native_probe(&serde_json::to_vec(&response).unwrap()).is_err());
        }
        let mut failed = good;
        failed["ok"] = serde_json::json!(false);
        assert!(parse_native_probe(&serde_json::to_vec(&failed).unwrap()).is_err());
        assert!(parse_native_probe(br#"{"ok":true,"text":"Accessibility=true"}"#).is_err());
        assert!(parse_native_probe(b"not json").is_err());
    }

    #[tokio::test]
    async fn native_desktop_probe_missing_helper_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        assert!(probe_native_at(
            &dir.path().join("missing"),
            std::time::Duration::from_secs(1)
        )
        .await
        .is_err());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires the freshly built native helper path"]
    async fn native_desktop_probe_real_helper_readonly() {
        let path = std::env::var_os("CODEPRO_TEST_NATIVE_HELPER").expect("native helper path");
        let result = probe_native_at(
            std::path::Path::new(&path),
            std::time::Duration::from_secs(3),
        )
        .await
        .expect("fresh native helper must provide structured OS prerequisites");
        eprintln!("Native read-only prerequisites: {result:?}; no input or permission prompt");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn native_desktop_probe_transport_bounds_and_exit_status() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("fixture");
        for (body, expected) in [
            ("cat >/dev/null; printf '%s' '{\"ok\":true,\"desktopEnvironment\":{\"schemaVersion\":1,\"platform\":\"macos\",\"desktopAvailable\":true,\"permissionAvailable\":false}}'",true),
            ("cat >/dev/null; exit 7",false),
            ("cat >/dev/null; printf 'bad json'",false),
            ("cat >/dev/null; while :; do :; done",false),
            ("cat >/dev/null; while :; do printf '1234567890123456789012345678901234567890'; done",false),
        ] {
            std::fs::write(&file,format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&file,std::fs::Permissions::from_mode(0o700)).unwrap();
            let result=probe_native_at(&file,std::time::Duration::from_millis(500)).await;
            assert_eq!(result.is_ok(),expected,"{result:?}");
            if let Ok(value)=result { assert!(value.desktop_available); assert!(!value.permission_available); }
        }
    }
}
