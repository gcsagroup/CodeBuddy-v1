use super::{parse_skill_content, validate_skill_name, SkillFrontmatter};
use crate::config::paths::Paths;
use crate::plugins::installed_plugin_skill_dirs;
use agent_client_protocol::Error;
use chrono::{Duration as ChronoDuration, Utc};
use goose_sdk_types::custom_requests::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

const PREVIEW_LIFETIME: Duration = Duration::from_secs(300);
const RECOVERY_MANIFEST: &str = "recovery.json";
const RECOVERY_PAYLOAD: &str = "payload";

#[derive(Clone)]
struct Root {
    kind: SkillRootKind,
    id: String,
    path: Option<PathBuf>,
    read_only: bool,
}

struct PendingPreview {
    owner: Uuid,
    expires: Instant,
    response: SkillManagementPreviewResponse,
    change: SkillManagementOperation,
    project_dir: Option<String>,
    import_fingerprint: Option<String>,
    confirmation_nonce: Option<String>,
    filesystem_identities: Vec<(PathBuf, String)>,
    download_stage: Option<DownloadStageCleanup>,
}

struct DownloadStageCleanup(PathBuf);

impl Drop for DownloadStageCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) struct SkillManagementApproval {
    owner: Uuid,
    preview_token: String,
    nonce: String,
}

struct ChangeInspection {
    operation: String,
    target: String,
    requires_confirmation: bool,
    has_conflict: bool,
    files: Vec<String>,
    diff: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryManifest {
    recovery_ref: String,
    source: SkillSourceRef,
    name: String,
    version: String,
    deleted_at: String,
    store_identity: String,
    payload_version: String,
}

pub struct SkillManagementService {
    owner: Uuid,
    global_root: PathBuf,
    previews: Mutex<HashMap<String, PendingPreview>>,
}

impl Default for SkillManagementService {
    fn default() -> Self {
        Self::new(Paths::skills_dir())
    }
}

impl SkillManagementService {
    pub fn new(global_root: PathBuf) -> Self {
        Self {
            owner: Uuid::new_v4(),
            global_root,
            previews: Mutex::new(HashMap::new()),
        }
    }

    fn roots(&self, project_dir: Option<&str>) -> Result<Vec<Root>, Error> {
        let mut roots = Vec::new();
        if let Some(project) = project_dir.map(str::trim).filter(|value| !value.is_empty()) {
            let canonical = Path::new(project)
                .canonicalize()
                .map_err(|_| invalid("project_not_found"))?;
            for (kind, leaf) in [
                (SkillRootKind::ProjectAgents, ".agents"),
                (SkillRootKind::ProjectGoose, ".goose"),
                (SkillRootKind::ProjectClaude, ".claude"),
            ] {
                roots.push(Root {
                    kind,
                    id: canonical.to_string_lossy().into_owned(),
                    path: Some(canonical.join(leaf).join("skills")),
                    read_only: false,
                });
            }
        }
        roots.push(Root {
            kind: SkillRootKind::Global,
            id: "global".into(),
            path: Some(self.global_root.clone()),
            read_only: false,
        });
        for path in installed_plugin_skill_dirs() {
            let id = path
                .canonicalize()
                .unwrap_or(path.clone())
                .to_string_lossy()
                .into_owned();
            roots.push(Root {
                kind: SkillRootKind::Plugin,
                id,
                path: Some(path),
                read_only: true,
            });
        }
        roots.push(Root {
            kind: SkillRootKind::Builtin,
            id: "builtin".into(),
            path: None,
            read_only: true,
        });
        Ok(roots)
    }

    fn prune_expired_previews(&self) {
        let now = Instant::now();
        self.previews
            .lock()
            .unwrap()
            .retain(|_, pending| now < pending.expires);
    }

    pub fn list(&self, project_dir: Option<&str>) -> Result<Vec<ManagedSkill>, Error> {
        let mut result = Vec::new();
        for root in self.roots(project_dir)? {
            if root.kind == SkillRootKind::Builtin {
                for raw in super::builtin::get_all() {
                    if let Some(source) = parse_skill_content(raw, Path::new(""), true) {
                        let display_path = format!("builtin/{}", source.name);
                        result.push(ManagedSkill {
                            source: SkillSourceRef {
                                root_kind: SkillRootKind::Builtin,
                                root_id: root.id.clone(),
                                relative_path: source.name.clone(),
                            },
                            name: source.name,
                            description: source.description,
                            scope: "builtin".into(),
                            read_only: true,
                            enabled: true,
                            display_path,
                            version: digest_bytes(raw.as_bytes()),
                            raw_document: raw.into(),
                            original_metadata: metadata_value(raw),
                            display_metadata: display_metadata(&source.properties)
                                .unwrap_or_default(),
                            companion_files: Vec::new(),
                        });
                    }
                }
                continue;
            }
            let Some(path) = root.path.as_deref() else {
                continue;
            };
            if !path.is_dir() {
                continue;
            }
            for dir in skill_directories(path)? {
                if let Ok(skill) = self.read_directory(&root, &dir) {
                    result.push(skill);
                }
            }
        }
        result.sort_by(|a, b| {
            (
                &a.name,
                &a.source.root_kind,
                &a.source.root_id,
                &a.source.relative_path,
            )
                .cmp(&(
                    &b.name,
                    &b.source.root_kind,
                    &b.source.root_id,
                    &b.source.relative_path,
                ))
        });
        Ok(result)
    }

    pub fn list_response(
        &self,
        project_dir: Option<&str>,
    ) -> Result<SkillManagementListResponse, Error> {
        self.prune_expired_previews();
        let destination_roots = self
            .roots(project_dir)?
            .into_iter()
            .filter(|root| !root.read_only)
            .filter_map(|root| {
                root.path.map(|path| SkillDestinationRoot {
                    root_kind: root.kind,
                    root_id: root.id,
                    display_path: path.to_string_lossy().into_owned(),
                    read_only: false,
                })
            })
            .collect();
        Ok(SkillManagementListResponse {
            skills: self.list(project_dir)?,
            destination_roots,
        })
    }

    pub fn read(
        &self,
        project_dir: Option<&str>,
        source: &SkillSourceRef,
    ) -> Result<ManagedSkill, Error> {
        if source.root_kind == SkillRootKind::Builtin {
            return self
                .list(project_dir)?
                .into_iter()
                .find(|skill| &skill.source == source)
                .ok_or_else(|| invalid("source_not_found"));
        }
        let root = self.resolve_root(project_dir, source)?;
        let dir = resolve_relative_existing(&root, &source.relative_path)?;
        self.read_directory(&root, &dir)
    }

    pub fn preview(
        &self,
        project_dir: Option<String>,
        change: SkillManagementOperation,
    ) -> Result<SkillManagementPreviewResponse, Error> {
        self.prune_expired_previews();
        let ChangeInspection {
            operation,
            target,
            requires_confirmation,
            has_conflict,
            files,
            diff,
        } = self.inspect_change(project_dir.as_deref(), &change)?;
        let token = Uuid::new_v4().simple().to_string();
        let response = SkillManagementPreviewResponse {
            preview_token: token.clone(),
            expires_at: (Utc::now() + ChronoDuration::seconds(PREVIEW_LIFETIME.as_secs() as i64))
                .to_rfc3339(),
            operation,
            target,
            requires_confirmation,
            has_conflict,
            files,
            diff,
        };
        let import_fingerprint = import_fingerprint(&change)?;
        let filesystem_identities = self.change_identities(project_dir.as_deref(), &change)?;
        self.previews.lock().unwrap().insert(
            token,
            PendingPreview {
                owner: self.owner,
                expires: Instant::now() + PREVIEW_LIFETIME,
                response: response.clone(),
                change,
                project_dir,
                import_fingerprint,
                confirmation_nonce: None,
                filesystem_identities,
                download_stage: None,
            },
        );
        Ok(response)
    }

    pub async fn preview_download(
        &self,
        project_dir: Option<String>,
        destination: SkillDestination,
        url: &str,
    ) -> Result<SkillManagementPreviewResponse, Error> {
        let staged = super::download::stage_download(url).await?;
        let change = SkillManagementOperation::ImportLocal {
            destination,
            source_path: staged.path.to_string_lossy().into_owned(),
        };
        let mut response = match self.preview(project_dir, change) {
            Ok(response) => response,
            Err(error) => {
                let _ = fs::remove_dir_all(staged.path);
                return Err(error);
            }
        };
        response.operation = "download".into();
        response.files = staged.files;
        response.diff = Some(format!("source: {}", staged.provenance));
        if let Some(pending) = self
            .previews
            .lock()
            .unwrap()
            .get_mut(&response.preview_token)
        {
            pending.response = response.clone();
            pending.download_stage = Some(DownloadStageCleanup(staged.path));
        } else {
            let _ = fs::remove_dir_all(staged.path);
            return Err(conflict("invalid_preview"));
        }
        Ok(response)
    }

    pub fn pending(&self, token: &str) -> Result<SkillManagementPreviewResponse, Error> {
        let previews = self.previews.lock().unwrap();
        let pending = previews
            .get(token)
            .ok_or_else(|| conflict("invalid_preview"))?;
        if pending.owner != self.owner || Instant::now() >= pending.expires {
            return Err(conflict("expired_preview"));
        }
        self.inspect_change(pending.project_dir.as_deref(), &pending.change)?;
        Ok(pending.response.clone())
    }

    pub(crate) fn confirmation_request(
        &self,
        token: &str,
    ) -> Result<RequestSkillManagementConfirmation, Error> {
        let mut previews = self.previews.lock().unwrap();
        let pending = previews
            .get_mut(token)
            .ok_or_else(|| conflict("invalid_preview"))?;
        if Instant::now() >= pending.expires || !pending.response.requires_confirmation {
            return Err(unauthorized("confirmation_not_available"));
        }
        let nonce = Uuid::new_v4().simple().to_string();
        pending.confirmation_nonce = Some(nonce.clone());
        let (source, expected_version) = operation_identity(&pending.change);
        Ok(RequestSkillManagementConfirmation {
            preview_token: token.to_string(),
            nonce,
            operation: pending.response.operation.clone(),
            target: pending.response.target.clone(),
            source,
            expected_version,
            expires_at: pending.response.expires_at.clone(),
        })
    }

    pub(crate) fn approve(
        &self,
        request: &RequestSkillManagementConfirmation,
        response: SkillManagementConfirmationResponse,
    ) -> Result<SkillManagementApproval, Error> {
        let mut previews = self.previews.lock().unwrap();
        let (valid_nonce, expired) = {
            let pending = previews
                .get(&request.preview_token)
                .ok_or_else(|| conflict("invalid_preview"))?;
            (
                pending.confirmation_nonce.as_deref() == Some(response.nonce.as_str())
                    && request.nonce == response.nonce,
                Instant::now() >= pending.expires,
            )
        };
        if response.decision == SkillManagementConfirmationDecision::Cancel
            || !valid_nonce
            || expired
        {
            previews.remove(&request.preview_token);
            return Err(unauthorized(
                if response.decision == SkillManagementConfirmationDecision::Cancel {
                    "confirmation_cancelled"
                } else {
                    "invalid_confirmation"
                },
            ));
        }
        Ok(SkillManagementApproval {
            owner: self.owner,
            preview_token: request.preview_token.clone(),
            nonce: response.nonce,
        })
    }

    pub(crate) fn apply(
        &self,
        token: &str,
        approval: Option<SkillManagementApproval>,
    ) -> Result<SkillManagementApplyResponse, Error> {
        let pending = {
            let mut previews = self.previews.lock().unwrap();
            let pending = previews
                .remove(token)
                .ok_or_else(|| conflict("invalid_preview"))?;
            if pending.owner != self.owner || Instant::now() >= pending.expires {
                return Err(conflict("expired_preview"));
            }
            pending
        };
        if pending.response.requires_confirmation {
            let approval = approval.ok_or_else(|| unauthorized("confirmation_required"))?;
            if approval.owner != self.owner
                || approval.preview_token != token
                || pending.confirmation_nonce.as_deref() != Some(approval.nonce.as_str())
            {
                return Err(unauthorized("invalid_confirmation"));
            }
        }
        if pending.import_fingerprint != import_fingerprint(&pending.change)? {
            return Err(conflict("stale_import_source"));
        }
        for (path, expected) in &pending.filesystem_identities {
            if &filesystem_identity(path)? != expected {
                return Err(conflict("filesystem_identity_changed"));
            }
        }
        self.inspect_change(pending.project_dir.as_deref(), &pending.change)?;
        let result = self.execute_change(pending.project_dir.as_deref(), pending.change);
        result
    }

    pub fn recovery_list(
        &self,
        project_dir: Option<&str>,
    ) -> Result<Vec<SkillRecoveryEntry>, Error> {
        let mut entries = Vec::new();
        for root in self
            .roots(project_dir)?
            .into_iter()
            .filter(|root| !root.read_only && root.path.is_some())
        {
            let store = recovery_root(root.path.as_ref().unwrap());
            let Ok(children) = fs::read_dir(store) else {
                continue;
            };
            for child in children.flatten() {
                let manifest_path = child.path().join(RECOVERY_MANIFEST);
                let Ok(raw) = fs::read_to_string(manifest_path) else {
                    continue;
                };
                let Ok(manifest) = serde_json::from_str::<RecoveryManifest>(&raw) else {
                    continue;
                };
                let Ok((validated_item, _, _, _)) =
                    self.find_recovery(project_dir, &manifest.recovery_ref)
                else {
                    continue;
                };
                if validated_item != child.path() {
                    continue;
                }
                entries.push(SkillRecoveryEntry {
                    recovery_ref: manifest.recovery_ref,
                    source: manifest.source,
                    name: manifest.name,
                    version: manifest.version,
                    deleted_at: manifest.deleted_at,
                });
            }
        }
        entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        Ok(entries)
    }

    fn inspect_change(
        &self,
        project: Option<&str>,
        change: &SkillManagementOperation,
    ) -> Result<ChangeInspection, Error> {
        match change {
            SkillManagementOperation::Create {
                destination,
                raw_document,
            } => {
                validate_document(raw_document, Some(&destination.name))?;
                let target = self.destination(project, destination)?;
                Ok(ChangeInspection {
                    operation: "create".into(),
                    target: target.to_string_lossy().into_owned(),
                    requires_confirmation: false,
                    has_conflict: target.exists(),
                    files: vec!["SKILL.md".into()],
                    diff: None,
                })
            }
            SkillManagementOperation::ImportLocal {
                destination,
                source_path,
            } => {
                let source = validate_import_source(source_path)?;
                let target = self.destination(project, destination)?;
                Ok(ChangeInspection {
                    operation: "import_local".into(),
                    target: target.to_string_lossy().into_owned(),
                    requires_confirmation: false,
                    has_conflict: target.exists(),
                    files: tree_files(&source)?,
                    diff: None,
                })
            }
            SkillManagementOperation::UpdateRaw {
                source,
                expected_version,
                raw_document,
                display_metadata,
            } => {
                let current = self.read(project, source)?;
                if &current.version != expected_version {
                    return Err(conflict("stale_source"));
                }
                let proposed = merge_display_metadata(raw_document, display_metadata.as_ref())?;
                validate_document(&proposed, Some(&current.name))?;
                Ok(ChangeInspection {
                    operation: "update_raw".into(),
                    target: source.relative_path.clone(),
                    requires_confirmation: false,
                    has_conflict: false,
                    files: vec!["SKILL.md".into()],
                    diff: Some(content_diff(&current.raw_document, &proposed)),
                })
            }
            SkillManagementOperation::SetEnabled {
                source,
                expected_version,
                enabled,
            } => {
                let current = self.read(project, source)?;
                if current.read_only {
                    return Err(read_only());
                }
                if &current.version != expected_version {
                    return Err(conflict("stale_source"));
                }
                Ok(ChangeInspection {
                    operation: "set_enabled".into(),
                    target: source.relative_path.clone(),
                    requires_confirmation: false,
                    has_conflict: false,
                    files: vec![super::DISABLED_MARKER.into()],
                    diff: Some(if *enabled {
                        "disabled -> enabled".into()
                    } else {
                        "enabled -> disabled".into()
                    }),
                })
            }
            SkillManagementOperation::Delete {
                source,
                expected_version,
            } => {
                let current = self.read(project, source)?;
                if current.read_only {
                    return Err(read_only());
                }
                if &current.version != expected_version {
                    return Err(conflict("stale_source"));
                }
                Ok(ChangeInspection {
                    operation: "delete".into(),
                    target: source.relative_path.clone(),
                    requires_confirmation: true,
                    has_conflict: false,
                    files: current
                        .companion_files
                        .iter()
                        .map(|file| file.relative_path.clone())
                        .collect(),
                    diff: None,
                })
            }
            SkillManagementOperation::Copy {
                source,
                expected_version,
                destination,
            } => {
                let current = self.read(project, source)?;
                if &current.version != expected_version {
                    return Err(conflict("stale_source"));
                };
                let target = self.destination(project, destination)?;
                Ok(ChangeInspection {
                    operation: "copy".into(),
                    target: target.to_string_lossy().into_owned(),
                    requires_confirmation: false,
                    has_conflict: target.exists(),
                    files: current
                        .companion_files
                        .into_iter()
                        .map(|file| file.relative_path)
                        .collect(),
                    diff: None,
                })
            }
            SkillManagementOperation::Restore { recovery_ref } => {
                let (_, manifest, _, target) = self.find_recovery(project, recovery_ref)?;
                Ok(ChangeInspection {
                    operation: "restore".into(),
                    target: target.to_string_lossy().into_owned(),
                    requires_confirmation: false,
                    has_conflict: target.exists(),
                    files: vec![manifest.name],
                    diff: None,
                })
            }
        }
    }

    fn change_identities(
        &self,
        project: Option<&str>,
        change: &SkillManagementOperation,
    ) -> Result<Vec<(PathBuf, String)>, Error> {
        let mut paths = Vec::new();
        match change {
            SkillManagementOperation::Create { destination, .. }
            | SkillManagementOperation::ImportLocal { destination, .. } => {
                paths.push(self.destination(project, destination)?);
            }
            SkillManagementOperation::Copy {
                source,
                destination,
                ..
            } => {
                if source.root_kind != SkillRootKind::Builtin {
                    let root = self.resolve_root(project, source)?;
                    paths.push(resolve_relative_existing(&root, &source.relative_path)?);
                }
                paths.push(self.destination(project, destination)?);
            }
            SkillManagementOperation::UpdateRaw { source, .. }
            | SkillManagementOperation::SetEnabled { source, .. }
            | SkillManagementOperation::Delete { source, .. } => {
                let root = self.resolve_root(project, source)?;
                paths.push(resolve_relative_existing(&root, &source.relative_path)?);
            }
            SkillManagementOperation::Restore { recovery_ref } => {
                let (item, _, payload, target) = self.find_recovery(project, recovery_ref)?;
                paths.push(item);
                paths.push(payload);
                paths.push(target);
            }
        }
        if let SkillManagementOperation::ImportLocal { source_path, .. } = change {
            paths.push(validate_import_source(source_path)?);
        }
        paths.sort();
        paths.dedup();
        paths
            .into_iter()
            .map(|path| Ok((path.clone(), filesystem_identity(&path)?)))
            .collect()
    }

    fn execute_change(
        &self,
        project: Option<&str>,
        change: SkillManagementOperation,
    ) -> Result<SkillManagementApplyResponse, Error> {
        match change {
            SkillManagementOperation::Create {
                destination,
                raw_document,
            } => {
                let target = self.destination(project, &destination)?;
                publish_new(&target, |stage| {
                    fs::write(stage.join("SKILL.md"), raw_document).map_err(io_error)
                })?;
                self.applied(project, &destination)
            }
            SkillManagementOperation::ImportLocal {
                destination,
                source_path,
            } => {
                let source = validate_import_source(&source_path)?;
                let target = self.destination(project, &destination)?;
                publish_new(&target, |stage| {
                    copy_tree(&source, stage)?;
                    let raw = fs::read_to_string(stage.join("SKILL.md")).map_err(io_error)?;
                    fs::write(
                        stage.join("SKILL.md"),
                        rewrite_skill_name(&raw, &destination.name)?,
                    )
                    .map_err(io_error)
                })?;
                self.applied(project, &destination)
            }
            SkillManagementOperation::Copy {
                source,
                destination,
                ..
            } => {
                let current = self.read(project, &source)?;
                let target = self.destination(project, &destination)?;
                publish_new(&target, |stage| {
                    if source.root_kind != SkillRootKind::Builtin {
                        let root = self.resolve_root(project, &source)?;
                        let source_dir = resolve_relative_existing(&root, &source.relative_path)?;
                        copy_tree(&source_dir, stage)?;
                    }
                    fs::write(
                        stage.join("SKILL.md"),
                        rewrite_skill_name(&current.raw_document, &destination.name)?,
                    )
                    .map_err(io_error)
                })?;
                self.applied(project, &destination)
            }
            SkillManagementOperation::UpdateRaw {
                source,
                raw_document,
                display_metadata,
                ..
            } => {
                let root = self.resolve_root(project, &source)?;
                if root.read_only {
                    return Err(read_only());
                };
                let dir = resolve_relative_existing(&root, &source.relative_path)?;
                let proposed = merge_display_metadata(&raw_document, display_metadata.as_ref())?;
                atomic_write(&dir.join("SKILL.md"), proposed.as_bytes())?;
                Ok(SkillManagementApplyResponse {
                    skill: Some(self.read(project, &source)?),
                    recovery_ref: None,
                })
            }
            SkillManagementOperation::SetEnabled {
                source, enabled, ..
            } => {
                let root = self.resolve_root(project, &source)?;
                if root.read_only {
                    return Err(read_only());
                }
                let dir = resolve_relative_existing(&root, &source.relative_path)?;
                let marker = dir.join(super::DISABLED_MARKER);
                if enabled {
                    if marker.exists() {
                        fs::remove_file(marker).map_err(io_error)?;
                    }
                } else {
                    atomic_write(&marker, b"disabled\n")?;
                }
                Ok(SkillManagementApplyResponse {
                    skill: Some(self.read(project, &source)?),
                    recovery_ref: None,
                })
            }
            SkillManagementOperation::Delete { source, .. } => {
                let root = self.resolve_root(project, &source)?;
                if root.read_only {
                    return Err(read_only());
                };
                let dir = resolve_relative_existing(&root, &source.relative_path)?;
                let skill = self.read_directory(&root, &dir)?;
                let recovery_ref = Uuid::new_v4().simple().to_string();
                let store = recovery_root(root.path.as_ref().unwrap());
                fs::create_dir_all(&store).map_err(io_error)?;
                let item = store.join(&recovery_ref);
                fs::create_dir(&item).map_err(io_error)?;
                let manifest = RecoveryManifest {
                    recovery_ref: recovery_ref.clone(),
                    source: source.clone(),
                    name: skill.name,
                    version: skill.version,
                    deleted_at: Utc::now().to_rfc3339(),
                    store_identity: filesystem_identity(&store)?,
                    payload_version: fingerprint(&dir)?,
                };
                fs::write(
                    item.join(RECOVERY_MANIFEST),
                    serde_json::to_vec_pretty(&manifest).map_err(|_| invalid("manifest_error"))?,
                )
                .map_err(io_error)?;
                fs::rename(&dir, item.join(RECOVERY_PAYLOAD)).map_err(|e| {
                    let _ = fs::remove_dir_all(&item);
                    io_error(e)
                })?;
                Ok(SkillManagementApplyResponse {
                    skill: None,
                    recovery_ref: Some(recovery_ref),
                })
            }
            SkillManagementOperation::Restore { recovery_ref } => {
                let (item, manifest, payload, target) =
                    self.find_recovery(project, &recovery_ref)?;
                if target.exists() {
                    return Err(conflict("restore_conflict"));
                };
                fs::rename(payload, &target).map_err(io_error)?;
                let _ = fs::remove_file(item.join(RECOVERY_MANIFEST));
                let _ = fs::remove_dir(item);
                Ok(SkillManagementApplyResponse {
                    skill: Some(self.read(project, &manifest.source)?),
                    recovery_ref: None,
                })
            }
        }
    }

    fn applied(
        &self,
        project: Option<&str>,
        destination: &SkillDestination,
    ) -> Result<SkillManagementApplyResponse, Error> {
        let source = SkillSourceRef {
            root_kind: destination.root_kind,
            root_id: destination.root_id.clone(),
            relative_path: destination.name.clone(),
        };
        Ok(SkillManagementApplyResponse {
            skill: Some(self.read(project, &source)?),
            recovery_ref: None,
        })
    }
    fn resolve_root(&self, project: Option<&str>, source: &SkillSourceRef) -> Result<Root, Error> {
        self.roots(project)?
            .into_iter()
            .find(|r| r.kind == source.root_kind && r.id == source.root_id)
            .ok_or_else(|| invalid("source_scope_mismatch"))
    }
    fn destination(
        &self,
        project: Option<&str>,
        destination: &SkillDestination,
    ) -> Result<PathBuf, Error> {
        validate_skill_name(&destination.name)?;
        let source = SkillSourceRef {
            root_kind: destination.root_kind,
            root_id: destination.root_id.clone(),
            relative_path: destination.name.clone(),
        };
        let root = self.resolve_root(project, &source)?;
        if root.read_only {
            return Err(read_only());
        };
        Ok(root.path.unwrap().join(&destination.name))
    }
    fn read_directory(&self, root: &Root, dir: &Path) -> Result<ManagedSkill, Error> {
        ensure_direct_tree(dir)?;
        let raw = fs::read_to_string(dir.join("SKILL.md")).map_err(io_error)?;
        let source = parse_skill_content(&raw, dir, root.kind == SkillRootKind::Global)
            .ok_or_else(|| invalid("invalid_skill"))?;
        let canonical_root = root
            .path
            .as_ref()
            .ok_or_else(|| invalid("invalid_root"))?
            .canonicalize()
            .map_err(|_| invalid("source_not_found"))?;
        let canonical_dir = dir
            .canonicalize()
            .map_err(|_| invalid("source_not_found"))?;
        let relative = canonical_dir
            .strip_prefix(&canonical_root)
            .map_err(|_| invalid("source_scope_mismatch"))?
            .to_string_lossy()
            .replace('\\', "/");
        Ok(ManagedSkill {
            source: SkillSourceRef {
                root_kind: root.kind,
                root_id: root.id.clone(),
                relative_path: relative,
            },
            name: source.name,
            description: source.description,
            scope: root_scope(root.kind).into(),
            read_only: root.read_only,
            enabled: !canonical_dir.join(super::DISABLED_MARKER).is_file(),
            display_path: canonical_dir.to_string_lossy().into_owned(),
            version: fingerprint(dir)?,
            raw_document: raw.clone(),
            original_metadata: metadata_value(&raw),
            display_metadata: display_metadata(&source.properties)?,
            companion_files: companion_manifest(dir)?,
        })
    }
    fn find_recovery(
        &self,
        project: Option<&str>,
        needle: &str,
    ) -> Result<(PathBuf, RecoveryManifest, PathBuf, PathBuf), Error> {
        if needle.is_empty() || needle.contains(|c: char| !c.is_ascii_hexdigit()) {
            return Err(invalid("invalid_recovery_ref"));
        }
        for root in self
            .roots(project)?
            .into_iter()
            .filter(|r| !r.read_only && r.path.is_some())
        {
            let item = recovery_root(root.path.as_ref().unwrap()).join(needle);
            if !item.is_dir() {
                continue;
            };
            ensure_direct_tree(&item)?;
            let manifest: RecoveryManifest =
                serde_json::from_slice(&fs::read(item.join(RECOVERY_MANIFEST)).map_err(io_error)?)
                    .map_err(|_| invalid("invalid_recovery_manifest"))?;
            if manifest.recovery_ref != needle {
                return Err(invalid("invalid_recovery_manifest"));
            };
            if manifest.source.root_kind != root.kind || manifest.source.root_id != root.id {
                return Err(invalid("invalid_recovery_manifest"));
            }
            if manifest.store_identity
                != filesystem_identity(&recovery_root(root.path.as_ref().unwrap()))?
            {
                return Err(invalid("invalid_recovery_manifest"));
            }
            let relative = Path::new(&manifest.source.relative_path);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                return Err(invalid("invalid_recovery_manifest"));
            }
            let expected = self.resolve_root(project, &manifest.source)?;
            let target = expected.path.unwrap().join(relative);
            let payload = item.join(RECOVERY_PAYLOAD);
            if !payload.is_dir() || fingerprint(&payload)? != manifest.payload_version {
                return Err(invalid("invalid_recovery_manifest"));
            }
            return Ok((item.clone(), manifest, payload, target));
        }
        Err(invalid("recovery_not_found"))
    }
}

fn skill_directories(root: &Path) -> Result<Vec<PathBuf>, Error> {
    let mut out = Vec::new();
    walk(root, root, &mut |path| {
        if path.file_name().and_then(|v| v.to_str()) == Some("SKILL.md") {
            if let Some(parent) = path.parent() {
                out.push(parent.to_path_buf())
            }
        }
    })?;
    out.sort();
    out.dedup();
    Ok(out)
}
fn tree_files(root: &Path) -> Result<Vec<String>, Error> {
    let mut out = Vec::new();
    walk(root, root, &mut |p| {
        if let Ok(r) = p.strip_prefix(root) {
            out.push(r.to_string_lossy().replace('\\', "/"))
        }
    })?;
    out.sort();
    Ok(out)
}
fn companion_manifest(root: &Path) -> Result<Vec<SkillCompanionFile>, Error> {
    tree_files(root)?
        .into_iter()
        .filter(|relative| relative != "SKILL.md" && relative != super::DISABLED_MARKER)
        .map(|relative_path| {
            let bytes = fs::read(root.join(&relative_path)).map_err(io_error)?;
            Ok(SkillCompanionFile {
                relative_path,
                size: bytes.len() as u64,
                version: digest_bytes(&bytes),
            })
        })
        .collect()
}

fn root_scope(kind: SkillRootKind) -> &'static str {
    match kind {
        SkillRootKind::ProjectAgents => "project_agents",
        SkillRootKind::ProjectGoose => "project_goose",
        SkillRootKind::ProjectClaude => "project_claude",
        SkillRootKind::Global => "global",
        SkillRootKind::Plugin => "plugin",
        SkillRootKind::Builtin => "builtin",
    }
}
fn walk(root: &Path, current: &Path, visit: &mut impl FnMut(&Path)) -> Result<(), Error> {
    for entry in fs::read_dir(current).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(io_error)?;
        if is_link(&meta) {
            return Err(invalid("linked_path_rejected"));
        }
        if meta.is_dir() {
            walk(root, &path, visit)?
        } else if meta.is_file() {
            visit(&path)
        }
    }
    let _ = root;
    Ok(())
}
fn ensure_direct_tree(path: &Path) -> Result<(), Error> {
    let meta = fs::symlink_metadata(path).map_err(io_error)?;
    if !meta.is_dir() || is_link(&meta) {
        return Err(invalid("linked_path_rejected"));
    }
    walk(path, path, &mut |_| {})
}
fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || (meta.file_attributes() & 0x400) != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
fn resolve_relative_existing(root: &Root, relative: &str) -> Result<PathBuf, Error> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(invalid("invalid_relative_path"));
    }
    let base = root.path.as_ref().ok_or_else(|| invalid("invalid_root"))?;
    let joined = base.join(path);
    let canonical = joined
        .canonicalize()
        .map_err(|_| invalid("source_not_found"))?;
    let canonical_base = base
        .canonicalize()
        .map_err(|_| invalid("source_not_found"))?;
    if !canonical.starts_with(canonical_base) {
        return Err(invalid("source_scope_mismatch"));
    }
    Ok(canonical)
}
fn validate_document(raw: &str, expected: Option<&str>) -> Result<(), Error> {
    let parsed = crate::sources::parse_frontmatter::<SkillFrontmatter>(raw)
        .map_err(|_| invalid("invalid_frontmatter"))?
        .ok_or_else(|| invalid("missing_frontmatter"))?;
    let name = parsed.0.name.ok_or_else(|| invalid("missing_name"))?;
    validate_skill_name(&name)?;
    if expected.is_some_and(|e| e != name) {
        return Err(invalid("name_mismatch"));
    }
    Ok(())
}
fn validate_import_source(value: &str) -> Result<PathBuf, Error> {
    let path = Path::new(value)
        .canonicalize()
        .map_err(|_| invalid("import_not_found"))?;
    let dir = if path.is_file() {
        if path.file_name().and_then(|v| v.to_str()) != Some("SKILL.md") {
            return Err(invalid("unsupported_import"));
        }
        path.parent().unwrap().to_path_buf()
    } else {
        path
    };
    ensure_direct_tree(&dir)?;
    let raw = fs::read_to_string(dir.join("SKILL.md")).map_err(io_error)?;
    validate_document(&raw, None)?;
    Ok(dir)
}
fn fingerprint(root: &Path) -> Result<String, Error> {
    let mut h = Sha256::new();
    for relative in tree_files(root)? {
        h.update(relative.as_bytes());
        h.update([0]);
        h.update(fs::read(root.join(&relative)).map_err(io_error)?);
        h.update([0]);
    }
    Ok(hex_digest(&h.finalize()))
}
fn digest_bytes(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}
fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn metadata_value(raw: &str) -> serde_json::Value {
    crate::sources::parse_frontmatter::<serde_yaml::Value>(raw)
        .ok()
        .flatten()
        .and_then(|(v, _)| serde_json::to_value(v).ok())
        .unwrap_or_default()
}
fn recovery_root(skills_root: &Path) -> PathBuf {
    skills_root
        .parent()
        .unwrap_or(skills_root)
        .join(".skill-recovery")
}
fn publish_new(target: &Path, write: impl FnOnce(&Path) -> Result<(), Error>) -> Result<(), Error> {
    if target.exists() {
        return Err(conflict("destination_conflict"));
    }
    let parent = target
        .parent()
        .ok_or_else(|| invalid("invalid_destination"))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let stage = parent.join(format!(".skill-stage-{}", Uuid::new_v4().simple()));
    fs::create_dir(&stage).map_err(io_error)?;
    if let Err(e) = write(&stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(e);
    };
    if let Err(e) = fs::rename(&stage, target) {
        let _ = fs::remove_dir_all(&stage);
        return Err(io_error(e));
    }
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    atomic_write_with(path, bytes, persist_temporary)
}

fn atomic_write_with(
    path: &Path,
    bytes: &[u8],
    persist: impl FnOnce(tempfile::NamedTempFile, &Path) -> std::io::Result<()>,
) -> Result<(), Error> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("invalid_destination"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    temporary.write_all(bytes).map_err(io_error)?;
    temporary.as_file().sync_all().map_err(io_error)?;
    persist(temporary, path).map_err(io_error)
}

#[cfg(windows)]
fn persist_temporary(
    temporary: tempfile::NamedTempFile,
    destination: &Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winbase::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let source = temporary
        .path()
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let (_file, mut path) = temporary.into_parts();
    path.disable_cleanup(true);
    Ok(())
}

#[cfg(not(windows))]
fn persist_temporary(
    temporary: tempfile::NamedTempFile,
    destination: &Path,
) -> std::io::Result<()> {
    temporary
        .persist(destination)
        .map(|_| ())
        .map_err(|error| error.error)
}
fn copy_tree(source: &Path, target: &Path) -> Result<(), Error> {
    for relative in tree_files(source)? {
        let from = source.join(&relative);
        let to = target.join(&relative);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(io_error)?
        }
        fs::copy(from, to).map_err(io_error)?;
    }
    Ok(())
}
fn operation_identity(
    change: &SkillManagementOperation,
) -> (Option<SkillSourceRef>, Option<String>) {
    match change {
        SkillManagementOperation::UpdateRaw {
            source,
            expected_version,
            ..
        }
        | SkillManagementOperation::Delete {
            source,
            expected_version,
        }
        | SkillManagementOperation::Copy {
            source,
            expected_version,
            ..
        }
        | SkillManagementOperation::SetEnabled {
            source,
            expected_version,
            ..
        } => (Some(source.clone()), Some(expected_version.clone())),
        _ => (None, None),
    }
}

fn import_fingerprint(change: &SkillManagementOperation) -> Result<Option<String>, Error> {
    match change {
        SkillManagementOperation::ImportLocal { source_path, .. } => {
            Ok(Some(fingerprint(&validate_import_source(source_path)?)?))
        }
        _ => Ok(None),
    }
}

fn filesystem_identity(path: &Path) -> Result<String, Error> {
    let ancestor = existing_ancestor(path)?;
    let canonical = ancestor.canonicalize().map_err(io_error)?;
    let suffix = path
        .strip_prefix(&ancestor)
        .map_err(|_| invalid("invalid_filesystem_identity"))?
        .to_string_lossy();
    let metadata = fs::symlink_metadata(&ancestor).map_err(io_error)?;
    if is_link(&metadata) {
        return Err(invalid("linked_path_rejected"));
    }
    #[cfg(windows)]
    let stable = {
        use std::fs::OpenOptions;
        use std::mem::MaybeUninit;
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use winapi::um::fileapi::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        use winapi::um::winbase::FILE_FLAG_BACKUP_SEMANTICS;
        use winapi::um::winnt::{FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE};
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&ancestor)
            .map_err(io_error)?;
        let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        if unsafe {
            GetFileInformationByHandle(handle.as_raw_handle().cast(), information.as_mut_ptr())
        } == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        let information = unsafe { information.assume_init() };
        format!(
            "{}:{}",
            information.dwVolumeSerialNumber,
            ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64
        )
    };
    #[cfg(unix)]
    let stable = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(any(windows, unix)))]
    let stable = format!(
        "{:?}:{:?}",
        metadata.created().ok(),
        metadata.modified().ok()
    );
    Ok(format!("{}|{}|{}", canonical.display(), stable, suffix))
}

fn existing_ancestor(path: &Path) -> Result<PathBuf, Error> {
    let mut current = path;
    loop {
        if current.exists() {
            return Ok(current.to_path_buf());
        }
        current = current
            .parent()
            .ok_or_else(|| invalid("invalid_filesystem_identity"))?;
    }
}

fn display_metadata(
    properties: &HashMap<String, serde_json::Value>,
) -> Result<SkillDisplayMetadata, Error> {
    let Some(codebuddy) = properties.get("codebuddy") else {
        return Ok(SkillDisplayMetadata::default());
    };
    let object = codebuddy
        .as_object()
        .ok_or_else(|| invalid("invalid_display_metadata"))?;
    let Some(display) = object.get("display") else {
        return Ok(SkillDisplayMetadata::default());
    };
    let locales =
        serde_json::from_value(display.clone()).map_err(|_| invalid("invalid_display_metadata"))?;
    Ok(SkillDisplayMetadata { locales })
}

fn merge_display_metadata(
    raw: &str,
    display: Option<&SkillDisplayMetadata>,
) -> Result<String, Error> {
    let Some(display) = display else {
        return Ok(raw.to_string());
    };
    let remainder = raw
        .strip_prefix("---")
        .ok_or_else(|| invalid("missing_frontmatter"))?;
    let (yaml, body) = remainder
        .split_once("\n---")
        .ok_or_else(|| invalid("missing_frontmatter"))?;
    let mut frontmatter: serde_yaml::Mapping =
        serde_yaml::from_str(yaml).map_err(|_| invalid("invalid_frontmatter"))?;
    let metadata_key = serde_yaml::Value::String("metadata".into());
    if !frontmatter.contains_key(&metadata_key) {
        frontmatter.insert(
            metadata_key.clone(),
            serde_yaml::Value::Mapping(Default::default()),
        );
    }
    let metadata = frontmatter
        .get_mut(&metadata_key)
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or_else(|| invalid("invalid_display_metadata"))?;
    let codebuddy_key = serde_yaml::Value::String("codebuddy".into());
    if !metadata.contains_key(&codebuddy_key) {
        metadata.insert(
            codebuddy_key.clone(),
            serde_yaml::Value::Mapping(Default::default()),
        );
    }
    let codebuddy = metadata
        .get_mut(&codebuddy_key)
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or_else(|| invalid("invalid_display_metadata"))?;
    let display_key = serde_yaml::Value::String("display".into());
    if !codebuddy.contains_key(&display_key) {
        codebuddy.insert(
            display_key.clone(),
            serde_yaml::Value::Mapping(Default::default()),
        );
    }
    let stored_display = codebuddy
        .get_mut(&display_key)
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or_else(|| invalid("invalid_display_metadata"))?;
    for (locale, value) in &display.locales {
        stored_display.insert(
            serde_yaml::Value::String(locale.clone()),
            serde_yaml::to_value(value).map_err(|_| invalid("invalid_display_metadata"))?,
        );
    }
    let yaml =
        serde_yaml::to_string(&frontmatter).map_err(|_| invalid("invalid_display_metadata"))?;
    Ok(format!("---\n{yaml}---{body}"))
}

fn rewrite_skill_name(raw: &str, name: &str) -> Result<String, Error> {
    validate_skill_name(name)?;
    let remainder = raw
        .strip_prefix("---")
        .ok_or_else(|| invalid("missing_frontmatter"))?;
    let (yaml, body) = remainder
        .split_once("\n---")
        .ok_or_else(|| invalid("missing_frontmatter"))?;
    let mut frontmatter: serde_yaml::Mapping =
        serde_yaml::from_str(yaml).map_err(|_| invalid("invalid_frontmatter"))?;
    frontmatter.insert(
        serde_yaml::Value::String("name".into()),
        serde_yaml::Value::String(name.into()),
    );
    let yaml = serde_yaml::to_string(&frontmatter).map_err(|_| invalid("invalid_frontmatter"))?;
    Ok(format!("---\n{yaml}---{body}"))
}

fn content_diff(before: &str, after: &str) -> String {
    if before == after {
        return "unchanged".into();
    }

    #[derive(Clone, Copy, Eq, PartialEq)]
    struct DiffLine<'a> {
        text: &'a str,
        final_newline: bool,
    }

    fn diff_lines(input: &str) -> Vec<DiffLine<'_>> {
        if input.is_empty() {
            return Vec::new();
        }
        let mut lines = input
            .split('\n')
            .map(|text| DiffLine {
                text,
                final_newline: false,
            })
            .collect::<Vec<_>>();
        if input.ends_with('\n') {
            if let Some(line) = lines.last_mut() {
                line.final_newline = true;
            }
        }
        lines
    }

    fn push_diff_line(output: &mut String, marker: char, line: DiffLine<'_>) {
        if marker == ' ' && line.final_newline {
            return;
        }
        output.push(marker);
        for character in line.text.chars() {
            if character == '\r' {
                output.push_str("\\r");
            } else if character == '\\' {
                output.push_str("\\\\");
            } else {
                output.push(character);
            }
        }
        output.push('\n');
    }

    let before_lines = diff_lines(before);
    let after_lines = diff_lines(after);
    let mut prefix_len = 0;
    while prefix_len < before_lines.len()
        && prefix_len < after_lines.len()
        && before_lines[prefix_len] == after_lines[prefix_len]
    {
        prefix_len += 1;
    }
    let mut before_suffix_start = before_lines.len();
    let mut after_suffix_start = after_lines.len();
    while before_suffix_start > prefix_len
        && after_suffix_start > prefix_len
        && before_lines[before_suffix_start - 1] == after_lines[after_suffix_start - 1]
    {
        before_suffix_start -= 1;
        after_suffix_start -= 1;
    }

    let mut output = String::from("--- current\n+++ proposed\n");
    for line in &before_lines[..prefix_len] {
        push_diff_line(&mut output, ' ', *line);
    }
    for line in &before_lines[prefix_len..before_suffix_start] {
        push_diff_line(&mut output, '-', *line);
    }
    for line in &after_lines[prefix_len..after_suffix_start] {
        push_diff_line(&mut output, '+', *line);
    }
    for line in &before_lines[before_suffix_start..] {
        push_diff_line(&mut output, ' ', *line);
    }
    output
}
fn invalid(reason: &str) -> Error {
    Error::invalid_params().data(serde_json::json!({"reason":reason}))
}
fn conflict(reason: &str) -> Error {
    Error::invalid_params().data(serde_json::json!({"reason":reason,"category":"conflict"}))
}
fn unauthorized(reason: &str) -> Error {
    Error::invalid_params().data(serde_json::json!({"reason":reason,"category":"unauthorized"}))
}
fn read_only() -> Error {
    Error::invalid_params().data(serde_json::json!({"reason":"read_only","category":"read_only"}))
}
fn io_error(error: std::io::Error) -> Error {
    Error::internal_error().data(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn doc(name: &str, body: &str) -> String {
        format!("---\nname: {name}\ndescription: test\nx-extra: keep\n---\n\n{body}\n")
    }
    fn setup() -> (tempfile::TempDir, SkillManagementService, String) {
        let temp = tempfile::tempdir().unwrap();
        let global = temp.path().join("global-skills");
        fs::create_dir_all(&global).unwrap();
        let id = "global".to_string();
        (temp, SkillManagementService::new(global), id)
    }
    fn approve_delete(service: &SkillManagementService, token: &str) -> SkillManagementApproval {
        let request = service.confirmation_request(token).unwrap();
        service
            .approve(
                &request,
                SkillManagementConfirmationResponse {
                    decision: SkillManagementConfirmationDecision::Confirm,
                    nonce: request.nonce.clone(),
                },
            )
            .unwrap()
    }
    #[test]
    fn content_diff_reports_final_newline_only_change() {
        let diff = content_diff("same\n", "same");

        assert!(diff.contains("--- current\n+++ proposed\n"));
        assert!(diff.contains(" same\n"));
        assert!(diff.contains("\n-\n"), "{diff}");
    }

    #[test]
    fn content_diff_reports_unchanged_documents() {
        assert_eq!(content_diff("same\n", "same\n"), "unchanged");
    }

    #[test]
    fn content_diff_reports_insertions_deletions_and_replacements() {
        let insertion = content_diff("one\ntwo\nfour\n", "one\ntwo\nthree\nfour\n");
        assert!(insertion.contains(" one\n"));
        assert!(insertion.contains("+three\n"), "{insertion}");
        assert!(insertion.contains(" four\n"));

        let deletion = content_diff("one\ntwo\nthree\n", "one\nthree\n");
        assert!(deletion.contains(" one\n"));
        assert!(deletion.contains("-two\n"), "{deletion}");
        assert!(deletion.contains(" three\n"));

        let replacement = content_diff("one\ntwo\nthree\n", "one\ndos\nthree\n");
        assert!(replacement.contains(" one\n"));
        assert!(replacement.contains("-two\n"), "{replacement}");
        assert!(replacement.contains("+dos\n"), "{replacement}");
        assert!(replacement.contains(" three\n"));
    }

    #[test]
    fn content_diff_preserves_unicode_lines() {
        let diff = content_diff("標題\nold café\n結尾\n", "標題\n新しい café\n結尾\n");

        assert!(diff.contains(" 標題\n"), "{diff}");
        assert!(diff.contains("-old café\n"), "{diff}");
        assert!(diff.contains("+新しい café\n"), "{diff}");
        assert!(diff.contains(" 結尾\n"), "{diff}");
    }

    #[test]
    fn content_diff_reports_empty_and_final_newline_edges() {
        let from_empty = content_diff("", "body\n");
        assert!(from_empty.contains("+body\n"), "{from_empty}");
        assert!(!from_empty.contains("-\n"), "{from_empty}");

        let adds_final_newline = content_diff("same", "same\n");
        assert!(
            adds_final_newline.contains(" same\n"),
            "{adds_final_newline}"
        );
        assert!(adds_final_newline.contains("\n+\n"), "{adds_final_newline}");
    }

    #[test]
    fn content_diff_reports_crlf_to_lf_explicitly() {
        let diff = content_diff("same\r\n", "same\n");

        assert!(diff.contains("-same\\r\n"), "{diff:?}");
        assert!(diff.contains("+same\n"), "{diff:?}");
        assert!(!diff.contains('\r'), "{diff:?}");
    }

    #[test]
    fn content_diff_escapes_standalone_trailing_cr() {
        let diff = content_diff("same\r", "same");

        assert!(diff.contains("-same\\r\n"), "{diff:?}");
        assert!(diff.contains("+same\n"), "{diff:?}");
        assert!(!diff.contains('\r'), "{diff:?}");
    }

    #[test]
    fn content_diff_distinguishes_actual_cr_from_literal_backslash_r() {
        let diff = content_diff("same\r", "same\\r");

        assert!(diff.contains("-same\\r\n"), "{diff:?}");
        assert!(diff.contains("+same\\\\r\n"), "{diff:?}");
        assert!(!diff.contains('\r'), "{diff:?}");
    }

    #[test]
    fn content_diff_handles_many_lines_with_actual_changes() {
        let mut before = String::new();
        let mut after = String::new();
        for i in 0..5_000 {
            if i == 2_500 {
                before.push_str("old middle\n");
                after.push_str("new middle\n");
            } else {
                let line = format!("line {i}\n");
                before.push_str(&line);
                after.push_str(&line);
            }
        }

        let diff = content_diff(&before, &after);

        assert!(diff.contains(" line 0\n"), "{diff}");
        assert!(diff.contains("-old middle\n"), "{diff}");
        assert!(diff.contains("+new middle\n"), "{diff}");
        assert!(diff.contains(" line 4999\n"), "{diff}");
    }
    #[test]
    fn stale_update_preserves_original_and_companions() {
        let (_t, s, id) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(dir.join("scripts")).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "old")).unwrap();
        fs::write(dir.join("scripts/a.txt"), b"asset").unwrap();
        let source = SkillSourceRef {
            root_kind: SkillRootKind::Global,
            root_id: id,
            relative_path: "demo".into(),
        };
        let before = fs::read(dir.join("SKILL.md")).unwrap();
        let p = s.preview(
            None,
            SkillManagementOperation::UpdateRaw {
                source,
                expected_version: "stale".into(),
                raw_document: doc("demo", "new"),
                display_metadata: None,
            },
        );
        assert!(p.is_err());
        assert_eq!(fs::read(dir.join("SKILL.md")).unwrap(), before);
        assert_eq!(fs::read(dir.join("scripts/a.txt")).unwrap(), b"asset");
    }
    #[test]
    fn same_name_scopes_are_not_deduplicated() {
        let (t, s, _) = setup();
        let project = t.path().join("project");
        fs::create_dir_all(project.join(".agents/skills/demo")).unwrap();
        fs::create_dir_all(s.global_root.join("demo")).unwrap();
        fs::write(
            project.join(".agents/skills/demo/SKILL.md"),
            doc("demo", "project"),
        )
        .unwrap();
        fs::write(s.global_root.join("demo/SKILL.md"), doc("demo", "global")).unwrap();
        let skills = s.list(Some(project.to_str().unwrap())).unwrap();
        assert_eq!(skills.iter().filter(|v| v.name == "demo").count(), 2);
    }
    #[test]
    fn source_ref_returned_by_list_reads_the_same_skill() {
        let (_t, s, _) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "listed body")).unwrap();

        let listed = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|skill| {
                skill.source.root_kind == SkillRootKind::Global
                    && skill.source.root_id == "global"
                    && skill.source.relative_path == "demo"
            })
            .expect("fixture skill must be enumerated by its exact scoped identity");
        let read = s.read(None, &listed.source).unwrap();

        assert_eq!(read.source, listed.source);
        assert_eq!(read.version, listed.version);
        assert_eq!(read.raw_document, listed.raw_document);
    }
    #[test]
    fn user_skill_is_enabled_by_default_and_can_be_disabled_then_reenabled() {
        let (temp, service, _) = setup();
        let project = temp.path().join("project");
        let skill_dir = project
            .join(".agents")
            .join("skills")
            .join("acceptance-toggle-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            doc("acceptance-toggle-skill", "toggle body"),
        )
        .unwrap();
        let project = project.to_string_lossy().into_owned();

        let current = service
            .list(Some(&project))
            .unwrap()
            .into_iter()
            .find(|skill| skill.name == "acceptance-toggle-skill")
            .unwrap();
        assert!(current.enabled);
        assert!(super::super::discover_skills(Some(Path::new(&project)))
            .iter()
            .any(|skill| skill.name == "acceptance-toggle-skill"));

        let preview = service
            .preview(
                Some(project.clone()),
                SkillManagementOperation::SetEnabled {
                    source: current.source,
                    expected_version: current.version,
                    enabled: false,
                },
            )
            .unwrap();
        let disabled = service
            .apply(&preview.preview_token, None)
            .unwrap()
            .skill
            .unwrap();
        assert!(!disabled.enabled);
        assert!(!super::super::discover_skills(Some(Path::new(&project)))
            .iter()
            .any(|skill| skill.name == "acceptance-toggle-skill"));

        let preview = service
            .preview(
                Some(project),
                SkillManagementOperation::SetEnabled {
                    source: disabled.source,
                    expected_version: disabled.version,
                    enabled: true,
                },
            )
            .unwrap();
        assert!(
            service
                .apply(&preview.preview_token, None)
                .unwrap()
                .skill
                .unwrap()
                .enabled
        );
    }
    #[test]
    fn delete_requires_confirmation_and_restore_rejects_conflict() {
        let (_t, s, id) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "old")).unwrap();
        let skill = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|skill| {
                skill.source.root_kind == SkillRootKind::Global
                    && skill.source.root_id == id
                    && skill.source.relative_path == "demo"
            })
            .expect("fixture skill must be selected by its exact scoped identity");
        let p = s
            .preview(
                None,
                SkillManagementOperation::Delete {
                    source: skill.source.clone(),
                    expected_version: skill.version,
                },
            )
            .unwrap();
        assert!(s.apply(&p.preview_token, None).is_err());
        assert!(dir.exists());
        let p = s
            .preview(
                None,
                SkillManagementOperation::Delete {
                    source: skill.source,
                    expected_version: fingerprint(&dir).unwrap(),
                },
            )
            .unwrap();
        let approval = approve_delete(&s, &p.preview_token);
        let deleted = s.apply(&p.preview_token, Some(approval)).unwrap();
        assert!(!dir.exists());
        fs::create_dir_all(&dir).unwrap();
        let p = s
            .preview(
                None,
                SkillManagementOperation::Restore {
                    recovery_ref: deleted.recovery_ref.unwrap(),
                },
            )
            .unwrap();
        assert!(p.has_conflict);
        assert!(s.apply(&p.preview_token, None).is_err());
    }
    #[test]
    fn traversal_is_rejected() {
        let (_t, s, _) = setup();
        let source = SkillSourceRef {
            root_kind: SkillRootKind::Global,
            root_id: "global".into(),
            relative_path: "../outside".into(),
        };
        assert!(s.read(None, &source).is_err());
    }
    #[test]
    fn canonical_path_outside_the_root_is_rejected() {
        let (t, s, _) = setup();
        let outside = t.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("SKILL.md"), doc("outside", "body")).unwrap();
        let source = SkillSourceRef {
            root_kind: SkillRootKind::Global,
            root_id: "global".into(),
            relative_path: outside.to_string_lossy().into_owned(),
        };

        assert!(s.read(None, &source).is_err());
    }

    #[test]
    fn forged_boolean_cannot_authorize_delete() {
        let (_t, s, _) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "protected")).unwrap();
        let source = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|skill| skill.name == "demo")
            .unwrap();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::Delete {
                    source: source.source,
                    expected_version: source.version,
                },
            )
            .unwrap();

        assert!(s.apply(&preview.preview_token, None).is_err());
        assert!(dir.exists());
    }

    #[test]
    fn changed_import_source_is_rejected_without_publishing() {
        let (t, s, _) = setup();
        let import = t.path().join("import");
        fs::create_dir_all(&import).unwrap();
        fs::write(import.join("SKILL.md"), doc("demo", "previewed")).unwrap();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::ImportLocal {
                    destination: SkillDestination {
                        root_kind: SkillRootKind::Global,
                        root_id: "global".into(),
                        name: "demo".into(),
                    },
                    source_path: import.to_string_lossy().into_owned(),
                },
            )
            .unwrap();
        fs::write(import.join("SKILL.md"), doc("demo", "replaced")).unwrap();

        assert!(s.apply(&preview.preview_token, None).is_err());
        assert!(!s.global_root.join("demo").exists());
    }

    #[test]
    fn update_preview_contains_content_lines() {
        let (_t, s, _) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "old line")).unwrap();
        let current = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|skill| skill.name == "demo" && skill.source.root_kind == SkillRootKind::Global)
            .unwrap();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::UpdateRaw {
                    source: current.source,
                    expected_version: current.version,
                    raw_document: doc("demo", "new line"),
                    display_metadata: None,
                },
            )
            .unwrap();

        let diff = preview.diff.unwrap();
        assert!(diff.contains("-old line"));
        assert!(diff.contains("+new line"));
    }

    #[test]
    fn confirmation_nonce_cancel_owner_and_replay_fail_closed() {
        let (_t, s, _) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "protected")).unwrap();
        let skill = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "demo")
            .unwrap();
        let make_preview = || {
            s.preview(
                None,
                SkillManagementOperation::Delete {
                    source: skill.source.clone(),
                    expected_version: skill.version.clone(),
                },
            )
            .unwrap()
        };

        let preview = make_preview();
        let request = s.confirmation_request(&preview.preview_token).unwrap();
        assert!(s
            .approve(
                &request,
                SkillManagementConfirmationResponse {
                    decision: SkillManagementConfirmationDecision::Confirm,
                    nonce: "wrong".into(),
                },
            )
            .is_err());
        assert!(dir.exists());

        let preview = make_preview();
        let request = s.confirmation_request(&preview.preview_token).unwrap();
        assert!(s
            .approve(
                &request,
                SkillManagementConfirmationResponse {
                    decision: SkillManagementConfirmationDecision::Cancel,
                    nonce: request.nonce.clone(),
                },
            )
            .is_err());
        assert!(s.apply(&preview.preview_token, None).is_err());

        let preview = make_preview();
        let approval = approve_delete(&s, &preview.preview_token);
        let forged_for_other_owner = SkillManagementApproval {
            owner: Uuid::new_v4(),
            preview_token: preview.preview_token.clone(),
            nonce: approval.nonce.clone(),
        };
        assert!(s
            .apply(&preview.preview_token, Some(forged_for_other_owner))
            .is_err());
        assert!(dir.exists());
    }

    #[test]
    fn display_metadata_update_preserves_body_unknown_fields_and_companions() {
        let (_t, s, _) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(dir.join("scripts")).unwrap();
        let raw = "---\nname: demo\ndescription: original\nmetadata:\n  unknown: keep\n  codebuddy:\n    sibling: keep-too\n    display:\n      en:\n        name: Demo\n        description: Existing\n---\n\nunchanged body\n";
        fs::write(dir.join("SKILL.md"), raw).unwrap();
        fs::write(dir.join("scripts/a.txt"), "asset").unwrap();
        let current = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "demo")
            .unwrap();
        let display = SkillDisplayMetadata {
            locales: HashMap::from([(
                "zh-TW".into(),
                SkillLocalizedDisplay {
                    name: "示範".into(),
                    description: "說明".into(),
                },
            )]),
        };
        let preview = s
            .preview(
                None,
                SkillManagementOperation::UpdateRaw {
                    source: current.source.clone(),
                    expected_version: current.version,
                    raw_document: raw.into(),
                    display_metadata: Some(display.clone()),
                },
            )
            .unwrap();
        let applied = s
            .apply(&preview.preview_token, None)
            .unwrap()
            .skill
            .unwrap();

        assert_eq!(applied.name, "demo");
        assert_eq!(
            applied.display_metadata.locales.get("zh-TW"),
            display.locales.get("zh-TW")
        );
        assert_eq!(applied.display_metadata.locales["en"].name, "Demo");
        assert!(applied.raw_document.contains("unknown: keep"));
        assert!(applied.raw_document.contains("sibling: keep-too"));
        assert!(applied.raw_document.contains("unchanged body"));
        assert_eq!(fs::read(dir.join("scripts/a.txt")).unwrap(), b"asset");
    }

    #[test]
    fn destination_root_creation_after_preview_is_rejected() {
        let (t, s, _) = setup();
        let project = t.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let root_id = project
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let preview = s
            .preview(
                Some(project.to_string_lossy().into_owned()),
                SkillManagementOperation::Create {
                    destination: SkillDestination {
                        root_kind: SkillRootKind::ProjectAgents,
                        root_id,
                        name: "demo".into(),
                    },
                    raw_document: doc("demo", "body"),
                },
            )
            .unwrap();
        fs::create_dir_all(project.join(".agents/skills")).unwrap();

        assert!(s.apply(&preview.preview_token, None).is_err());
        assert!(!project.join(".agents/skills/demo").exists());
    }

    #[test]
    fn tampered_recovery_payload_is_not_listed_or_restored() {
        let (_t, s, _) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "old")).unwrap();
        let skill = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "demo")
            .unwrap();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::Delete {
                    source: skill.source,
                    expected_version: skill.version,
                },
            )
            .unwrap();
        let approval = approve_delete(&s, &preview.preview_token);
        let recovery_ref = s
            .apply(&preview.preview_token, Some(approval))
            .unwrap()
            .recovery_ref
            .unwrap();
        let payload = recovery_root(&s.global_root)
            .join(&recovery_ref)
            .join(RECOVERY_PAYLOAD)
            .join("SKILL.md");
        fs::write(payload, doc("demo", "tampered")).unwrap();

        assert!(s.recovery_list(None).unwrap().is_empty());
        assert!(s
            .preview(None, SkillManagementOperation::Restore { recovery_ref })
            .is_err());
        assert!(!dir.exists());
    }

    #[test]
    fn expired_preview_and_cross_service_token_are_rejected() {
        let (_t, s, _) = setup();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::Create {
                    destination: SkillDestination {
                        root_kind: SkillRootKind::Global,
                        root_id: "global".into(),
                        name: "demo".into(),
                    },
                    raw_document: doc("demo", "body"),
                },
            )
            .unwrap();
        s.previews
            .lock()
            .unwrap()
            .get_mut(&preview.preview_token)
            .unwrap()
            .expires = Instant::now();
        assert!(s.apply(&preview.preview_token, None).is_err());
        assert!(!s.global_root.join("demo").exists());

        let other = SkillManagementService::new(s.global_root.clone());
        assert!(other.apply(&preview.preview_token, None).is_err());
    }

    #[test]
    fn expired_download_preview_removes_its_staging_directory() {
        let (t, s, _) = setup();
        let stage = t.path().join("download-stage");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("SKILL.md"), doc("demo", "body")).unwrap();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::Create {
                    destination: SkillDestination {
                        root_kind: SkillRootKind::Global,
                        root_id: "global".into(),
                        name: "demo".into(),
                    },
                    raw_document: doc("demo", "body"),
                },
            )
            .unwrap();
        let mut previews = s.previews.lock().unwrap();
        let pending = previews.get_mut(&preview.preview_token).unwrap();
        pending.expires = Instant::now();
        pending.response.operation = "download".into();
        pending.download_stage = Some(DownloadStageCleanup(stage.clone()));
        drop(previews);

        s.list_response(None).unwrap();

        assert!(!stage.exists());
    }

    #[test]
    fn import_rewrites_name_and_preserves_resources() {
        let (t, s, _) = setup();
        let import = t.path().join("import");
        fs::create_dir_all(import.join("scripts")).unwrap();
        fs::write(import.join("SKILL.md"), doc("original", "body")).unwrap();
        fs::write(import.join("scripts/a.txt"), "asset").unwrap();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::ImportLocal {
                    destination: SkillDestination {
                        root_kind: SkillRootKind::Global,
                        root_id: "global".into(),
                        name: "imported".into(),
                    },
                    source_path: import.to_string_lossy().into_owned(),
                },
            )
            .unwrap();
        let imported = s
            .apply(&preview.preview_token, None)
            .unwrap()
            .skill
            .unwrap();
        assert_eq!(imported.name, "imported");
        assert_eq!(
            fs::read(s.global_root.join("imported/scripts/a.txt")).unwrap(),
            b"asset"
        );
    }

    #[test]
    fn manifest_tampering_is_rejected() {
        let (_t, s, _) = setup();
        let dir = s.global_root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "old")).unwrap();
        let skill = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "demo")
            .unwrap();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::Delete {
                    source: skill.source,
                    expected_version: skill.version,
                },
            )
            .unwrap();
        let approval = approve_delete(&s, &preview.preview_token);
        let recovery_ref = s
            .apply(&preview.preview_token, Some(approval))
            .unwrap()
            .recovery_ref
            .unwrap();
        let manifest_path = recovery_root(&s.global_root)
            .join(&recovery_ref)
            .join(RECOVERY_MANIFEST);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["source"]["relativePath"] = serde_json::json!("../escape");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        assert!(s.recovery_list(None).unwrap().is_empty());
        assert!(s
            .preview(None, SkillManagementOperation::Restore { recovery_ref })
            .is_err());
    }

    #[test]
    fn failed_atomic_replace_preserves_original_bytes() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("SKILL.md");
        fs::write(&path, b"before").unwrap();
        let result = atomic_write_with(&path, b"after", |_temporary, _destination| {
            Err(std::io::Error::other("injected replace failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(path).unwrap(), b"before");
    }

    #[test]
    fn conflicting_display_metadata_shape_is_rejected() {
        let raw = "---\nname: demo\ndescription: original\nmetadata:\n  codebuddy: invalid\n---\n\nbody\n";
        let display = SkillDisplayMetadata {
            locales: HashMap::from([(
                "en".into(),
                SkillLocalizedDisplay {
                    name: "Demo".into(),
                    description: "Description".into(),
                },
            )]),
        };
        assert!(merge_display_metadata(raw, Some(&display)).is_err());
        assert!(merge_display_metadata(raw, None).is_ok());
    }

    #[test]
    fn replaced_source_directory_is_rejected_before_update() {
        let (_t, s, _) = setup();
        let dir = s.global_root.join("demo");
        let moved = s.global_root.join("moved");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "before")).unwrap();
        let skill = s
            .list(None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "demo")
            .unwrap();
        let preview = s
            .preview(
                None,
                SkillManagementOperation::UpdateRaw {
                    source: skill.source,
                    expected_version: skill.version,
                    raw_document: doc("demo", "after"),
                    display_metadata: None,
                },
            )
            .unwrap();
        fs::rename(&dir, &moved).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), doc("demo", "before")).unwrap();

        assert!(s.apply(&preview.preview_token, None).is_err());
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            doc("demo", "before")
        );
    }

    #[cfg(windows)]
    #[test]
    fn directory_reparse_escape_is_rejected() {
        use std::os::windows::fs::symlink_dir;

        let (t, s, _) = setup();
        let outside = t.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("SKILL.md"), doc("escaped", "body")).unwrap();
        symlink_dir(&outside, s.global_root.join("escaped"))
            .expect("Windows symlink privilege is required for the reparse-boundary test");
        let source = SkillSourceRef {
            root_kind: SkillRootKind::Global,
            root_id: "global".into(),
            relative_path: "escaped".into(),
        };

        assert!(s.read(None, &source).is_err());
    }
}
