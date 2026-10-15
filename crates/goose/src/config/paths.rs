use crate::config::codebuddy_paths::CodeBuddyPaths;
use std::path::PathBuf;

pub struct Paths;

impl Paths {
    fn resolved() -> CodeBuddyPaths {
        let requested_home = crate::config::codebuddy_paths::environment_override("CODEBUDDY_HOME");
        let legacy_home = std::env::var_os("GOOSE_PATH_ROOT");
        let user_home = dirs::home_dir().expect("CodeBuddy requires a user home directory");

        CodeBuddyPaths::resolve(
            requested_home.as_deref(),
            legacy_home.as_deref(),
            &user_home,
        )
        .unwrap_or_else(|error| panic!("invalid CodeBuddy storage configuration: {error}"))
    }

    pub fn home_dir() -> PathBuf {
        Self::resolved().home_dir().to_path_buf()
    }

    pub fn profile_dir() -> PathBuf {
        Self::resolved().profile_dir()
    }

    /// Profile-scoped Provider, model, permission, prompt, and recipe configuration.
    pub fn config_dir() -> PathBuf {
        Self::resolved().profile_config_dir()
    }

    /// Compatibility facade for callers that still expect one backend data root.
    /// New code should use the semantic getters below.
    pub fn data_dir() -> PathBuf {
        Self::profile_dir()
    }

    pub fn state_dir() -> PathBuf {
        Self::resolved().profile_state_dir()
    }

    pub fn cache_dir() -> PathBuf {
        Self::resolved().profile_cache_dir()
    }

    pub fn sessions_dir() -> PathBuf {
        Self::resolved().sessions_dir()
    }

    pub fn runs_dir() -> PathBuf {
        Self::resolved().runs_dir()
    }

    pub fn memory_dir() -> PathBuf {
        Self::resolved().memory_dir()
    }

    pub fn projects_dir() -> PathBuf {
        Self::resolved().projects_dir()
    }

    pub fn audit_dir() -> PathBuf {
        Self::resolved().audit_dir()
    }

    pub fn models_dir() -> PathBuf {
        Self::resolved().models_dir()
    }

    pub fn agents_dir() -> PathBuf {
        Self::resolved().agents_dir()
    }

    pub fn skills_dir() -> PathBuf {
        Self::resolved().skills_dir()
    }

    pub fn prompts_dir() -> PathBuf {
        Self::resolved().prompts_dir()
    }

    pub fn recipes_dir() -> PathBuf {
        Self::resolved().recipes_dir()
    }

    pub fn plugins_dir() -> PathBuf {
        Self::resolved().plugins_packages_dir()
    }

    pub fn logs_dir() -> PathBuf {
        Self::resolved().logs_dir()
    }

    /// User-level instruction root for global AGENTS.md discovery.
    pub fn agents_home_dir() -> PathBuf {
        Self::home_dir()
    }

    pub fn in_agents_home_dir(subpath: &str) -> PathBuf {
        Self::agents_home_dir().join(subpath)
    }

    pub fn in_state_dir(subpath: &str) -> PathBuf {
        Self::state_dir().join(subpath)
    }

    pub fn in_config_dir(subpath: &str) -> PathBuf {
        Self::config_dir().join(subpath)
    }

    pub fn in_data_dir(subpath: &str) -> PathBuf {
        Self::data_dir().join(subpath)
    }
}
