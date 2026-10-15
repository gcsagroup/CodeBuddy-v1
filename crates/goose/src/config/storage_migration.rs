use crate::config::codebuddy_paths::{CodeBuddyPaths, CURRENT_STORAGE_LAYOUT_VERSION};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

const LEGACY_STORAGE_LAYOUT_VERSION: u32 = 0;

#[path = "storage_migration_execution.rs"]
mod execution;
pub use execution::{
    MigrationFailpoint, MigrationReportStatus, StorageMigrationReport, StorageMigrator,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyDiscoveryEnv {
    pub app_data: PathBuf,
    pub local_app_data: PathBuf,
    pub user_profile: PathBuf,
    pub goose_path_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyRootKind {
    #[serde(rename = "roaming_code_agent_pro", alias = "roaming_code_buddy")]
    RoamingCodeBuddy,
    #[serde(rename = "local_code_agent_pro", alias = "local_code_buddy")]
    LocalCodeBuddy,
    BlockGoose,
    AgentsHome,
    GoosePathRoot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacySource {
    id: String,
    kind: LegacyRootKind,
    root: PathBuf,
}

impl LegacySource {
    pub fn new(id: impl Into<String>, kind: LegacyRootKind, root: PathBuf) -> Self {
        Self {
            id: id.into(),
            kind,
            root,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn kind(&self) -> LegacyRootKind {
        self.kind
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageDataClass {
    DeviceConfig,
    ProfileConfig,
    Session,
    Run,
    Memory,
    ProjectSource,
    Audit,
    ProviderSecretState,
    TlsState,
    Model,
    Agent,
    Skill,
    Prompt,
    Recipe,
    PluginPackage,
    ElectronPersistentState,
    LegacyLog,
    RebuildableCache,
    InstallerArtifact,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationDisposition {
    Copy,
    Deduplicate,
    Conflict,
    LegacyUnclassified,
    SkipRebuildable,
    RejectBoundaryEscape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationState {
    Planned,
    Copying,
    Verifying,
    ReadyToCommit,
    Committed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappingRule {
    pub source: LegacyRootKind,
    pub relative_prefix: &'static str,
    pub target_prefix: &'static str,
    pub data_class: StorageDataClass,
    pub migration: MigrationDisposition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacySourceFingerprint {
    pub source_id: String,
    pub kind: LegacyRootKind,
    pub root: PathBuf,
    pub file_count: u64,
    pub total_bytes: u64,
    pub digest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageMigrationItem {
    source_id: String,
    source_relative_path: PathBuf,
    target_relative_path: Option<PathBuf>,
    data_class: StorageDataClass,
    disposition: MigrationDisposition,
    size: u64,
    digest_sha256: Option<String>,
}

impl StorageMigrationItem {
    pub fn source_id(&self) -> &str {
        &self.source_id
    }

    pub fn source_relative_path(&self) -> &Path {
        &self.source_relative_path
    }

    pub fn target_relative_path(&self) -> Option<&Path> {
        self.target_relative_path.as_deref()
    }

    pub fn data_class(&self) -> StorageDataClass {
        self.data_class
    }

    pub fn disposition(&self) -> MigrationDisposition {
        self.disposition
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn digest_sha256(&self) -> Option<&str> {
        self.digest_sha256.as_deref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageMigrationPlan {
    migration_id: Uuid,
    target_root: PathBuf,
    sources: Vec<LegacySource>,
    source_fingerprints: Vec<LegacySourceFingerprint>,
    items: Vec<StorageMigrationItem>,
}

impl StorageMigrationPlan {
    pub fn migration_id(&self) -> Uuid {
        self.migration_id
    }

    pub fn target_root(&self) -> &Path {
        &self.target_root
    }

    pub fn source_fingerprints(&self) -> &[LegacySourceFingerprint] {
        &self.source_fingerprints
    }

    pub fn items(&self) -> &[StorageMigrationItem] {
        &self.items
    }

    pub fn item_with_source_suffix(
        &self,
        suffix: impl AsRef<Path>,
    ) -> Option<&StorageMigrationItem> {
        let suffix = suffix.as_ref();
        self.items
            .iter()
            .find(|item| item.source_relative_path.ends_with(suffix))
    }

    pub fn items_for_target(&self, target: impl AsRef<Path>) -> Vec<&StorageMigrationItem> {
        let target = target.as_ref();
        self.items
            .iter()
            .filter(|item| item.target_relative_path.as_deref() == Some(target))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageMigrationRecord {
    pub migration_id: Uuid,
    pub from_layout: u32,
    pub to_layout: u32,
    pub target_root: PathBuf,
    pub sources: Vec<LegacySourceFingerprint>,
    pub state: MigrationState,
    pub manifest_path: PathBuf,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub redacted_error: Option<String>,
}

impl StorageMigrationRecord {
    pub fn planned(plan: &StorageMigrationPlan, target_root: PathBuf) -> Self {
        let now = Utc::now();
        Self {
            migration_id: plan.migration_id,
            from_layout: LEGACY_STORAGE_LAYOUT_VERSION,
            to_layout: CURRENT_STORAGE_LAYOUT_VERSION,
            target_root: target_root.clone(),
            sources: plan.source_fingerprints.clone(),
            state: MigrationState::Planned,
            manifest_path: target_root
                .join("migrations")
                .join("manifests")
                .join(format!("{}.jsonl", plan.migration_id)),
            started_at: now,
            updated_at: now,
            redacted_error: None,
        }
    }
}

pub fn discover_legacy_sources(
    paths: &CodeBuddyPaths,
    env: &LegacyDiscoveryEnv,
) -> Result<Vec<LegacySource>> {
    let candidates = [
        (
            "roaming-codeagentpro",
            LegacyRootKind::RoamingCodeBuddy,
            env.app_data.join("CodeAgentPro"),
        ),
        (
            "local-codeagentpro",
            LegacyRootKind::LocalCodeBuddy,
            env.local_app_data.join("CodeAgentPro"),
        ),
        (
            "roaming-codebuddy",
            LegacyRootKind::RoamingCodeBuddy,
            env.app_data.join("CodeBuddy"),
        ),
        (
            "local-codebuddy",
            LegacyRootKind::LocalCodeBuddy,
            env.local_app_data.join("CodeBuddy"),
        ),
        (
            "block-goose",
            LegacyRootKind::BlockGoose,
            env.local_app_data.join("Block").join("goose"),
        ),
        (
            "agents-home",
            LegacyRootKind::AgentsHome,
            env.user_profile.join(".agents"),
        ),
    ];

    let target = canonical_if_exists(paths.home_dir())?;
    let mut seen = BTreeSet::new();
    let mut sources = Vec::new();
    for (id, kind, root) in candidates {
        add_discovered_source(&mut sources, &mut seen, &target, id, kind, root)?;
    }
    if let Some(root) = &env.goose_path_root {
        add_discovered_source(
            &mut sources,
            &mut seen,
            &target,
            "goose-path-root",
            LegacyRootKind::GoosePathRoot,
            root.clone(),
        )?;
    }
    Ok(sources)
}

fn add_discovered_source(
    sources: &mut Vec<LegacySource>,
    seen: &mut BTreeSet<PathBuf>,
    target: &Path,
    id: &str,
    kind: LegacyRootKind,
    root: PathBuf,
) -> Result<()> {
    if !root.is_dir() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&root)
        .with_context(|| format!("failed to inspect legacy source {}", root.display()))?;
    if is_link_or_reparse_point(&metadata) {
        bail!(
            "legacy source root must not be a link or reparse point: {}",
            root.display()
        );
    }
    let canonical = fs::canonicalize(&root)
        .with_context(|| format!("failed to resolve legacy source {}", root.display()))?;
    if canonical == target || !seen.insert(canonical.clone()) {
        return Ok(());
    }
    sources.push(LegacySource::new(id, kind, canonical));
    Ok(())
}

fn canonical_if_exists(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path)
            .with_context(|| format!("failed to resolve target root {}", path.display()));
    }
    Ok(path.to_path_buf())
}

pub fn plan_migration(
    paths: &CodeBuddyPaths,
    sources: &[LegacySource],
) -> Result<StorageMigrationPlan> {
    let mut items = Vec::new();
    let mut fingerprints = Vec::new();
    for source in sources {
        validate_source(source, paths.home_dir())?;
        let entries = scan_source(source)?;
        fingerprints.push(fingerprint(source, &entries));
        for entry in entries {
            items.push(classify_entry(source, entry));
        }
    }

    items.sort_by(|left, right| {
        left.target_relative_path
            .cmp(&right.target_relative_path)
            .then_with(|| left.source_id.cmp(&right.source_id))
            .then_with(|| left.source_relative_path.cmp(&right.source_relative_path))
    });
    classify_existing_targets(paths.home_dir(), &mut items)?;
    classify_duplicates_and_conflicts(&mut items);

    Ok(StorageMigrationPlan {
        migration_id: Uuid::now_v7(),
        target_root: paths.home_dir().to_path_buf(),
        sources: sources.to_vec(),
        source_fingerprints: fingerprints,
        items,
    })
}

pub fn validate_plan_sources(plan: &StorageMigrationPlan) -> Result<()> {
    if plan.sources.len() != plan.source_fingerprints.len() {
        bail!("migration plan source inventory is inconsistent");
    }
    let mut source_ids = BTreeSet::new();
    let mut authoritative_items = Vec::new();
    for (source, expected) in plan.sources.iter().zip(&plan.source_fingerprints) {
        validate_source(source, &plan.target_root)?;
        if !source_ids.insert(source.id.clone()) {
            bail!("migration plan contains duplicate source ids");
        }
        if expected.source_id != source.id
            || expected.kind != source.kind
            || expected.root != source.root
        {
            bail!("migration plan source fingerprint identity is inconsistent");
        }
        let entries = scan_source(source)?;
        let actual = fingerprint(source, &entries);
        if &actual != expected {
            bail!("source changed after migration planning: {}", source.id);
        }
        for entry in entries {
            authoritative_items.push(classify_entry(source, entry));
        }
    }
    authoritative_items.sort_by(|left, right| {
        left.target_relative_path
            .cmp(&right.target_relative_path)
            .then_with(|| left.source_id.cmp(&right.source_id))
            .then_with(|| left.source_relative_path.cmp(&right.source_relative_path))
    });
    classify_duplicates_and_conflicts(&mut authoritative_items);
    let mut expected_items = BTreeMap::new();
    for item in authoritative_items {
        let key = (item.source_id.clone(), item.source_relative_path.clone());
        if expected_items.insert(key, item).is_some() {
            bail!("migration plan contains duplicate source paths");
        }
    }
    if plan.items.len() != expected_items.len() {
        bail!("migration plan item inventory is inconsistent");
    }
    for item in &plan.items {
        let key = (item.source_id.clone(), item.source_relative_path.clone());
        let Some(expected) = expected_items.remove(&key) else {
            bail!("migration plan contains an unknown or duplicate item");
        };
        if item.target_relative_path != expected.target_relative_path
            || item.data_class != expected.data_class
            || item.size != expected.size
            || item.digest_sha256 != expected.digest_sha256
            || (expected.disposition != item.disposition && !target_proves_disposition(plan, item)?)
        {
            bail!("migration plan item does not match authoritative mapping");
        }
    }
    Ok(())
}

fn target_proves_disposition(
    plan: &StorageMigrationPlan,
    item: &StorageMigrationItem,
) -> Result<bool> {
    let Some(relative) = &item.target_relative_path else {
        return Ok(false);
    };
    if !is_safe_relative(relative) {
        return Ok(false);
    }
    let target = plan.target_root.join(relative);
    if !target.is_file() {
        return Ok(false);
    }
    let Some(source_digest) = &item.digest_sha256 else {
        return Ok(false);
    };
    let target_digest = hash_file(&target)?;
    Ok(match item.disposition {
        MigrationDisposition::Deduplicate => target_digest == *source_digest,
        MigrationDisposition::Conflict => target_digest != *source_digest,
        _ => false,
    })
}

pub fn write_migration_record(
    paths: &CodeBuddyPaths,
    record: &StorageMigrationRecord,
) -> Result<PathBuf> {
    let migrations = paths.migrations_dir();
    fs::create_dir_all(&migrations)?;
    let destination = migrations.join("migration.json");
    let mut temporary = tempfile::NamedTempFile::new_in(&migrations)?;
    serde_json::to_writer_pretty(&mut temporary, record)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(&destination)
        .map_err(|error| error.error)
        .with_context(|| format!("failed to publish {}", destination.display()))?;
    Ok(destination)
}

pub fn append_manifest_entry(
    paths: &CodeBuddyPaths,
    migration_id: Uuid,
    item: &StorageMigrationItem,
) -> Result<PathBuf> {
    let directory = paths.migrations_dir().join("manifests");
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{migration_id}.jsonl"));
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    serde_json::to_writer(&mut file, item)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    Ok(path)
}

fn validate_source(source: &LegacySource, target_root: &Path) -> Result<()> {
    if source.id.is_empty()
        || !source
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("legacy source id is not path-safe");
    }
    if !source.root.is_absolute() {
        bail!(
            "legacy source root must be absolute: {}",
            source.root.display()
        );
    }
    if source.root == target_root {
        bail!("legacy source must not equal the target root");
    }
    if source.root.starts_with(target_root) || target_root.starts_with(&source.root) {
        bail!(
            "legacy source and target roots must not overlap: {} -> {}",
            source.root.display(),
            target_root.display()
        );
    }
    let metadata = fs::symlink_metadata(&source.root)
        .with_context(|| format!("failed to inspect legacy source {}", source.root.display()))?;
    if is_link_or_reparse_point(&metadata) {
        bail!(
            "legacy source root must not be a link or reparse point: {}",
            source.root.display()
        );
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct ScannedEntry {
    relative_path: PathBuf,
    size: u64,
    digest_sha256: Option<String>,
    boundary_escape: bool,
}

fn scan_source(source: &LegacySource) -> Result<Vec<ScannedEntry>> {
    if !source.root.is_dir() {
        bail!(
            "legacy source is not a directory: {}",
            source.root.display()
        );
    }
    let mut entries = Vec::new();
    scan_directory(source, &source.root, &source.root, &mut entries)?;
    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(entries)
}

fn scan_directory(
    source: &LegacySource,
    root: &Path,
    directory: &Path,
    entries: &mut Vec<ScannedEntry>,
) -> Result<()> {
    let mut children = fs::read_dir(directory)
        .with_context(|| format!("failed to read legacy directory {}", directory.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name());

    for child in children {
        let path = child.path();
        let relative = path
            .strip_prefix(root)
            .with_context(|| format!("legacy path escaped source boundary: {}", path.display()))?
            .to_path_buf();
        let metadata = fs::symlink_metadata(&path)?;
        if is_link_or_reparse_point(&metadata) {
            entries.push(ScannedEntry {
                relative_path: relative,
                size: 0,
                digest_sha256: None,
                boundary_escape: true,
            });
        } else if metadata.is_dir() {
            scan_directory(source, root, &path, entries)?;
        } else if metadata.is_file() {
            let mapping = map_relative(source, &relative);
            let digest_sha256 = if mapping.disposition == MigrationDisposition::SkipRebuildable {
                None
            } else {
                Some(hash_file(&path)?)
            };
            entries.push(ScannedEntry {
                relative_path: relative,
                size: metadata.len(),
                digest_sha256,
                boundary_escape: false,
            });
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn hash_file(path: &Path) -> Result<String> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(encode_digest(&hasher.finalize()))
}

fn fingerprint(source: &LegacySource, entries: &[ScannedEntry]) -> LegacySourceFingerprint {
    let mut digest = Sha256::new();
    let mut file_count = 0_u64;
    let mut total_bytes = 0_u64;
    for entry in entries {
        digest.update(path_key(&entry.relative_path).as_bytes());
        digest.update([0]);
        digest.update(entry.size.to_le_bytes());
        digest.update([entry.boundary_escape as u8]);
        if !entry.boundary_escape {
            file_count += 1;
            total_bytes += entry.size;
        }
        if let Some(hash) = &entry.digest_sha256 {
            digest.update(hash.as_bytes());
        }
    }
    LegacySourceFingerprint {
        source_id: source.id.clone(),
        kind: source.kind,
        root: source.root.clone(),
        file_count,
        total_bytes,
        digest_sha256: encode_digest(&digest.finalize()),
    }
}

fn encode_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn classify_entry(source: &LegacySource, entry: ScannedEntry) -> StorageMigrationItem {
    if entry.boundary_escape || !is_safe_relative(&entry.relative_path) {
        return StorageMigrationItem {
            source_id: source.id.clone(),
            source_relative_path: entry.relative_path,
            target_relative_path: None,
            data_class: StorageDataClass::Unknown,
            disposition: MigrationDisposition::RejectBoundaryEscape,
            size: entry.size,
            digest_sha256: entry.digest_sha256,
        };
    }

    let mapping = map_relative(source, &entry.relative_path);
    StorageMigrationItem {
        source_id: source.id.clone(),
        source_relative_path: entry.relative_path,
        target_relative_path: mapping.target,
        data_class: mapping.data_class,
        disposition: mapping.disposition,
        size: entry.size,
        digest_sha256: entry.digest_sha256,
    }
}

fn is_safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

struct Mapping {
    target: Option<PathBuf>,
    data_class: StorageDataClass,
    disposition: MigrationDisposition,
}

impl Mapping {
    fn copy(target: PathBuf, data_class: StorageDataClass) -> Self {
        Self {
            target: Some(target),
            data_class,
            disposition: MigrationDisposition::Copy,
        }
    }

    fn skip(data_class: StorageDataClass) -> Self {
        Self {
            target: None,
            data_class,
            disposition: MigrationDisposition::SkipRebuildable,
        }
    }

    fn unknown(source: &LegacySource, relative: &Path) -> Self {
        Self {
            target: Some(
                PathBuf::from("migrations/legacy-unclassified")
                    .join(&source.id)
                    .join(relative),
            ),
            data_class: StorageDataClass::Unknown,
            disposition: MigrationDisposition::LegacyUnclassified,
        }
    }

    fn from_rule(source: &LegacySource, rule: MappingRule, rest: PathBuf) -> Self {
        debug_assert_eq!(source.kind, rule.source);
        if rule.migration == MigrationDisposition::SkipRebuildable {
            return Self::skip(rule.data_class);
        }
        Self {
            target: Some(PathBuf::from(rule.target_prefix).join(rest)),
            data_class: rule.data_class,
            disposition: rule.migration,
        }
    }
}

fn map_relative(source: &LegacySource, relative: &Path) -> Mapping {
    match source.kind {
        LegacyRootKind::RoamingCodeBuddy => map_roaming(source, relative),
        LegacyRootKind::LocalCodeBuddy => map_local(source, relative),
        LegacyRootKind::AgentsHome => map_agents(source, relative),
        LegacyRootKind::BlockGoose | LegacyRootKind::GoosePathRoot => {
            map_goose_root(source, relative)
        }
    }
}

fn map_roaming(source: &LegacySource, relative: &Path) -> Mapping {
    let key = path_key(relative);
    if key == "settings.json" {
        return Mapping::copy(
            PathBuf::from("config/app.json"),
            StorageDataClass::DeviceConfig,
        );
    }
    if matches!(key.as_str(), "recent-dirs.json" | "window-state.json") {
        return Mapping::copy(
            PathBuf::from("state/electron-app").join(relative),
            StorageDataClass::DeviceConfig,
        );
    }
    if let Some(rest) = strip_key(relative, "backend/config") {
        return map_backend_config(source, &rest);
    }
    if let Some(rest) = strip_key(relative, "backend/data") {
        return map_backend_data(source, &rest);
    }
    if let Some(rest) = strip_key(relative, "backend/state") {
        return map_backend_state(source, &rest);
    }
    if let Some(rest) = strip_key(relative, "partitions/goose") {
        if is_cache_path(&rest) {
            return Mapping::skip(StorageDataClass::RebuildableCache);
        }
        return Mapping::copy(
            PathBuf::from("profiles/local/state/electron").join(rest),
            StorageDataClass::ElectronPersistentState,
        );
    }
    if is_cache_path(relative) {
        return Mapping::skip(StorageDataClass::RebuildableCache);
    }
    if let Some(rest) = strip_key(relative, "logs") {
        return legacy_log(source, &rest);
    }
    Mapping::unknown(source, relative)
}

fn map_local(source: &LegacySource, relative: &Path) -> Mapping {
    if let Some(rest) = strip_key(relative, "codepro-runs") {
        return Mapping::copy(
            PathBuf::from("profiles/local/runs").join(rest),
            StorageDataClass::Run,
        );
    }
    if let Some(rest) = strip_key(relative, "project-memory") {
        return Mapping::copy(
            PathBuf::from("profiles/local/memory").join(rest),
            StorageDataClass::Memory,
        );
    }
    let key = path_key(relative);
    if key == "update.exe"
        || strip_key(relative, "bin").is_some()
        || strip_key(relative, "updates").is_some()
        || strip_key(relative, "packages").is_some()
    {
        return Mapping::skip(StorageDataClass::InstallerArtifact);
    }
    if let Some(rest) = strip_key(relative, "logs") {
        return legacy_log(source, &rest);
    }
    Mapping::unknown(source, relative)
}

fn map_agents(source: &LegacySource, relative: &Path) -> Mapping {
    if let Some(rest) = strip_key(relative, "plugins") {
        return Mapping::copy(
            PathBuf::from("plugins/packages").join(rest),
            StorageDataClass::PluginPackage,
        );
    }
    if let Some(rest) = strip_key(relative, "agents") {
        return Mapping::copy(
            PathBuf::from("profiles/local/agents").join(rest),
            StorageDataClass::Agent,
        );
    }
    if let Some(rest) = strip_key(relative, "skills") {
        return Mapping::copy(
            PathBuf::from("profiles/local/skills").join(rest),
            StorageDataClass::Skill,
        );
    }
    Mapping::unknown(source, relative)
}

fn map_goose_root(source: &LegacySource, relative: &Path) -> Mapping {
    if let Some(rest) = strip_key(relative, "config") {
        return map_backend_config(source, &rest);
    }
    if let Some(rest) = strip_key(relative, "data") {
        return map_backend_data(source, &rest);
    }
    if let Some(rest) = strip_key(relative, "state") {
        return map_backend_state(source, &rest);
    }
    if let Some(rest) = strip_key(relative, ".agents") {
        return map_agents(source, &rest);
    }
    Mapping::unknown(source, relative)
}

fn map_backend_config(source: &LegacySource, relative: &Path) -> Mapping {
    let key = path_key(relative);
    if key == "config.yaml" {
        return Mapping::copy(
            PathBuf::from("profiles/local/config/config.yaml"),
            StorageDataClass::ProfileConfig,
        );
    }
    for prefix in ["permissions", "custom_providers"] {
        if let Some(rest) = strip_key(relative, prefix) {
            return Mapping::copy(
                PathBuf::from("profiles/local/config")
                    .join(prefix)
                    .join(rest),
                StorageDataClass::ProfileConfig,
            );
        }
    }
    for (prefix, target, class) in [
        ("agents", "profiles/local/agents", StorageDataClass::Agent),
        ("skills", "profiles/local/skills", StorageDataClass::Skill),
        (
            "prompts",
            "profiles/local/prompts",
            StorageDataClass::Prompt,
        ),
        (
            "recipes",
            "profiles/local/recipes",
            StorageDataClass::Recipe,
        ),
    ] {
        if let Some(rest) = strip_key(relative, prefix) {
            return Mapping::copy(PathBuf::from(target).join(rest), class);
        }
    }
    if let Some(rest) = strip_key(relative, "tls") {
        return Mapping::copy(
            PathBuf::from("profiles/local/state/tls").join(rest),
            StorageDataClass::TlsState,
        );
    }
    for prefix in ["chatgpt_codex", "gemini_oauth", "xai_oauth"] {
        if let Some(rest) = strip_key(relative, prefix) {
            return Mapping::copy(
                PathBuf::from("profiles/local/state/providers")
                    .join(prefix)
                    .join(rest),
                StorageDataClass::ProviderSecretState,
            );
        }
    }
    Mapping::unknown(source, relative)
}

fn map_backend_data(source: &LegacySource, relative: &Path) -> Mapping {
    if is_sqlite_sidecar(relative) {
        // A WAL/SHM file is not an independent database. The executor folds it
        // into a consistent SQLite snapshot of the primary database instead of
        // copying a mutable sidecar byte-for-byte.
        return Mapping::skip(StorageDataClass::Session);
    }
    let rules = [
        MappingRule {
            source: source.kind,
            relative_prefix: "sessions",
            target_prefix: "profiles/local/sessions",
            data_class: StorageDataClass::Session,
            migration: MigrationDisposition::Copy,
        },
        MappingRule {
            source: source.kind,
            relative_prefix: "projects",
            target_prefix: "profiles/local/projects/sources",
            data_class: StorageDataClass::ProjectSource,
            migration: MigrationDisposition::Copy,
        },
        MappingRule {
            source: source.kind,
            relative_prefix: "codepro-control",
            target_prefix: "profiles/local/runs/control-plane",
            data_class: StorageDataClass::Run,
            migration: MigrationDisposition::Copy,
        },
        MappingRule {
            source: source.kind,
            relative_prefix: "models",
            target_prefix: "profiles/local/models",
            data_class: StorageDataClass::Model,
            migration: MigrationDisposition::Copy,
        },
        MappingRule {
            source: source.kind,
            relative_prefix: "tool-audit-v1",
            target_prefix: "profiles/local/audit/tool-audit-v1",
            data_class: StorageDataClass::Audit,
            migration: MigrationDisposition::Copy,
        },
        MappingRule {
            source: source.kind,
            relative_prefix: "tool-audit-v2",
            target_prefix: "profiles/local/audit/tool-audit-v2",
            data_class: StorageDataClass::Audit,
            migration: MigrationDisposition::Copy,
        },
        MappingRule {
            source: source.kind,
            relative_prefix: "tool-idempotency",
            target_prefix: "profiles/local/audit/tool-idempotency",
            data_class: StorageDataClass::Audit,
            migration: MigrationDisposition::Copy,
        },
        MappingRule {
            source: source.kind,
            relative_prefix: "apps",
            target_prefix: "profiles/local/cache/mcp/apps",
            data_class: StorageDataClass::RebuildableCache,
            migration: MigrationDisposition::Copy,
        },
        MappingRule {
            source: source.kind,
            relative_prefix: "mcp-apps-cache",
            target_prefix: "profiles/local/cache/mcp/mcp-apps-cache",
            data_class: StorageDataClass::RebuildableCache,
            migration: MigrationDisposition::Copy,
        },
    ];
    for rule in rules {
        if let Some(rest) = strip_key(relative, rule.relative_prefix) {
            return Mapping::from_rule(source, rule, rest);
        }
    }
    if let Some(rest) = strip_key(relative, "logs") {
        return legacy_log(source, &rest);
    }
    Mapping::unknown(source, relative)
}

fn is_sqlite_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".db-wal") || name.ends_with(".db-shm"))
}

fn map_backend_state(source: &LegacySource, relative: &Path) -> Mapping {
    if let Some(rest) = strip_key(relative, "logs") {
        return legacy_log(source, &rest);
    }
    Mapping::unknown(source, relative)
}

fn legacy_log(source: &LegacySource, rest: &Path) -> Mapping {
    Mapping::copy(
        PathBuf::from("logs/legacy").join(&source.id).join(rest),
        StorageDataClass::LegacyLog,
    )
}

fn is_cache_path(path: &Path) -> bool {
    let Some(first) = path.components().next() else {
        return false;
    };
    let Component::Normal(first) = first else {
        return false;
    };
    matches!(
        first.to_string_lossy().to_ascii_lowercase().as_str(),
        "cache"
            | "code cache"
            | "gpucache"
            | "dawngraphitecache"
            | "dawnwebgpucache"
            | "shadercache"
            | "grshadercache"
    )
}

fn strip_key(path: &Path, prefix: &str) -> Option<PathBuf> {
    let prefix_components = prefix.split('/').collect::<Vec<_>>();
    let path_components = path.components().collect::<Vec<_>>();
    if path_components.len() < prefix_components.len() {
        return None;
    }
    for (component, expected) in path_components.iter().zip(&prefix_components) {
        let Component::Normal(actual) = component else {
            return None;
        };
        if !actual.to_string_lossy().eq_ignore_ascii_case(expected) {
            return None;
        }
    }
    let mut rest = PathBuf::new();
    for component in path_components.into_iter().skip(prefix_components.len()) {
        rest.push(component.as_os_str());
    }
    Some(rest)
}

fn path_key(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn classify_existing_targets(target_root: &Path, items: &mut [StorageMigrationItem]) -> Result<()> {
    for item in items.iter_mut() {
        if !matches!(
            item.disposition,
            MigrationDisposition::Copy | MigrationDisposition::LegacyUnclassified
        ) {
            continue;
        }
        let Some(relative) = &item.target_relative_path else {
            continue;
        };
        let target = target_root.join(relative);
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if is_link_or_reparse_point(&metadata) || !metadata.is_file() {
            item.disposition = MigrationDisposition::Conflict;
            continue;
        }
        let target_digest = hash_file(&target)?;
        item.disposition = if item.digest_sha256.as_deref() == Some(target_digest.as_str()) {
            MigrationDisposition::Deduplicate
        } else {
            MigrationDisposition::Conflict
        };
    }
    Ok(())
}

fn classify_duplicates_and_conflicts(items: &mut [StorageMigrationItem]) {
    let mut groups = BTreeMap::<PathBuf, Vec<usize>>::new();
    for (index, item) in items.iter().enumerate() {
        if let Some(target) = &item.target_relative_path {
            if !matches!(
                item.disposition,
                MigrationDisposition::SkipRebuildable | MigrationDisposition::RejectBoundaryEscape
            ) {
                groups.entry(target.clone()).or_default().push(index);
            }
        }
    }

    for indexes in groups.into_values() {
        if indexes.len() < 2 {
            continue;
        }
        let hashes = indexes
            .iter()
            .filter_map(|index| items[*index].digest_sha256.as_deref())
            .collect::<BTreeSet<_>>();
        if hashes.len() != 1
            || indexes
                .iter()
                .any(|index| items[*index].disposition == MigrationDisposition::Conflict)
        {
            for index in indexes {
                items[index].disposition = MigrationDisposition::Conflict;
            }
            continue;
        }
        for index in indexes.into_iter().skip(1) {
            items[index].disposition = MigrationDisposition::Deduplicate;
        }
    }
}
