use anyhow::{bail, Result};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

pub const CURRENT_STORAGE_LAYOUT_VERSION: u32 = 1;
pub const LOCAL_PROFILE_ID: &str = "local";
pub const LEGACY_DATA_DIRECTORY: &str = ".CodeAgentPro";

pub fn environment_override(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).or_else(|| {
        name.strip_prefix("CODEBUDDY_")
            .and_then(|suffix| std::env::var_os(format!("CODEAGENTPRO_{suffix}")))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeBuddyPaths {
    home_dir: PathBuf,
    legacy_override_source: Option<PathBuf>,
}

impl CodeBuddyPaths {
    pub fn resolve(
        codebuddy_home: Option<&OsStr>,
        goose_path_root: Option<&OsStr>,
        user_home: &Path,
    ) -> Result<Self> {
        let requested_home = validated_override("CODEBUDDY_HOME", codebuddy_home)?;
        let legacy_home = validated_override("GOOSE_PATH_ROOT", goose_path_root)?;
        let user_home = normalize_absolute("user home", user_home)?;
        let new_home = user_home.join(".CodeBuddy");
        let old_home = user_home.join(LEGACY_DATA_DIRECTORY);
        let default_home = if !new_home.exists() && old_home.is_dir() {
            old_home
        } else {
            new_home
        };
        let home_dir = requested_home
            .clone()
            .or_else(|| legacy_home.clone())
            .unwrap_or(default_home);
        let legacy_override_source = requested_home
            .as_ref()
            .and(legacy_home)
            .filter(|legacy| legacy != &home_dir);

        Ok(Self {
            home_dir,
            legacy_override_source,
        })
    }

    pub fn home_dir(&self) -> &Path {
        &self.home_dir
    }

    pub fn app_config_dir(&self) -> PathBuf {
        self.home_dir.join("config")
    }

    pub fn profile_dir(&self) -> PathBuf {
        self.home_dir.join("profiles").join(LOCAL_PROFILE_ID)
    }

    pub fn profile_config_dir(&self) -> PathBuf {
        self.profile_dir().join("config")
    }

    pub fn sessions_dir(&self) -> PathBuf {
        self.profile_dir().join("sessions")
    }

    pub fn runs_dir(&self) -> PathBuf {
        self.profile_dir().join("runs")
    }

    pub fn memory_dir(&self) -> PathBuf {
        self.profile_dir().join("memory")
    }

    pub fn projects_dir(&self) -> PathBuf {
        self.profile_dir().join("projects")
    }

    pub fn audit_dir(&self) -> PathBuf {
        self.profile_dir().join("audit")
    }

    pub fn models_dir(&self) -> PathBuf {
        self.profile_dir().join("models")
    }

    pub fn agents_dir(&self) -> PathBuf {
        self.profile_dir().join("agents")
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.profile_dir().join("skills")
    }

    pub fn prompts_dir(&self) -> PathBuf {
        self.profile_dir().join("prompts")
    }

    pub fn recipes_dir(&self) -> PathBuf {
        self.profile_dir().join("recipes")
    }

    pub fn profile_state_dir(&self) -> PathBuf {
        self.profile_dir().join("state")
    }

    pub fn profile_cache_dir(&self) -> PathBuf {
        self.profile_dir().join("cache")
    }

    pub fn plugins_packages_dir(&self) -> PathBuf {
        self.home_dir.join("plugins").join("packages")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.home_dir.join("logs")
    }

    pub fn migrations_dir(&self) -> PathBuf {
        self.home_dir.join("migrations")
    }

    pub fn electron_user_data_dir(&self) -> PathBuf {
        self.home_dir.join("state").join("electron-app")
    }

    pub fn electron_session_data_dir(&self) -> PathBuf {
        self.profile_state_dir().join("electron")
    }

    pub fn legacy_override_source(&self) -> Option<&Path> {
        self.legacy_override_source.as_deref()
    }
}

fn validated_override(name: &str, value: Option<&OsStr>) -> Result<Option<PathBuf>> {
    value
        .map(|value| {
            if value.is_empty() {
                bail!("{name} must not be empty when it is set");
            }
            normalize_absolute(name, Path::new(value))
        })
        .transpose()
}

fn normalize_absolute(name: &str, path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("{name} must be an absolute path: {}", path.display());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    bail!("{name} escapes its filesystem root: {}", path.display());
                }
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::CodeBuddyPaths;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn resolves_default_local_profile_tree() -> anyhow::Result<()> {
        let paths = CodeBuddyPaths::resolve(None, None, Path::new(r"C:\Users\tester"))?;

        assert_eq!(paths.home_dir(), Path::new(r"C:\Users\tester\.CodeBuddy"));
        assert_eq!(
            paths.profile_config_dir(),
            paths.home_dir().join("profiles/local/config")
        );
        assert_eq!(
            paths.sessions_dir(),
            paths.home_dir().join("profiles/local/sessions")
        );
        assert_eq!(
            paths.models_dir(),
            paths.home_dir().join("profiles/local/models")
        );
        assert_eq!(
            paths.electron_user_data_dir(),
            paths.home_dir().join("state/electron-app")
        );
        assert_eq!(
            paths.electron_session_data_dir(),
            paths.home_dir().join("profiles/local/state/electron")
        );
        assert_eq!(paths.legacy_override_source(), None);
        Ok(())
    }

    #[test]
    fn new_override_wins_over_legacy_override() -> anyhow::Result<()> {
        let paths = CodeBuddyPaths::resolve(
            Some(OsStr::new(r"D:\new-root")),
            Some(OsStr::new(r"D:\legacy-root")),
            Path::new(r"C:\Users\tester"),
        )?;

        assert_eq!(paths.home_dir(), Path::new(r"D:\new-root"));
        assert_eq!(
            paths.legacy_override_source(),
            Some(Path::new(r"D:\legacy-root"))
        );
        Ok(())
    }

    #[test]
    fn legacy_override_is_the_target_when_new_override_is_absent() -> anyhow::Result<()> {
        let paths = CodeBuddyPaths::resolve(
            None,
            Some(OsStr::new(r"D:\portable-root")),
            Path::new(r"C:\Users\tester"),
        )?;

        assert_eq!(paths.home_dir(), Path::new(r"D:\portable-root"));
        assert_eq!(paths.legacy_override_source(), None);
        Ok(())
    }

    #[test]
    fn rejects_empty_or_relative_overrides() {
        let user_home = Path::new(r"C:\Users\tester");

        let empty = CodeBuddyPaths::resolve(Some(OsStr::new("")), None, user_home)
            .expect_err("an explicitly empty override must be rejected");
        assert!(empty.to_string().contains("CODEBUDDY_HOME"));

        let relative = CodeBuddyPaths::resolve(Some(OsStr::new("relative/root")), None, user_home)
            .expect_err("a relative override must be rejected");
        assert!(relative.to_string().contains("absolute"));
    }

    #[test]
    fn rejects_override_that_escapes_the_filesystem_root() {
        let error = CodeBuddyPaths::resolve(
            Some(OsStr::new(r"C:\..")),
            None,
            Path::new(r"C:\Users\tester"),
        )
        .expect_err("an override must not escape its filesystem root");

        assert!(error.to_string().contains("escapes"));
    }
}
