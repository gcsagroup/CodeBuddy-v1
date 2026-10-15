use super::*;
use crate::config::extensions::name_to_key;
use crate::secure_fs::{
    metadata_is_link_or_reparse_point, opened_file_path, paths_equal_for_security, SecureDirectory,
    SecureFile,
};
use serde::Deserialize;
use serde_yaml::Mapping;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

#[cfg(all(windows, test))]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

const GOOSE_CONFIG_PREFIX: &str = "goose_config:";
const CLAUDE_DESKTOP_PREFIX: &str = "claude_desktop:";

#[derive(Clone)]
pub(super) struct AuthorizedImportCandidate {
    source_kind: OnboardingImportSourceKind,
    source_bytes: Vec<u8>,
    adjacent_secrets_bytes: Option<Vec<u8>>,
    skills: Vec<AuthorizedSkill>,
}

#[derive(Clone)]
struct AuthorizedSkill {
    name: PathBuf,
    files: Vec<AuthorizedSkillFile>,
}

#[derive(Clone)]
struct AuthorizedSkillFile {
    relative_path: PathBuf,
    bytes: Vec<u8>,
}

pub(super) type AuthorizedImportScan = HashMap<String, AuthorizedImportCandidate>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDesktopConfig {
    #[serde(default)]
    mcp_servers: HashMap<String, ClaudeMcpServer>,
}

#[derive(Debug, Deserialize)]
struct ClaudeMcpServer {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

impl GooseAcpAgent {
    pub(super) async fn on_onboarding_import_scan(
        &self,
        req: OnboardingImportScanRequest,
    ) -> Result<OnboardingImportScanResponse, agent_client_protocol::Error> {
        let source_filter = source_filter(&req.sources);
        let mut candidates = Vec::new();
        let mut authorized = AuthorizedImportScan::new();

        if source_filter.contains(&OnboardingImportSourceKind::GooseConfig) {
            for path in goose_config_candidate_paths(&self.config_dir) {
                if let Some((candidate, authorization)) = authorize_goose_config_candidate(&path) {
                    authorized.insert(candidate.id.clone(), authorization);
                    candidates.push(candidate);
                }
            }
        }

        if source_filter.contains(&OnboardingImportSourceKind::ClaudeDesktop) {
            for path in claude_desktop_candidate_paths() {
                if let Some((candidate, authorization)) = authorize_claude_desktop_candidate(&path)
                {
                    authorized.insert(candidate.id.clone(), authorization);
                    candidates.push(candidate);
                }
            }
        }

        candidates.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        let scan_id = Uuid::new_v4().to_string();
        let mut scans = self.onboarding_import_scans.lock().await;
        // A scan is a short-lived, one-use authorization. Replacing prior scans prevents
        // stale path capabilities and bounds any in-memory credential snapshot lifetime.
        scans.clear();
        scans.insert(scan_id.clone(), authorized);
        Ok(OnboardingImportScanResponse {
            scan_id,
            candidates,
        })
    }

    pub(super) async fn on_onboarding_import_apply(
        &self,
        req: OnboardingImportApplyRequest,
    ) -> Result<OnboardingImportApplyResponse, agent_client_protocol::Error> {
        let config = self.config()?;
        let authorized = self
            .onboarding_import_scans
            .lock()
            .await
            .remove(req.scan_id.trim())
            .ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data("A fresh onboarding import scan is required")
            })?;
        apply_onboarding_import_candidates(config, &self.config_dir, &req, &authorized)
            .await
            .map_err(|error| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("Onboarding import was rejected: {error}"))
            })
    }
}

async fn apply_onboarding_import_candidates(
    config: &Config,
    target_config_dir: &Path,
    req: &OnboardingImportApplyRequest,
    authorized: &AuthorizedImportScan,
) -> anyhow::Result<OnboardingImportApplyResponse> {
    if req.candidate_ids.is_empty() {
        anyhow::bail!("at least one candidate must be selected from the fresh scan");
    }
    for candidate_id in &req.candidate_ids {
        anyhow::ensure!(
            authorized.contains_key(candidate_id),
            "candidate was not authorized by the fresh scan"
        );
    }
    let mut imported = OnboardingImportCounts::default();
    let mut skipped = OnboardingImportCounts::default();
    let mut warnings = Vec::new();
    let mut provider_defaults = None;
    let mut failed_candidates = 0;

    for candidate_id in &req.candidate_ids {
        let candidate = authorized
            .get(candidate_id)
            .ok_or_else(|| anyhow::anyhow!("candidate was not authorized by the fresh scan"))?;
        let result = match candidate.source_kind {
            OnboardingImportSourceKind::GooseConfig => {
                apply_goose_config_candidate(config, target_config_dir, candidate).await
            }
            OnboardingImportSourceKind::ClaudeDesktop => {
                apply_claude_desktop_candidate(config, candidate, req.enable_imported_extensions)
            }
        };
        match result {
            Ok(result) => {
                add_counts(&mut imported, &result.imported);
                add_counts(&mut skipped, &result.skipped);
                warnings.extend(result.warnings);
                if result.provider_defaults.provider_id.is_some()
                    || result.provider_defaults.model_id.is_some()
                {
                    provider_defaults = Some(result.provider_defaults);
                }
            }
            Err(error) => {
                failed_candidates += 1;
                warnings.push(format!(
                    "Skipped onboarding import candidate '{candidate_id}': {error}"
                ));
            }
        }
    }

    if failed_candidates == req.candidate_ids.len() {
        anyhow::bail!("none of the selected onboarding import candidates could be applied");
    }

    Ok(OnboardingImportApplyResponse {
        imported,
        skipped,
        warnings,
        provider_defaults,
    })
}

#[derive(Default)]
struct ApplyResult {
    imported: OnboardingImportCounts,
    skipped: OnboardingImportCounts,
    warnings: Vec<String>,
    provider_defaults: DefaultsReadResponse,
}

fn source_filter(sources: &[OnboardingImportSourceKind]) -> HashSet<OnboardingImportSourceKind> {
    if sources.is_empty() {
        return [
            OnboardingImportSourceKind::GooseConfig,
            OnboardingImportSourceKind::ClaudeDesktop,
        ]
        .into_iter()
        .collect();
    }

    sources.iter().copied().collect()
}

fn add_counts(target: &mut OnboardingImportCounts, source: &OnboardingImportCounts) {
    target.providers += source.providers;
    target.extensions += source.extensions;
    target.sessions += source.sessions;
    target.skills += source.skills;
    target.projects += source.projects;
    target.preferences += source.preferences;
}

fn goose_config_candidate_paths(config_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![config_dir.join(CONFIG_YAML_NAME)];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".config").join("goose").join(CONFIG_YAML_NAME));
    }
    dedupe_paths(paths)
}

fn claude_desktop_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(config_dir) = dirs::config_dir() {
        paths.push(config_dir.join("Claude").join("claude_desktop_config.json"));
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
        paths.push(
            home.join("AppData")
                .join("Roaming")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
    }
    dedupe_paths(paths)
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn authorize_goose_config_candidate(
    path: &Path,
) -> Option<(OnboardingImportCandidate, AuthorizedImportCandidate)> {
    let (canonical_path, source_bytes) = read_direct_file(path)?;
    let mapping = read_yaml_mapping_bytes(&source_bytes).ok()?;
    let skills = snapshot_skill_dirs(&canonical_path.parent()?.join("skills")).ok()?;
    let mut counts = OnboardingImportCounts::default();
    let mut warnings = Vec::new();

    if mapping_contains_string(&mapping, "GOOSE_PROVIDER")
        || mapping_contains_string(&mapping, "GOOSE_MODEL")
    {
        counts.providers = 1;
    }
    counts.extensions = extension_count(&mapping);
    counts.skills = skills.len() as u32;

    if counts.sessions > 0 {
        warnings.push("Sessions are already shared through Goose's data store.".to_string());
    }

    let id = candidate_id(GOOSE_CONFIG_PREFIX, &canonical_path);
    let candidate = OnboardingImportCandidate {
        id: id.clone(),
        source_kind: OnboardingImportSourceKind::GooseConfig,
        display_name: "Existing Goose configuration".to_string(),
        path: canonical_path.to_string_lossy().to_string(),
        counts,
        warnings,
    };
    let adjacent_secrets_path = canonical_path
        .parent()
        .map(|parent| parent.join("secrets.yaml"));
    let adjacent_secrets_bytes = match adjacent_secrets_path {
        Some(path) => read_optional_direct_file(&path)?,
        None => None,
    };
    Some((
        candidate,
        AuthorizedImportCandidate {
            source_kind: OnboardingImportSourceKind::GooseConfig,
            source_bytes,
            adjacent_secrets_bytes,
            skills,
        },
    ))
}

fn authorize_claude_desktop_candidate(
    path: &Path,
) -> Option<(OnboardingImportCandidate, AuthorizedImportCandidate)> {
    let (canonical_path, source_bytes) = read_direct_file(path)?;
    let (servers, warnings) = read_claude_servers_bytes(&source_bytes).ok()?;
    if servers.is_empty() && warnings.is_empty() {
        return None;
    }

    let id = candidate_id(CLAUDE_DESKTOP_PREFIX, &canonical_path);
    let candidate = OnboardingImportCandidate {
        id: id.clone(),
        source_kind: OnboardingImportSourceKind::ClaudeDesktop,
        display_name: "Claude Desktop tools".to_string(),
        path: canonical_path.to_string_lossy().to_string(),
        counts: OnboardingImportCounts {
            extensions: servers.len() as u32,
            ..Default::default()
        },
        warnings,
    };
    Some((
        candidate,
        AuthorizedImportCandidate {
            source_kind: OnboardingImportSourceKind::ClaudeDesktop,
            source_bytes,
            adjacent_secrets_bytes: None,
            skills: Vec::new(),
        },
    ))
}

fn candidate_id(prefix: &str, path: &Path) -> String {
    format!("{prefix}{}", path.to_string_lossy())
}

fn read_direct_file(path: &Path) -> Option<(PathBuf, Vec<u8>)> {
    read_direct_file_with_hook(path, || Ok(())).ok()
}

fn read_direct_file_with_hook<F>(path: &Path, after_open: F) -> anyhow::Result<(PathBuf, Vec<u8>)>
where
    F: FnOnce() -> anyhow::Result<()>,
{
    read_direct_file_with_hooks(path, || Ok(()), after_open)
}

fn read_direct_file_with_hooks<AfterParentReview, AfterOpen>(
    path: &Path,
    after_parent_review: AfterParentReview,
    after_open: AfterOpen,
) -> anyhow::Result<(PathBuf, Vec<u8>)>
where
    AfterParentReview: FnOnce() -> anyhow::Result<()>,
    AfterOpen: FnOnce() -> anyhow::Result<()>,
{
    let nominal_parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("onboarding import file has no parent"))?;
    let canonical_parent = nominal_parent
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("onboarding import parent is unavailable"))?;
    let nominal_parent = if nominal_parent.is_absolute() {
        nominal_parent.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| anyhow::anyhow!("current directory is unavailable"))?
            .join(nominal_parent)
    };
    anyhow::ensure!(
        paths_equal_for_security(&canonical_parent, &nominal_parent),
        "onboarding import parent is redirected"
    );
    let expected_path = canonical_parent.join(
        path.file_name()
            .ok_or_else(|| anyhow::anyhow!("onboarding import file has no name"))?,
    );
    after_parent_review()?;
    let mut file = open_file_no_follow(path)
        .map_err(|_| anyhow::anyhow!("onboarding import file could not be opened safely"))?;
    let metadata = file
        .metadata()
        .map_err(|_| anyhow::anyhow!("onboarding import file metadata is unavailable"))?;
    anyhow::ensure!(
        metadata.is_file() && !metadata_is_link_or_reparse_point(&metadata),
        "onboarding import source is not a direct regular file"
    );
    let opened_path = opened_file_path(&file, path)
        .map_err(|_| anyhow::anyhow!("onboarding import file identity is unavailable"))?;
    anyhow::ensure!(
        paths_equal_for_security(&opened_path, &expected_path),
        "onboarding import file leaves its authorized parent"
    );

    after_open()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("onboarding import file could not be read"))?;
    Ok((expected_path, bytes))
}

fn open_file_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    options.open(path)
}

fn read_optional_direct_file(path: &Path) -> Option<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(_) => read_direct_file(path).map(|(_, bytes)| Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}

fn read_yaml_mapping_bytes(content: &[u8]) -> anyhow::Result<Mapping> {
    let value: serde_yaml::Value = serde_yaml::from_slice(content)?;
    Ok(value.as_mapping().cloned().unwrap_or_default())
}

fn mapping_contains_string(mapping: &Mapping, key: &str) -> bool {
    mapping
        .get(serde_yaml::Value::String(key.to_string()))
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.trim().is_empty())
}

fn extension_count(mapping: &Mapping) -> u32 {
    mapping
        .get(serde_yaml::Value::String("extensions".to_string()))
        .and_then(|value| value.as_mapping())
        .map(|extensions| extensions.len() as u32)
        .unwrap_or_default()
}

fn snapshot_skill_dirs(path: &Path) -> anyhow::Result<Vec<AuthorizedSkill>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        anyhow::bail!("legacy skills root is not a direct directory");
    }
    let canonical_parent = path
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .ok_or_else(|| anyhow::anyhow!("legacy skills parent is unavailable"))?;
    let canonical_root = path.canonicalize()?;
    if canonical_root != canonical_parent.join(path.file_name().unwrap_or_default()) {
        anyhow::bail!("legacy skills root leaves its authorized parent");
    }

    let mut skills = Vec::new();
    for entry in fs::read_dir(&canonical_root)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = PathBuf::from(entry.file_name());
        let skill_root = entry.path();
        let canonical_skill = skill_root.canonicalize()?;
        if canonical_skill != canonical_root.join(&name) {
            anyhow::bail!("legacy skill leaves its authorized root");
        }
        let mut files = Vec::new();
        snapshot_skill_files(&canonical_skill, &canonical_skill, &mut files)?;
        if !files
            .iter()
            .any(|file| file.relative_path == Path::new("SKILL.md"))
        {
            continue;
        }
        skills.push(AuthorizedSkill { name, files });
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn snapshot_skill_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<AuthorizedSkillFile>,
) -> anyhow::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = fs::symlink_metadata(&path)?.file_type();
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let canonical = path.canonicalize()?;
            if !canonical.starts_with(root) {
                anyhow::bail!("legacy skill directory leaves its authorized root");
            }
            snapshot_skill_files(root, &canonical, files)?;
        } else if file_type.is_file() {
            let (canonical, bytes) = read_direct_file(&path)
                .ok_or_else(|| anyhow::anyhow!("legacy skill file is not direct"))?;
            if !canonical.starts_with(root) {
                anyhow::bail!("legacy skill file leaves its authorized root");
            }
            let relative_path = canonical.strip_prefix(root)?.to_path_buf();
            files.push(AuthorizedSkillFile {
                relative_path,
                bytes,
            });
        }
    }
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(())
}

async fn apply_goose_config_candidate(
    target_config: &Config,
    target_config_dir: &Path,
    candidate: &AuthorizedImportCandidate,
) -> anyhow::Result<ApplyResult> {
    let source = read_yaml_mapping_bytes(&candidate.source_bytes)?;
    let mut result = ApplyResult::default();
    let mut config_updates = Vec::new();
    let mut secret_updates = Vec::new();

    let provider = yaml_string(&source, "GOOSE_PROVIDER");
    let model = yaml_string(&source, "GOOSE_MODEL");
    if let Some(ref p) = provider {
        let registry_entry = crate::providers::get_from_registry(p)
            .await
            .map_err(|_| anyhow::anyhow!("Unknown imported provider"))?;
        let metadata = registry_entry.metadata().clone();
        super::providers::ensure_provider_credential_activation_supported(&metadata)
            .map_err(|_| anyhow::anyhow!("Imported provider cannot be activated safely"))?;

        let imported_secrets = candidate
            .adjacent_secrets_bytes
            .as_deref()
            .map(read_yaml_mapping_bytes)
            .transpose()?
            .unwrap_or_default();
        let mut candidate_values = HashMap::new();
        for key in &metadata.config_keys {
            let imported_value = if key.secret {
                imported_secrets.get(serde_yaml::Value::String(key.name.clone()))
            } else {
                source.get(serde_yaml::Value::String(key.name.clone()))
            };
            let Some(imported_value) = imported_value else {
                continue;
            };
            let value = serde_json::to_value(imported_value)?;
            candidate_values.insert(key.name.clone(), value.clone());
            if key.secret {
                secret_updates.push((key.name.clone(), value));
            } else {
                config_updates.push((key.name.clone(), value));
            }
        }

        let manual_primary = metadata
            .config_keys
            .iter()
            .any(|key| key.primary && key.secret && !key.oauth_flow);
        if manual_primary {
            let provider = crate::config::base::with_candidate_provider_values(
                candidate_values,
                registry_entry.create_with_default_model(Vec::new()),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Imported provider configuration is invalid"))?;
            provider
                .validate_credentials()
                .await
                .map_err(|_| anyhow::anyhow!("Imported provider credentials were rejected"))?;
        }

        let m = model.clone().unwrap_or_else(|| {
            crate::config::get_provider_entry(target_config, p)
                .map(|e| e.model)
                .unwrap_or_else(|| metadata.default_model.clone())
        });
        let model_is_known = m == metadata.default_model
            || metadata
                .known_models
                .iter()
                .any(|known| known.name.eq_ignore_ascii_case(&m));
        if !model_is_known {
            anyhow::bail!("Imported provider model is not supported by the selected provider");
        }
        let mut providers: Mapping = target_config.get_param("providers").unwrap_or_default();
        providers.insert(
            serde_yaml::Value::String(p.clone()),
            serde_yaml::to_value(crate::config::ProviderEntry {
                enabled: true,
                model: m.clone(),
                configured: true,
            })?,
        );
        config_updates.push((
            "active_provider".to_string(),
            serde_json::Value::String(p.clone()),
        ));
        config_updates.push(("providers".to_string(), serde_json::to_value(providers)?));
        result.provider_defaults = DefaultsReadResponse {
            provider_id: provider.clone(),
            model_id: model,
        };
        result.imported.providers = 1;
    }

    let (extensions, extension_result) = prepare_goose_config_extensions(target_config, &source)?;
    result.imported.extensions += extension_result.imported;
    result.skipped.extensions += extension_result.skipped;
    if extension_result.imported > 0 {
        config_updates.push(("extensions".to_string(), serde_json::to_value(extensions)?));
    }

    if provider.is_none() && candidate.adjacent_secrets_bytes.is_some() {
        result.warnings.push(
            "Skipped adjacent provider secrets because the import did not select a provider."
                .to_string(),
        );
    }

    let mut installed_skills = install_authorized_skills(
        &candidate.skills,
        target_config_dir,
        &mut result.imported.skills,
        &mut result.skipped.skills,
    )?;
    if let Err(error) =
        target_config.set_provider_values_transactional(&config_updates, &secret_updates)
    {
        if installed_skills.rollback().is_err() {
            anyhow::bail!("onboarding import failed and skill rollback did not complete");
        }
        return Err(error.into());
    }
    installed_skills.commit();

    result
        .warnings
        .push("Session history already lives in the Goose data store when available.".to_string());
    Ok(result)
}

fn yaml_string(mapping: &Mapping, key: &str) -> Option<String> {
    mapping
        .get(serde_yaml::Value::String(key.to_string()))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[derive(Default)]
struct ImportPairCount {
    imported: u32,
    skipped: u32,
}

fn prepare_goose_config_extensions(
    target_config: &Config,
    source: &Mapping,
) -> anyhow::Result<(Mapping, ImportPairCount)> {
    let Some(source_extensions) = source
        .get(serde_yaml::Value::String("extensions".to_string()))
        .and_then(|value| value.as_mapping())
    else {
        return Ok((Mapping::new(), ImportPairCount::default()));
    };

    let mut target_extensions = load_target_extensions(target_config)?;
    let mut counts = ImportPairCount::default();
    for (key, value) in source_extensions {
        if target_extensions.contains_key(key) {
            counts.skipped += 1;
            continue;
        }
        target_extensions.insert(key.clone(), value.clone());
        counts.imported += 1;
    }

    Ok((target_extensions, counts))
}

fn load_target_extensions(target_config: &Config) -> anyhow::Result<Mapping> {
    match target_config.get_param::<Mapping>("extensions") {
        Ok(extensions) => Ok(extensions),
        Err(crate::config::ConfigError::NotFound(_)) => Ok(Mapping::new()),
        Err(error) => Err(error.into()),
    }
}

struct InstalledSkills {
    directories: Vec<SecureDirectory>,
    files: Vec<SecureFile>,
    committed: bool,
}

impl InstalledSkills {
    fn rollback(&mut self) -> anyhow::Result<()> {
        let mut failure_count = attempt_all_reverse(&mut self.files, SecureFile::remove_owned);
        failure_count += attempt_all_reverse(&mut self.directories, SecureDirectory::remove_owned);
        self.files.clear();
        self.directories.clear();
        self.committed = true;
        if failure_count == 0 {
            Ok(())
        } else {
            anyhow::bail!("{failure_count} cleanup operations failed during skill rollback")
        }
    }

    fn commit(&mut self) {
        self.files.clear();
        self.directories.clear();
        self.committed = true;
    }
}

impl Drop for InstalledSkills {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.rollback();
        }
    }
}

fn attempt_all_reverse<T>(
    items: &mut [T],
    mut action: impl FnMut(&mut T) -> io::Result<()>,
) -> usize {
    let mut failure_count = 0;
    for item in items.iter_mut().rev() {
        if action(item).is_err() {
            failure_count += 1;
        }
    }
    failure_count
}

fn install_authorized_skills(
    skills: &[AuthorizedSkill],
    target_config_dir: &Path,
    imported: &mut u32,
    skipped: &mut u32,
) -> anyhow::Result<InstalledSkills> {
    install_authorized_skills_with_hooks(skills, target_config_dir, imported, skipped, |_| Ok(()))
}

#[derive(Debug)]
enum SkillInstallHookPoint<'a> {
    AfterConfigReview,
    #[cfg(unix)]
    BeforeUnixMutation,
    AfterRootReview,
    AfterDirectorySecured(&'a Path),
    BeforeRollback,
}

fn run_skill_install_hook<'a, Hook>(
    hook: &mut Hook,
    point: SkillInstallHookPoint<'a>,
) -> anyhow::Result<()>
where
    Hook: FnMut(SkillInstallHookPoint<'a>) -> anyhow::Result<()>,
{
    if let SkillInstallHookPoint::AfterDirectorySecured(path) = &point {
        anyhow::ensure!(
            path.file_name().is_some(),
            "secured skill directory has no name"
        );
    }
    hook(point)
}

#[cfg(unix)]
fn reject_unix_skill_installation() -> anyhow::Result<()> {
    anyhow::bail!(
        "skill import is unavailable on Unix because directory replacement cannot be made atomic"
    )
}

fn install_authorized_skills_with_hooks<Hook>(
    skills: &[AuthorizedSkill],
    target_config_dir: &Path,
    imported: &mut u32,
    skipped: &mut u32,
    mut hook: Hook,
) -> anyhow::Result<InstalledSkills>
where
    Hook: FnMut(SkillInstallHookPoint<'_>) -> anyhow::Result<()>,
{
    if skills.is_empty() {
        return Ok(InstalledSkills {
            directories: Vec::new(),
            files: Vec::new(),
            committed: false,
        });
    }
    let config_directory = SecureDirectory::open_config(target_config_dir)?;
    run_skill_install_hook(&mut hook, SkillInstallHookPoint::AfterConfigReview)?;
    config_directory.ensure_bound()?;
    #[cfg(unix)]
    {
        run_skill_install_hook(&mut hook, SkillInstallHookPoint::BeforeUnixMutation)?;
        config_directory.ensure_bound()?;
        reject_unix_skill_installation()?;
    }
    let (target_root_directory, _) = config_directory.create_child(OsStr::new("skills"))?;
    let mut installed = InstalledSkills {
        directories: vec![config_directory, target_root_directory],
        files: Vec::new(),
        committed: false,
    };
    let install_result = (|| -> anyhow::Result<()> {
        run_skill_install_hook(&mut hook, SkillInstallHookPoint::AfterRootReview)?;
        installed.directories[1].ensure_bound()?;
        for skill in skills {
            let skill_name = skill
                .name
                .file_name()
                .filter(|_| skill.name.components().count() == 1)
                .ok_or_else(|| anyhow::anyhow!("authorized skill name is not direct"))?;
            let (skill_directory, created) = installed.directories[1].create_child(skill_name)?;
            if !created {
                *skipped += 1;
                continue;
            }
            installed.directories.push(skill_directory);
            let skill_directory_index = installed.directories.len() - 1;
            let secured_path = installed.directories[skill_directory_index]
                .path()
                .to_path_buf();
            run_skill_install_hook(
                &mut hook,
                SkillInstallHookPoint::AfterDirectorySecured(&secured_path),
            )?;
            installed.directories[skill_directory_index].ensure_bound()?;
            for file in &skill.files {
                let relative_parent = file.relative_path.parent().unwrap_or_else(|| Path::new(""));
                let mut current_directory_index = skill_directory_index;
                for component in relative_parent.components() {
                    let std::path::Component::Normal(name) = component else {
                        anyhow::bail!("authorized skill file path is not relative");
                    };
                    let (directory, _) =
                        installed.directories[current_directory_index].create_child(name)?;
                    installed.directories.push(directory);
                    current_directory_index = installed.directories.len() - 1;
                    let secured_path = installed.directories[current_directory_index]
                        .path()
                        .to_path_buf();
                    run_skill_install_hook(
                        &mut hook,
                        SkillInstallHookPoint::AfterDirectorySecured(&secured_path),
                    )?;
                    installed.directories[current_directory_index].ensure_bound()?;
                }
                let file_name = file
                    .relative_path
                    .file_name()
                    .ok_or_else(|| anyhow::anyhow!("authorized skill file has no name"))?;
                let secure_file =
                    SecureFile::create(&installed.directories[current_directory_index], file_name)?;
                installed.files.push(secure_file);
                installed
                    .files
                    .last_mut()
                    .ok_or_else(|| anyhow::anyhow!("secure file ledger is unavailable"))?
                    .write_all(&file.bytes)?;
            }
            *imported += 1;
        }
        Ok(())
    })();
    if let Err(install_error) = install_result {
        let hook_error =
            run_skill_install_hook(&mut hook, SkillInstallHookPoint::BeforeRollback).err();
        let rollback_error = installed.rollback().err();
        match (hook_error, rollback_error) {
            (None, None) => return Err(install_error),
            (Some(hook_error), None) => {
                anyhow::bail!(
                    "skill installation failed; before-rollback hook failed after cleanup: {hook_error}"
                );
            }
            (None, Some(rollback_error)) => {
                anyhow::bail!(
                    "skill installation failed and skill rollback did not complete: {rollback_error}"
                );
            }
            (Some(hook_error), Some(rollback_error)) => {
                anyhow::bail!(
                    "skill installation failed; before-rollback hook failed ({hook_error}) and skill rollback did not complete ({rollback_error})"
                );
            }
        }
    }
    Ok(installed)
}

fn apply_claude_desktop_candidate(
    target_config: &Config,
    candidate: &AuthorizedImportCandidate,
    enable_imported_extensions: bool,
) -> anyhow::Result<ApplyResult> {
    let (servers, mut warnings) = read_claude_servers_bytes(&candidate.source_bytes)?;
    let mut target_extensions = load_target_extensions(target_config)?;
    let mut result = ApplyResult::default();

    for (name, server) in servers {
        let command = match server.command {
            Some(command) if !command.trim().is_empty() => command,
            _ => {
                result.skipped.extensions += 1;
                warnings.push(format!(
                    "Skipped Claude MCP server '{name}' because it has no command."
                ));
                continue;
            }
        };

        let key = serde_yaml::Value::String(name_to_key(&name));
        if target_extensions.contains_key(&key) {
            result.skipped.extensions += 1;
            continue;
        }

        let entry = crate::config::extensions::ExtensionEntry {
            enabled: enable_imported_extensions,
            config: ExtensionConfig::Stdio {
                name,
                description: "Imported from Claude Desktop".to_string(),
                cmd: command,
                args: server.args,
                envs: Envs::new(server.env),
                env_keys: Vec::new(),
                timeout: Some(crate::config::DEFAULT_EXTENSION_TIMEOUT),
                cwd: None,
                bundled: None,
                available_tools: Vec::new(),
                read_only_tools: Vec::new(),
            },
        };
        target_extensions.insert(key, serde_yaml::to_value(entry)?);
        result.imported.extensions += 1;
    }

    if result.imported.extensions > 0 {
        target_config.set_param("extensions", target_extensions)?;
    }

    result.warnings.extend(warnings);
    if !enable_imported_extensions && result.imported.extensions > 0 {
        result
            .warnings
            .push("Imported Claude Desktop MCP servers are disabled by default.".to_string());
    }
    Ok(result)
}

fn read_claude_servers_bytes(
    content: &[u8],
) -> anyhow::Result<(HashMap<String, ClaudeMcpServer>, Vec<String>)> {
    let config: ClaudeDesktopConfig = serde_json::from_slice(content)?;
    let mut servers = HashMap::new();
    let mut warnings = Vec::new();

    for (name, server) in config.mcp_servers {
        if server
            .command
            .as_deref()
            .is_some_and(|command| !command.trim().is_empty())
        {
            servers.insert(name, server);
        } else {
            warnings.push(format!("Claude MCP server '{name}' has no command."));
        }
    }

    Ok((servers, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(windows)]
    fn create_test_directory_link(link: &Path, target: &Path) -> anyhow::Result<()> {
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "mklink failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(())
    }

    #[cfg(unix)]
    fn create_test_directory_link(link: &Path, target: &Path) -> anyhow::Result<()> {
        std::os::unix::fs::symlink(target, link)?;
        Ok(())
    }

    fn replace_directory_or_confirm_locked(
        nominal: &Path,
        preserved: &Path,
        replacement: &Path,
    ) -> bool {
        match std::fs::rename(nominal, preserved) {
            Ok(()) => {
                create_test_directory_link(nominal, replacement).unwrap();
                true
            }
            #[cfg(windows)]
            Err(error) => {
                assert!(
                    matches!(error.raw_os_error(), Some(5) | Some(32)),
                    "directory replacement failed for an unexpected reason: {error}"
                );
                false
            }
            #[cfg(unix)]
            Err(error) => panic!("directory replacement setup failed: {error}"),
        }
    }

    #[test]
    fn scan_claude_desktop_counts_valid_servers() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("claude_desktop_config.json");
        fs::write(
            &path,
            r#"{
              "mcpServers": {
                "github": { "command": "npx", "args": ["github-mcp"] },
                "broken": { "args": ["missing-command"] }
              }
            }"#,
        )
        .unwrap();

        let (candidate, _) = authorize_claude_desktop_candidate(&path).unwrap();
        assert_eq!(candidate.counts.extensions, 1);
        assert_eq!(candidate.warnings.len(), 1);
    }

    #[tokio::test]
    async fn apply_onboarding_import_rejects_candidate_outside_scan() {
        let target = TempDir::new().unwrap();
        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        let req = OnboardingImportApplyRequest {
            scan_id: "scan".to_string(),
            candidate_ids: vec!["goose_config:outside-scan".to_string()],
            enable_imported_extensions: false,
        };

        let error = apply_onboarding_import_candidates(
            &target_config,
            target.path(),
            &req,
            &AuthorizedImportScan::new(),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("not authorized"));
    }

    #[tokio::test]
    async fn apply_onboarding_import_rejects_an_empty_candidate_list() {
        let target = TempDir::new().unwrap();
        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        let req = OnboardingImportApplyRequest {
            scan_id: "scan".to_string(),
            candidate_ids: Vec::new(),
            enable_imported_extensions: false,
        };

        let error = apply_onboarding_import_candidates(
            &target_config,
            target.path(),
            &req,
            &AuthorizedImportScan::new(),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("at least one candidate"));
    }

    #[tokio::test]
    async fn apply_onboarding_import_applies_every_authorized_candidate_in_request_order() {
        let target = TempDir::new().unwrap();
        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        let mut authorized = AuthorizedImportScan::new();
        for (id, name) in [("claude:first", "first"), ("claude:second", "second")] {
            authorized.insert(
                id.to_string(),
                AuthorizedImportCandidate {
                    source_kind: OnboardingImportSourceKind::ClaudeDesktop,
                    source_bytes: format!(
                        r#"{{"mcpServers":{{"{name}":{{"command":"command-{name}"}}}}}}"#
                    )
                    .into_bytes(),
                    adjacent_secrets_bytes: None,
                    skills: Vec::new(),
                },
            );
        }
        let req = OnboardingImportApplyRequest {
            scan_id: "scan".to_string(),
            candidate_ids: vec!["claude:first".to_string(), "claude:second".to_string()],
            enable_imported_extensions: false,
        };

        let result =
            apply_onboarding_import_candidates(&target_config, target.path(), &req, &authorized)
                .await
                .unwrap();

        assert_eq!(result.imported.extensions, 2);
        let extensions: Mapping = target_config.get_param("extensions").unwrap();
        assert!(extensions.contains_key(serde_yaml::Value::String("first".to_string())));
        assert!(extensions.contains_key(serde_yaml::Value::String("second".to_string())));
    }

    #[tokio::test]
    async fn apply_onboarding_import_continues_after_an_authorized_candidate_fails() {
        let target = TempDir::new().unwrap();
        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        let mut authorized = AuthorizedImportScan::new();
        authorized.insert(
            "goose:broken".to_string(),
            AuthorizedImportCandidate {
                source_kind: OnboardingImportSourceKind::GooseConfig,
                source_bytes: b"extensions: [".to_vec(),
                adjacent_secrets_bytes: None,
                skills: Vec::new(),
            },
        );
        authorized.insert(
            "claude:usable".to_string(),
            AuthorizedImportCandidate {
                source_kind: OnboardingImportSourceKind::ClaudeDesktop,
                source_bytes: br#"{"mcpServers":{"usable":{"command":"usable-command"}}}"#.to_vec(),
                adjacent_secrets_bytes: None,
                skills: Vec::new(),
            },
        );
        let req = OnboardingImportApplyRequest {
            scan_id: "scan".to_string(),
            candidate_ids: vec!["goose:broken".to_string(), "claude:usable".to_string()],
            enable_imported_extensions: false,
        };

        let result =
            apply_onboarding_import_candidates(&target_config, target.path(), &req, &authorized)
                .await
                .unwrap();

        assert_eq!(result.imported.extensions, 1);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("goose:broken")));
        let extensions: Mapping = target_config.get_param("extensions").unwrap();
        assert!(extensions.contains_key(serde_yaml::Value::String("usable".to_string())));
    }

    #[tokio::test]
    async fn apply_onboarding_import_rejects_an_unapproved_id_before_any_candidate_runs() {
        let target = TempDir::new().unwrap();
        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        let mut authorized = AuthorizedImportScan::new();
        authorized.insert(
            "claude:authorized".to_string(),
            AuthorizedImportCandidate {
                source_kind: OnboardingImportSourceKind::ClaudeDesktop,
                source_bytes: br#"{"mcpServers":{"authorized":{"command":"safe-command"}}}"#
                    .to_vec(),
                adjacent_secrets_bytes: None,
                skills: Vec::new(),
            },
        );
        let req = OnboardingImportApplyRequest {
            scan_id: "scan".to_string(),
            candidate_ids: vec![
                "claude:unapproved".to_string(),
                "claude:authorized".to_string(),
            ],
            enable_imported_extensions: false,
        };

        let error =
            apply_onboarding_import_candidates(&target_config, target.path(), &req, &authorized)
                .await
                .unwrap_err();

        assert!(error.to_string().contains("not authorized"));
        let extensions: Mapping = target_config.get_param("extensions").unwrap_or_default();
        assert!(
            !extensions.contains_key(serde_yaml::Value::String("authorized".to_string())),
            "an authorized candidate ran before the full request was validated"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn apply_goose_config_imports_safe_defaults_extensions_and_skills() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_config = source.path().join(CONFIG_YAML_NAME);
        fs::write(
            &source_config,
            r#"
GOOSE_PROVIDER: claude-acp
GOOSE_MODEL: current
extensions:
  github:
    enabled: true
    type: stdio
    name: github
    description: GitHub
    cmd: npx
    args: ["github-mcp"]
"#,
        )
        .unwrap();
        let skill_dir = source.path().join("skills").join("reviewer");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Reviewer").unwrap();

        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();

        let (_, authorization) = authorize_goose_config_candidate(&source_config).unwrap();
        let result = apply_goose_config_candidate(&target_config, target.path(), &authorization)
            .await
            .unwrap();

        assert_eq!(result.imported.providers, 1);
        assert_eq!(result.imported.extensions, 1);
        assert_eq!(result.imported.skills, 1);
        assert_eq!(target_config.get_goose_provider().unwrap(), "claude-acp");
        assert!(target.path().join("skills").join("reviewer").exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn apply_goose_config_uses_the_skill_bytes_authorized_by_scan() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_config = source.path().join(CONFIG_YAML_NAME);
        fs::write(&source_config, "GOOSE_MODEL: current\n").unwrap();
        let skill_dir = source.path().join("skills").join("reviewer");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        fs::write(&skill_file, "# scanned skill\n").unwrap();

        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        let (_, authorization) = authorize_goose_config_candidate(&source_config).unwrap();

        fs::write(&skill_file, "# replaced after scan\n").unwrap();
        apply_goose_config_candidate(&target_config, target.path(), &authorization)
            .await
            .unwrap();

        assert_eq!(
            fs::read(target.path().join("skills/reviewer/SKILL.md")).unwrap(),
            b"# scanned skill\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn apply_goose_config_rejects_skills_without_writing_any_target_items() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_config = source.path().join(CONFIG_YAML_NAME);
        fs::write(
            &source_config,
            "extensions:\n  safe:\n    enabled: true\n    type: stdio\n    name: safe\n    description: safe\n    cmd: safe\n",
        )
        .unwrap();
        let skill_dir = source.path().join("skills/reviewer");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Reviewer").unwrap();
        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        target_config.set_param("preserved_setting", true).unwrap();
        let before = fs::read(target.path().join(CONFIG_YAML_NAME)).unwrap();
        let (_, authorization) = authorize_goose_config_candidate(&source_config).unwrap();

        let error =
            match apply_goose_config_candidate(&target_config, target.path(), &authorization).await
            {
                Ok(_) => panic!("Unix skill import must fail closed"),
                Err(error) => error,
            };

        assert!(error.to_string().contains("unavailable on Unix"));
        assert!(!target.path().join("skills").exists());
        assert_eq!(
            fs::read(target.path().join(CONFIG_YAML_NAME)).unwrap(),
            before
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn apply_goose_config_without_skills_keeps_extensions_available_on_unix() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_config = source.path().join(CONFIG_YAML_NAME);
        fs::write(
            &source_config,
            "extensions:\n  safe:\n    enabled: true\n    type: stdio\n    name: safe\n    description: safe\n    cmd: safe\n",
        )
        .unwrap();
        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        let (_, authorization) = authorize_goose_config_candidate(&source_config).unwrap();

        let result = apply_goose_config_candidate(&target_config, target.path(), &authorization)
            .await
            .unwrap();

        assert_eq!(result.imported.extensions, 1);
        assert!(target_config.get_param::<Mapping>("extensions").is_ok());
    }

    #[test]
    fn authorize_goose_config_rejects_a_symlinked_nominal_candidate() {
        let nominal = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_config = outside.path().join(CONFIG_YAML_NAME);
        fs::write(&outside_config, "GOOSE_MODEL: current\n").unwrap();
        let nominal_config = nominal.path().join(CONFIG_YAML_NAME);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_config, &nominal_config).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_file(&outside_config, &nominal_config) {
            if error.raw_os_error() == Some(1314) {
                return;
            }
            panic!("could not create test symlink: {error}");
        }

        assert!(authorize_goose_config_candidate(&nominal_config).is_none());
    }

    #[test]
    fn direct_file_read_stays_bound_to_the_opened_file_when_path_is_replaced() {
        let root = TempDir::new().unwrap();
        let nominal_parent = root.path().join("allowed");
        let outside_parent = root.path().join("outside");
        fs::create_dir(&nominal_parent).unwrap();
        fs::create_dir(&outside_parent).unwrap();
        let nominal_file = nominal_parent.join(CONFIG_YAML_NAME);
        let preserved_file = nominal_parent.join("config-preserved.yaml");
        let outside_file = outside_parent.join(CONFIG_YAML_NAME);
        fs::write(&nominal_file, b"GOOSE_MODEL: scanned\n").unwrap();
        fs::write(&outside_file, b"GOOSE_MODEL: replaced\n").unwrap();

        let read_result = read_direct_file_with_hook(&nominal_file, || {
            fs::rename(&nominal_file, &preserved_file)?;
            fs::hard_link(&outside_file, &nominal_file)?;
            Ok(())
        });
        let (_, bytes) = match read_result {
            Ok(value) => value,
            Err(error) => panic!("the opened file should remain readable: {error}"),
        };

        assert_eq!(bytes, b"GOOSE_MODEL: scanned\n");
    }

    #[test]
    fn direct_file_read_rejects_a_reparse_parent_without_symlink_privileges() {
        let root = TempDir::new().unwrap();
        let nominal_parent = root.path().join("allowed");
        let outside_parent = root.path().join("outside");
        fs::create_dir(&outside_parent).unwrap();
        fs::write(
            outside_parent.join(CONFIG_YAML_NAME),
            b"GOOSE_MODEL: outside\n",
        )
        .unwrap();
        create_test_directory_link(&nominal_parent, &outside_parent).unwrap();

        let error = read_direct_file_with_hook(&nominal_parent.join(CONFIG_YAML_NAME), || Ok(()))
            .expect_err("a reparse parent must not authorize an outside file");

        assert!(error.to_string().contains("parent is redirected"));
    }

    #[test]
    fn direct_file_read_rejects_parent_replacement_between_review_and_open() {
        let root = TempDir::new().unwrap();
        let nominal_parent = root.path().join("allowed");
        let preserved_parent = root.path().join("allowed-preserved");
        let outside_parent = root.path().join("outside");
        fs::create_dir(&nominal_parent).unwrap();
        fs::create_dir(&outside_parent).unwrap();
        let nominal_file = nominal_parent.join(CONFIG_YAML_NAME);
        fs::write(&nominal_file, b"GOOSE_MODEL: scanned\n").unwrap();
        fs::write(
            outside_parent.join(CONFIG_YAML_NAME),
            b"GOOSE_MODEL: replaced\n",
        )
        .unwrap();

        let error = read_direct_file_with_hooks(
            &nominal_file,
            || {
                fs::rename(&nominal_parent, &preserved_parent)?;
                create_test_directory_link(&nominal_parent, &outside_parent)
            },
            || Ok(()),
        )
        .expect_err("a parent replacement before open must be rejected");

        assert!(error
            .to_string()
            .contains("file leaves its authorized parent"));
    }

    #[tokio::test]
    async fn apply_goose_config_rolls_back_installed_skills_when_config_commit_fails() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_config = source.path().join(CONFIG_YAML_NAME);
        fs::write(
            &source_config,
            r#"
extensions:
  safe:
    enabled: true
    type: stdio
    name: safe
    description: safe
    cmd: safe
"#,
        )
        .unwrap();
        let skill_dir = source.path().join("skills/reviewer");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# scanned skill\n").unwrap();

        let target_config_path = target.path().join(CONFIG_YAML_NAME);
        let target_config = Config::new_with_file_secrets(
            target_config_path.clone(),
            target.path().join("secrets.yaml"),
        )
        .unwrap();
        fs::create_dir(&target_config_path).unwrap();
        let (_, authorization) = authorize_goose_config_candidate(&source_config).unwrap();

        assert!(
            apply_goose_config_candidate(&target_config, target.path(), &authorization)
                .await
                .is_err()
        );
        assert!(!target.path().join("skills/reviewer").exists());
        assert!(target_config_path.is_dir());
    }

    #[test]
    fn skill_rollback_attempts_every_created_item_and_reports_all_cleanup_failures() {
        let mut created_items = vec!["root", "first", "second"];
        let attempts = std::cell::RefCell::new(Vec::new());

        let failure_count = attempt_all_reverse(&mut created_items, |item| {
            attempts.borrow_mut().push(*item);
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected cleanup failure",
            ))
        });

        assert_eq!(attempts.into_inner(), vec!["second", "first", "root"]);
        assert_eq!(failure_count, 3);
    }

    #[test]
    fn skill_installation_error_explicitly_rolls_back_every_partial_creation() {
        let target = TempDir::new().unwrap();
        let skills = vec![
            AuthorizedSkill {
                name: PathBuf::from("first"),
                files: vec![AuthorizedSkillFile {
                    relative_path: PathBuf::from("SKILL.md"),
                    bytes: b"first".to_vec(),
                }],
            },
            AuthorizedSkill {
                name: PathBuf::from("second"),
                files: vec![AuthorizedSkillFile {
                    // A directory is not a writable file. This injects an installation
                    // failure after both skill directories and the first skill exist.
                    relative_path: PathBuf::new(),
                    bytes: b"cannot write a directory".to_vec(),
                }],
            },
        ];
        let mut imported = 0;
        let mut skipped = 0;

        let error =
            match install_authorized_skills(&skills, target.path(), &mut imported, &mut skipped) {
                Ok(_) => panic!("a partial skill installation must fail"),
                Err(error) => error,
            };

        assert!(!error.to_string().contains("cannot write a directory"));
        assert!(!target.path().join("skills").exists());
    }

    #[test]
    fn skill_installation_rejects_target_root_replacement_before_writing() {
        let target = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let target_root = target.path().join("skills");
        let preserved_root = target.path().join("skills-preserved");
        fs::create_dir(&target_root).unwrap();
        let skills = vec![AuthorizedSkill {
            name: PathBuf::from("reviewer"),
            files: vec![AuthorizedSkillFile {
                relative_path: PathBuf::from("SKILL.md"),
                bytes: b"must remain inside the target".to_vec(),
            }],
        }];
        let mut imported = 0;
        let mut skipped = 0;

        let result = install_authorized_skills_with_hooks(
            &skills,
            target.path(),
            &mut imported,
            &mut skipped,
            |point| match point {
                SkillInstallHookPoint::AfterRootReview => {
                    fs::rename(&target_root, &preserved_root)?;
                    create_test_directory_link(&target_root, outside.path())
                }
                _ => Ok(()),
            },
        );

        assert!(result.is_err(), "a replaced target root must fail closed");
        assert!(
            !outside.path().join("reviewer/SKILL.md").exists(),
            "a replaced target root must never receive imported bytes"
        );
    }

    #[cfg(windows)]
    #[test]
    fn skill_rollback_never_removes_through_a_replaced_target_root() {
        let target = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let target_root = target.path().join("skills");
        let preserved_root = target.path().join("skills-preserved");
        for name in ["first", "second"] {
            let external = outside.path().join(name);
            fs::create_dir(&external).unwrap();
            fs::write(external.join("external-marker"), b"must survive").unwrap();
        }
        let skills = vec![
            AuthorizedSkill {
                name: PathBuf::from("first"),
                files: vec![AuthorizedSkillFile {
                    relative_path: PathBuf::from("SKILL.md"),
                    bytes: b"first".to_vec(),
                }],
            },
            AuthorizedSkill {
                name: PathBuf::from("second"),
                files: vec![AuthorizedSkillFile {
                    relative_path: PathBuf::new(),
                    bytes: b"force a failure after partial installation".to_vec(),
                }],
            },
        ];
        let replacement_attempt = std::cell::Cell::new(None);
        let mut imported = 0;
        let mut skipped = 0;

        let result = install_authorized_skills_with_hooks(
            &skills,
            target.path(),
            &mut imported,
            &mut skipped,
            |point| match point {
                SkillInstallHookPoint::BeforeRollback => {
                    replacement_attempt.set(Some(replace_directory_or_confirm_locked(
                        &target_root,
                        &preserved_root,
                        outside.path(),
                    )));
                    Ok(())
                }
                _ => Ok(()),
            },
        );

        assert!(result.is_err());
        replacement_attempt
            .get()
            .unwrap_or_else(|| panic!("root replacement hook did not run"));
        for name in ["first", "second"] {
            assert!(
                outside.path().join(name).join("external-marker").exists(),
                "rollback must not remove external {name} through a replaced root"
            );
        }
        #[cfg(windows)]
        assert!(
            !target_root.exists(),
            "sharing denial in the hook must not bypass cleanup of the owned root"
        );
    }

    #[test]
    fn skill_installation_rejects_configuration_directory_replacement() {
        let container = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let target_config = container.path().join("config");
        let preserved_config = container.path().join("config-preserved");
        fs::create_dir(&target_config).unwrap();
        let skills = vec![AuthorizedSkill {
            name: PathBuf::from("reviewer"),
            files: vec![AuthorizedSkillFile {
                relative_path: PathBuf::from("SKILL.md"),
                bytes: b"must remain in the reviewed configuration".to_vec(),
            }],
        }];
        let replacement_attempt = std::cell::Cell::new(None);
        let mut imported = 0;
        let mut skipped = 0;

        let result = install_authorized_skills_with_hooks(
            &skills,
            &target_config,
            &mut imported,
            &mut skipped,
            |point| {
                if matches!(point, SkillInstallHookPoint::AfterConfigReview) {
                    replacement_attempt.set(Some(replace_directory_or_confirm_locked(
                        &target_config,
                        &preserved_config,
                        outside.path(),
                    )));
                }
                Ok(())
            },
        );

        let replaced = replacement_attempt
            .get()
            .unwrap_or_else(|| panic!("configuration replacement hook did not run"));
        if replaced {
            let error = match result {
                Ok(_) => panic!("a replaced configuration directory must fail closed"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("identity changed"));
        } else {
            result.unwrap().commit();
        }
        assert!(!outside.path().join("skills/reviewer/SKILL.md").exists());
    }

    #[cfg(windows)]
    #[test]
    fn secure_directory_creation_rejects_a_direct_replacement_before_binding() {
        let target = TempDir::new().unwrap();
        let config = SecureDirectory::open_config(target.path()).unwrap();
        let child = target.path().join("skills");
        let preserved = target.path().join("skills-created");
        let external_sentinel = target.path().join("external-sentinel");
        fs::write(&external_sentinel, b"must survive").unwrap();
        let hook_entered = std::cell::Cell::new(false);
        let replacement_completed = std::cell::Cell::new(false);

        let (mut created, was_created) = config
            .create_child_with_hook(OsStr::new("skills"), |_| {
                hook_entered.set(true);
                replacement_completed.set(fs::rename(&child, &preserved).is_ok());
                Ok(())
            })
            .unwrap();

        assert!(hook_entered.get(), "the post-create hook did not run");
        assert!(
            !replacement_completed.get(),
            "the transaction-created directory must already be locked against replacement"
        );
        assert!(was_created);
        created.remove_owned().unwrap();
        assert!(!child.exists());
        assert!(!preserved.exists());
        assert_eq!(fs::read(&external_sentinel).unwrap(), b"must survive");
    }

    #[cfg(windows)]
    #[test]
    fn skill_installation_rejects_skill_directory_replacement() {
        let target = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let skill_dir = target.path().join("skills/reviewer");
        let preserved_skill = target.path().join("skills/reviewer-preserved");
        let outside_skill = outside.path().join("reviewer");
        fs::create_dir(&outside_skill).unwrap();
        let skills = vec![AuthorizedSkill {
            name: PathBuf::from("reviewer"),
            files: vec![AuthorizedSkillFile {
                relative_path: PathBuf::from("SKILL.md"),
                bytes: b"must not reach a replacement skill directory".to_vec(),
            }],
        }];
        let replacement_attempt = std::cell::Cell::new(None);
        let mut imported = 0;
        let mut skipped = 0;

        let result = install_authorized_skills_with_hooks(
            &skills,
            target.path(),
            &mut imported,
            &mut skipped,
            |point| {
                if matches!(
                    point,
                    SkillInstallHookPoint::AfterDirectorySecured(path) if path == skill_dir
                ) {
                    replacement_attempt.set(Some(replace_directory_or_confirm_locked(
                        &skill_dir,
                        &preserved_skill,
                        &outside_skill,
                    )));
                }
                Ok(())
            },
        );

        let replaced = replacement_attempt
            .get()
            .unwrap_or_else(|| panic!("skill replacement hook did not run"));
        if replaced {
            let error = match result {
                Ok(_) => panic!("a replaced skill directory must fail closed"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("identity changed"));
        } else {
            result.unwrap().commit();
        }
        assert!(!outside_skill.join("SKILL.md").exists());
    }

    #[cfg(windows)]
    #[test]
    fn skill_installation_rejects_nested_directory_replacement() {
        let target = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let nested = target.path().join("skills/reviewer/references");
        let preserved_nested = target.path().join("skills/reviewer/references-preserved");
        let outside_nested = outside.path().join("references");
        fs::create_dir(&outside_nested).unwrap();
        let skills = vec![AuthorizedSkill {
            name: PathBuf::from("reviewer"),
            files: vec![AuthorizedSkillFile {
                relative_path: PathBuf::from("references/guide.md"),
                bytes: b"must not reach a replacement nested directory".to_vec(),
            }],
        }];
        let replacement_attempt = std::cell::Cell::new(None);
        let mut imported = 0;
        let mut skipped = 0;

        let result = install_authorized_skills_with_hooks(
            &skills,
            target.path(),
            &mut imported,
            &mut skipped,
            |point| {
                if matches!(
                    point,
                    SkillInstallHookPoint::AfterDirectorySecured(path) if path == nested
                ) {
                    replacement_attempt.set(Some(replace_directory_or_confirm_locked(
                        &nested,
                        &preserved_nested,
                        &outside_nested,
                    )));
                }
                Ok(())
            },
        );

        let replaced = replacement_attempt
            .get()
            .unwrap_or_else(|| panic!("nested replacement hook did not run"));
        if replaced {
            let error = match result {
                Ok(_) => panic!("a replaced nested directory must fail closed"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("identity changed"));
        } else {
            result.unwrap().commit();
        }
        assert!(!outside_nested.join("guide.md").exists());
    }

    #[cfg(windows)]
    #[test]
    fn skill_rollback_never_deletes_through_a_replaced_skill_directory() {
        let target = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let skill_dir = target.path().join("skills/first");
        let preserved_skill = target.path().join("skills/first-preserved");
        let outside_skill = outside.path().join("first");
        fs::create_dir(&outside_skill).unwrap();
        fs::write(outside_skill.join("SKILL.md"), b"external sentinel").unwrap();
        let skills = vec![
            AuthorizedSkill {
                name: PathBuf::from("first"),
                files: vec![AuthorizedSkillFile {
                    relative_path: PathBuf::from("SKILL.md"),
                    bytes: b"installed bytes".to_vec(),
                }],
            },
            AuthorizedSkill {
                name: PathBuf::from("second"),
                files: vec![AuthorizedSkillFile {
                    relative_path: PathBuf::new(),
                    bytes: b"force rollback after first skill".to_vec(),
                }],
            },
        ];
        let replacement_attempt = std::cell::Cell::new(None);
        let install_progress_reached = std::cell::Cell::new(false);
        let mut imported = 0;
        let mut skipped = 0;

        let result = install_authorized_skills_with_hooks(
            &skills,
            target.path(),
            &mut imported,
            &mut skipped,
            |point| {
                if matches!(point, SkillInstallHookPoint::BeforeRollback) {
                    install_progress_reached.set(skill_dir.join("SKILL.md").is_file());
                    replacement_attempt.set(Some(replace_directory_or_confirm_locked(
                        &skill_dir,
                        &preserved_skill,
                        &outside_skill,
                    )));
                }
                Ok(())
            },
        );

        assert!(
            result.is_err(),
            "the independent write failure must trigger rollback"
        );
        assert!(
            install_progress_reached.get(),
            "rollback hook ran before installation progressed"
        );
        replacement_attempt
            .get()
            .unwrap_or_else(|| panic!("rollback replacement hook did not run"));
        assert_eq!(
            fs::read(outside_skill.join("SKILL.md")).unwrap(),
            b"external sentinel"
        );
    }

    #[cfg(windows)]
    #[test]
    fn skill_rollback_runs_after_a_before_rollback_hook_error() {
        let target = TempDir::new().unwrap();
        let skills = vec![
            AuthorizedSkill {
                name: PathBuf::from("first"),
                files: vec![AuthorizedSkillFile {
                    relative_path: PathBuf::from("SKILL.md"),
                    bytes: b"created before hook failure".to_vec(),
                }],
            },
            AuthorizedSkill {
                name: PathBuf::from("second"),
                files: vec![AuthorizedSkillFile {
                    relative_path: PathBuf::new(),
                    bytes: b"force the independent installation failure".to_vec(),
                }],
            },
        ];
        let hook_entered = std::cell::Cell::new(false);
        let mut imported = 0;
        let mut skipped = 0;

        let error = match install_authorized_skills_with_hooks(
            &skills,
            target.path(),
            &mut imported,
            &mut skipped,
            |point| {
                if matches!(point, SkillInstallHookPoint::BeforeRollback) {
                    hook_entered.set(true);
                    anyhow::bail!("injected before-rollback hook failure");
                }
                Ok(())
            },
        ) {
            Ok(_) => panic!("an independent installation failure must reach rollback"),
            Err(error) => error,
        };

        assert!(hook_entered.get(), "the before-rollback hook did not run");
        assert!(error.to_string().contains("hook failure"));
        assert!(
            !target.path().join("skills/first/SKILL.md").exists(),
            "hook failure must not bypass cleanup of the created file"
        );
        assert!(
            !target.path().join("skills").exists(),
            "hook failure must not bypass cleanup of the created root"
        );
    }

    #[cfg(windows)]
    #[test]
    fn skill_installation_panic_rolls_back_every_partial_creation() {
        let target = TempDir::new().unwrap();
        let skills = vec![AuthorizedSkill {
            name: PathBuf::from("first"),
            files: vec![AuthorizedSkillFile {
                relative_path: PathBuf::from("SKILL.md"),
                bytes: b"must be removed during unwind".to_vec(),
            }],
        }];
        let mut imported = 0;
        let mut skipped = 0;

        let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = install_authorized_skills_with_hooks(
                &skills,
                target.path(),
                &mut imported,
                &mut skipped,
                |point| {
                    if matches!(point, SkillInstallHookPoint::AfterDirectorySecured(_)) {
                        panic!("injected skill installation panic");
                    }
                    Ok(())
                },
            );
        }));

        assert!(panic_result.is_err(), "the injected panic must unwind");
        assert!(
            !target.path().join("skills").exists(),
            "unwind must best-effort remove every object created by the transaction"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_created_directory_is_handle_bound_before_the_post_create_hook() {
        let target = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_sentinel = outside.path().join("external-sentinel");
        fs::write(&outside_sentinel, b"must survive").unwrap();
        let config = SecureDirectory::open_config(target.path()).unwrap();
        let (root, _) = config.create_child(OsStr::new("skills")).unwrap();
        let nominal = root.path().join("first");
        let preserved = root.path().join("first-created");
        let hook_entered = std::cell::Cell::new(false);
        let replacement_error = std::cell::Cell::new(None);

        let result = root.create_child_with_hook(OsStr::new("first"), |_| {
            hook_entered.set(true);
            let nominal_wide = nominal
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let preserved_wide = preserved
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let moved = unsafe {
                winapi::um::winbase::MoveFileExW(nominal_wide.as_ptr(), preserved_wide.as_ptr(), 0)
            };
            if moved != 0 {
                panic!("the created directory must reject replacement before binding");
            }
            replacement_error.set(Some(unsafe {
                winapi::um::errhandlingapi::GetLastError() as i32
            }));
            Ok(())
        });

        let (mut created, was_created) = match result {
            Ok(result) => result,
            Err(error) => panic!("the post-create hook did not run: {error}"),
        };
        assert!(was_created, "the test directory was not newly created");
        assert!(hook_entered.get(), "the post-create hook did not run");
        assert!(
            matches!(
                replacement_error.get(),
                Some(error) if error == winapi::shared::winerror::ERROR_ACCESS_DENIED as i32
                    || error == winapi::shared::winerror::ERROR_SHARING_VIOLATION as i32
            ),
            "unexpected Windows replacement error: {:?}",
            replacement_error.get()
        );
        assert!(nominal.is_dir());
        assert!(created.owned_for_test());
        assert!(
            !preserved.exists(),
            "a denied rename must not create the replacement path"
        );
        assert_eq!(
            opened_file_path(created.handle_for_test().unwrap(), &nominal).unwrap(),
            nominal.canonicalize().unwrap()
        );
        created.remove_owned().unwrap();
        assert!(!nominal.exists());
        assert!(!preserved.exists());
        assert_eq!(fs::read(outside_sentinel).unwrap(), b"must survive");
    }

    #[cfg(unix)]
    #[test]
    fn skill_rollback_preserves_a_direct_file_replacement() {
        let target = TempDir::new().unwrap();
        let installed_file = target.path().join("skills/first/SKILL.md");
        let preserved_file = target.path().join("skills/first/SKILL-installed.md");
        let config = SecureDirectory::open_config(target.path()).unwrap();
        let (root, _) = config.create_child(OsStr::new("skills")).unwrap();
        let (skill, _) = root.create_child(OsStr::new("first")).unwrap();
        let mut file = SecureFile::create(&skill, OsStr::new("SKILL.md")).unwrap();
        file.write_all(b"installed bytes").unwrap();
        let mut installed = InstalledSkills {
            directories: vec![config, root, skill],
            files: vec![file],
            committed: false,
        };
        fs::rename(&installed_file, &preserved_file).unwrap();
        fs::write(&installed_file, b"replacement bytes").unwrap();

        assert!(installed.rollback().is_err());
        assert_eq!(fs::read(&installed_file).unwrap(), b"replacement bytes");
    }

    #[cfg(unix)]
    #[test]
    fn skill_rollback_preserves_a_direct_empty_directory_replacement() {
        let target = TempDir::new().unwrap();
        let installed_directory = target.path().join("skills/first");
        let preserved_directory = target.path().join("skills/first-installed");
        let config = SecureDirectory::open_config(target.path()).unwrap();
        let (root, _) = config.create_child(OsStr::new("skills")).unwrap();
        let (skill, _) = root.create_child(OsStr::new("first")).unwrap();
        let mut installed = InstalledSkills {
            directories: vec![config, root, skill],
            files: Vec::new(),
            committed: false,
        };
        fs::rename(&installed_directory, &preserved_directory).unwrap();
        fs::create_dir(&installed_directory).unwrap();

        assert!(installed.rollback().is_err());
        assert!(installed_directory.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn unix_directory_creation_does_not_remove_a_replacement_after_open_rejection() {
        let target = TempDir::new().unwrap();
        let config = SecureDirectory::open_config(target.path()).unwrap();
        let (root, _) = config.create_child(OsStr::new("skills")).unwrap();
        let nominal = root.path().join("first");
        let preserved = root.path().join("first-created");

        let error = match root.create_child_with_hook(OsStr::new("first"), |_| {
            fs::rename(&nominal, &preserved)?;
            fs::create_dir(&nominal)?;
            Ok(())
        }) {
            Ok(_) => panic!("a direct replacement before secure open must be rejected"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("rollback did not complete"));
        assert!(
            nominal.is_dir(),
            "replacement directory must survive cleanup"
        );
        assert!(
            preserved.is_dir(),
            "created directory must not be followed by cleanup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_skill_installation_rejects_a_move_after_final_confirmation_before_mutation() {
        let container = TempDir::new().unwrap();
        let target_config = container.path().join("config");
        let preserved_config = container.path().join("config-moved");
        fs::create_dir(&target_config).unwrap();
        let skills = vec![AuthorizedSkill {
            name: PathBuf::from("reviewer"),
            files: vec![AuthorizedSkillFile {
                relative_path: PathBuf::from("SKILL.md"),
                bytes: b"must never be written after a move".to_vec(),
            }],
        }];
        let hook_completed = std::cell::Cell::new(false);
        let mut imported = 0;
        let mut skipped = 0;

        let error = match install_authorized_skills_with_hooks(
            &skills,
            &target_config,
            &mut imported,
            &mut skipped,
            |point| {
                if matches!(point, SkillInstallHookPoint::BeforeUnixMutation) {
                    fs::rename(&target_config, &preserved_config)?;
                    fs::create_dir(&target_config)?;
                    hook_completed.set(true);
                }
                Ok(())
            },
        ) {
            Ok(_) => panic!("a moved Unix configuration directory must fail closed"),
            Err(error) => error,
        };

        assert!(
            hook_completed.get(),
            "the final-confirmation hook did not complete"
        );
        assert!(error.to_string().contains("identity changed"));
        assert!(!target_config.join("skills").exists());
        assert!(!preserved_config.join("skills").exists());
    }

    #[tokio::test]
    async fn apply_goose_config_model_only_skips_provider_activation() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_config = source.path().join(CONFIG_YAML_NAME);
        fs::write(&source_config, "GOOSE_MODEL: gpt-5.1\n").unwrap();

        let target_config = Config::new_with_file_secrets(
            target.path().join(CONFIG_YAML_NAME),
            target.path().join("secrets.yaml"),
        )
        .unwrap();

        let (_, authorization) = authorize_goose_config_candidate(&source_config).unwrap();
        let result = apply_goose_config_candidate(&target_config, target.path(), &authorization)
            .await
            .unwrap();

        assert_eq!(result.imported.providers, 0);
        assert!(target_config.get_goose_provider().is_err());
        assert!(!target.path().join("skills").exists());
    }

    #[tokio::test]
    async fn apply_goose_config_rejects_model_from_another_provider_before_persistence() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let source_config = source.path().join(CONFIG_YAML_NAME);
        fs::write(
            &source_config,
            "GOOSE_PROVIDER: claude-acp\nGOOSE_MODEL: glm-5.2\n",
        )
        .unwrap();

        let target_path = target.path().join(CONFIG_YAML_NAME);
        fs::write(&target_path, "# original bytes\nGOOSE_MODEL: current\n").unwrap();
        let target_config =
            Config::new_with_file_secrets(target_path.clone(), target.path().join("secrets.yaml"))
                .unwrap();
        let before = fs::read(&target_path).unwrap();
        let (_, authorization) = authorize_goose_config_candidate(&source_config).unwrap();

        let error =
            match apply_goose_config_candidate(&target_config, target.path(), &authorization).await
            {
                Ok(_) => panic!("cross-provider stale model must be rejected"),
                Err(error) => error,
            };

        assert!(error.to_string().contains("model is not supported"));
        assert_eq!(fs::read(&target_path).unwrap(), before);
        assert!(!target.path().join("secrets.yaml").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unix_skill_installation_rejects_valid_skills_without_partial_creation() {
        let target = TempDir::new().unwrap();
        fs::write(target.path().join("preserved.txt"), b"keep").unwrap();
        let skills = vec![AuthorizedSkill {
            name: PathBuf::from("reviewer"),
            files: vec![AuthorizedSkillFile {
                relative_path: PathBuf::from("SKILL.md"),
                bytes: b"# Reviewer".to_vec(),
            }],
        }];
        let mut imported = 0;
        let mut skipped = 0;
        let error =
            match install_authorized_skills(&skills, target.path(), &mut imported, &mut skipped) {
                Ok(_) => panic!("Unix skill installation must remain unavailable"),
                Err(error) => error,
            };
        assert!(error.to_string().contains("unavailable on Unix"));
        assert_eq!((imported, skipped), (0, 0));
        assert!(!target.path().join("skills").exists());
        assert_eq!(
            fs::read(target.path().join("preserved.txt")).unwrap(),
            b"keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn skill_snapshot_skips_symlink_cycles() {
        let source = TempDir::new().unwrap();
        let skill_dir = source.path().join("reviewer");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Reviewer").unwrap();
        std::os::unix::fs::symlink(&skill_dir, skill_dir.join("loop")).unwrap();

        let skills = snapshot_skill_dirs(source.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, PathBuf::from("reviewer"));
        assert_eq!(skills[0].files.len(), 1);
        assert_eq!(skills[0].files[0].relative_path, PathBuf::from("SKILL.md"));
        assert_eq!(skills[0].files[0].bytes, b"# Reviewer");
    }
}
