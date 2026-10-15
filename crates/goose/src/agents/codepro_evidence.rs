use crate::agents::checkpoint_transaction::CheckpointFileSnapshot;
use crate::agents::codepro_workspace::WorkspaceEvidence;
use anyhow::{anyhow, Context, Result};
use ignore::{DirEntry, WalkBuilder};
use serde::{Deserialize, Serialize};
use similar::TextDiff;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::Component;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tempfile::TempDir;
use tokio::process::Command;
use tokio::sync::Mutex;

const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PATCH_BYTES: usize = 1_048_576;
const MAX_NATIVE_BASELINE_BYTES: usize = 67_108_864;
const MAX_NATIVE_BASELINE_FILES: usize = 50_000;
const UNDO_MANIFEST_FILE: &str = "manifest.json";
const INITIAL_BASELINE_REF: &str = "refs/codepro/initial";
const EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".cache",
    "coverage",
    "__pycache__",
];
#[derive(Debug, Serialize, Deserialize)]
struct UndoManifest {
    version: u8,
    entries: Vec<UndoEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct UndoEntry {
    path: String,
    before_file: Option<String>,
    after_hash: Option<String>,
}

#[derive(Default)]
struct TrackedBaseline {
    files: BTreeMap<String, Option<Vec<u8>>>,
    sensitive_files: BTreeMap<String, Option<blake3::Hash>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EvidenceCaptureOutcome {
    #[error("CodePro evidence capture timed out during {operation}")]
    TimedOut { operation: String },
    #[error("permission is required to read {path}: {reason}")]
    PermissionRequired { path: PathBuf, reason: String },
    #[error("invalid CodePro project root {path}: {reason}")]
    InvalidRoot { path: PathBuf, reason: String },
    #[error("CodePro evidence capture I/O failed at {path}: {reason}")]
    IoFailure { path: PathBuf, reason: String },
}

/// Captures a lightweight, run-scoped baseline without modifying the user's
/// repository or creating a second working tree.
///
/// Git is used only as a diff engine. The temporary repository stores the
/// baseline metadata and blobs; the user's project remains the active worktree.
pub struct CodeProEvidence {
    working_dir: PathBuf,
    git_program: OsString,
    git_dir: Option<PathBuf>,
    native_initial_baseline: Option<BTreeMap<String, Vec<u8>>>,
    native_task_baseline: Mutex<Option<BTreeMap<String, Vec<u8>>>>,
    tracked_initial_baseline: Option<Mutex<TrackedBaseline>>,
    tracked_task_baseline: Option<Mutex<TrackedBaseline>>,
    sensitive_baseline: BTreeMap<String, blake3::Hash>,
    task_sensitive_baseline: Mutex<BTreeMap<String, blake3::Hash>>,
    _temporary_repository: Option<TempDir>,
    lock: Mutex<()>,
}

impl CodeProEvidence {
    pub async fn capture(working_dir: &Path) -> std::result::Result<Self, EvidenceCaptureOutcome> {
        Self::capture_with_git_program(working_dir, "git").await
    }

    async fn capture_with_git_program(
        working_dir: &Path,
        git_program: impl Into<OsString>,
    ) -> std::result::Result<Self, EvidenceCaptureOutcome> {
        let working_dir = canonical_evidence_root(working_dir)
            .map_err(|error| classify_capture_error(working_dir, error))?;
        ensure_scannable_evidence_root(&working_dir).map_err(|error| {
            EvidenceCaptureOutcome::InvalidRoot {
                path: working_dir.clone(),
                reason: error.to_string(),
            }
        })?;
        let git_program = git_program.into();
        Ok(Self {
            working_dir,
            git_program,
            git_dir: None,
            native_initial_baseline: None,
            native_task_baseline: Mutex::new(None),
            tracked_initial_baseline: Some(Mutex::new(TrackedBaseline::default())),
            tracked_task_baseline: Some(Mutex::new(TrackedBaseline::default())),
            sensitive_baseline: BTreeMap::new(),
            task_sensitive_baseline: Mutex::new(BTreeMap::new()),
            _temporary_repository: None,
            lock: Mutex::new(()),
        })
    }

    pub async fn collect(&self) -> Result<WorkspaceEvidence> {
        if let Some(baseline) = &self.tracked_initial_baseline {
            let _guard = self.lock.lock().await;
            let baseline = baseline.lock().await;
            return build_tracked_evidence(&self.working_dir, &baseline);
        }
        let current_sensitive = capture_sensitive_files(&self.working_dir)?;
        let _guard = self.lock.lock().await;
        if let Some(baseline) = &self.native_initial_baseline {
            let current = capture_regular_files(&self.working_dir)?;
            return build_native_evidence(
                baseline,
                &current,
                &self.sensitive_baseline,
                &current_sensitive,
            );
        }
        self.collect_against(
            INITIAL_BASELINE_REF,
            &self.sensitive_baseline,
            &current_sensitive,
        )
        .await
    }

    pub async fn collect_task_delta(&self) -> Result<WorkspaceEvidence> {
        if let Some(baseline) = &self.tracked_task_baseline {
            let _guard = self.lock.lock().await;
            let mut baseline = baseline.lock().await;
            let evidence = build_tracked_evidence(&self.working_dir, &baseline)?;
            *baseline = TrackedBaseline::default();
            return Ok(evidence);
        }
        let current_sensitive = capture_sensitive_files(&self.working_dir)?;
        let _guard = self.lock.lock().await;
        let mut task_sensitive_baseline = self.task_sensitive_baseline.lock().await;
        if self.native_initial_baseline.is_some() {
            let current = capture_regular_files(&self.working_dir)?;
            let mut task_baseline = self.native_task_baseline.lock().await;
            let baseline = task_baseline.as_ref().context("CodePro 原生任务基线缺失")?;
            let evidence = build_native_evidence(
                baseline,
                &current,
                &task_sensitive_baseline,
                &current_sensitive,
            )?;
            *task_baseline = Some(current);
            *task_sensitive_baseline = current_sensitive;
            return Ok(evidence);
        }
        let evidence = self
            .collect_against("HEAD", &task_sensitive_baseline, &current_sensitive)
            .await?;
        self.run_git(&[
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "CodePro task checkpoint",
        ])
        .await?;
        *task_sensitive_baseline = current_sensitive;
        Ok(evidence)
    }

    pub async fn record_before_path(&self, path: &str) -> Result<()> {
        let (relative, target) = tracked_target(&self.working_dir, path)?;
        let Some(initial_baseline) = &self.tracked_initial_baseline else {
            return Ok(());
        };
        let task_baseline = self
            .tracked_task_baseline
            .as_ref()
            .context("CodePro 任务文件记录器缺失")?;
        let _guard = self.lock.lock().await;

        if is_sensitive_file(&target) {
            let hash = read_optional_file_hash(&target)?;
            initial_baseline
                .lock()
                .await
                .sensitive_files
                .entry(relative.clone())
                .or_insert(hash);
            task_baseline
                .lock()
                .await
                .sensitive_files
                .entry(relative)
                .or_insert(hash);
        } else {
            let contents = read_optional_regular_file(&target).await?;
            initial_baseline
                .lock()
                .await
                .files
                .entry(relative.clone())
                .or_insert_with(|| contents.clone());
            task_baseline
                .lock()
                .await
                .files
                .entry(relative)
                .or_insert(contents);
        }
        Ok(())
    }

    async fn collect_against(
        &self,
        baseline: &str,
        sensitive_baseline: &BTreeMap<String, blake3::Hash>,
        current_sensitive: &BTreeMap<String, blake3::Hash>,
    ) -> Result<WorkspaceEvidence> {
        self.run_git(&["read-tree", "HEAD"]).await?;
        self.run_git(&["add", "-A", "--"]).await?;

        let patch_output = self
            .run_git(&["diff", "--cached", "--binary", "--no-ext-diff", baseline])
            .await?;
        if patch_output.stdout.len() > MAX_PATCH_BYTES {
            return Err(anyhow!(
                "CodePro 本次修改补丁超过 {} 字节上限",
                MAX_PATCH_BYTES
            ));
        }
        let patch = String::from_utf8_lossy(&patch_output.stdout).into_owned();
        let files_output = self
            .run_git(&["diff", "--cached", "--name-only", "-z", baseline])
            .await?;
        let files_changed = files_output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect();
        let sensitive_files_changed =
            changed_sensitive_files(sensitive_baseline, current_sensitive);

        Ok(WorkspaceEvidence {
            patch,
            files_changed,
            sensitive_files_changed,
        })
    }

    async fn run_git(&self, args: &[&str]) -> Result<Output> {
        let git_dir = self
            .git_dir
            .as_ref()
            .context("CodePro 原生证据模式不能运行 Git 命令")?;
        let output = tokio::time::timeout(
            GIT_TIMEOUT,
            Command::new(&self.git_program)
                .args(args)
                .current_dir(&self.working_dir)
                .env("GIT_DIR", git_dir)
                .env("GIT_WORK_TREE", &self.working_dir)
                .output(),
        )
        .await
        .map_err(|_| anyhow!("CodePro 证据命令超时: git {}", args.join(" ")))??;
        ensure_success(&format!("git {}", args.join(" ")), &output)?;
        Ok(output)
    }

    pub async fn persist_undo_bundle(&self, bundle_dir: &Path) -> Result<()> {
        let evidence = self.collect().await?;
        tokio::fs::create_dir_all(bundle_dir).await?;
        let files_dir = bundle_dir.join("files");
        tokio::fs::create_dir_all(&files_dir).await?;
        let mut entries = Vec::with_capacity(evidence.files_changed.len());
        let mut backup_bytes = 0usize;

        for (index, path) in evidence.files_changed.iter().enumerate() {
            let before = self.baseline_file(path).await?;
            let target = safe_relative_target(&self.working_dir, path)?;
            let after = read_optional_regular_file(&target).await?;
            let before_file = if let Some(contents) = before {
                backup_bytes = backup_bytes
                    .checked_add(contents.len())
                    .context("CodePro 撤销备份大小溢出")?;
                if backup_bytes > MAX_NATIVE_BASELINE_BYTES {
                    return Err(anyhow!(
                        "CodePro 撤销备份超过 {} MiB 上限",
                        MAX_NATIVE_BASELINE_BYTES / 1_048_576
                    ));
                }
                let file_name = format!("{index}.bin");
                tokio::fs::write(files_dir.join(&file_name), contents).await?;
                Some(file_name)
            } else {
                None
            };
            entries.push(UndoEntry {
                path: path.clone(),
                before_file,
                after_hash: after
                    .as_deref()
                    .map(|contents| blake3::hash(contents).to_hex().to_string()),
            });
        }

        let manifest = serde_json::to_vec_pretty(&UndoManifest {
            version: 1,
            entries,
        })?;
        tokio::fs::write(bundle_dir.join(UNDO_MANIFEST_FILE), manifest).await?;
        Ok(())
    }

    pub(crate) async fn checkpoint_file_snapshots(&self) -> Result<Vec<CheckpointFileSnapshot>> {
        let evidence = self.collect().await?;
        let mut snapshots = Vec::with_capacity(evidence.files_changed.len());
        for path in evidence.files_changed {
            snapshots.push(CheckpointFileSnapshot {
                before: self.baseline_file(&path).await?,
                relative_path: path,
            });
        }
        Ok(snapshots)
    }

    pub async fn restore_undo_bundle(working_dir: &Path, bundle_dir: &Path) -> Result<()> {
        let working_dir = working_dir.canonicalize()?;
        let manifest: UndoManifest = serde_json::from_slice(
            &tokio::fs::read(bundle_dir.join(UNDO_MANIFEST_FILE))
                .await
                .context("读取 CodePro 撤销清单失败")?,
        )
        .context("解析 CodePro 撤销清单失败")?;
        if manifest.version != 1 {
            return Err(anyhow!("不支持的 CodePro 撤销清单版本"));
        }

        let mut validated = Vec::with_capacity(manifest.entries.len());
        for entry in manifest.entries {
            let target = safe_relative_target(&working_dir, &entry.path)?;
            let current = read_optional_regular_file(&target).await?;
            let current_hash = current
                .as_deref()
                .map(|contents| blake3::hash(contents).to_hex().to_string());
            if current_hash != entry.after_hash {
                return Err(anyhow!(
                    "文件 {} 在 CodePro 完成后又被修改，已拒绝覆盖",
                    entry.path
                ));
            }
            let before = match entry.before_file {
                Some(file_name) => Some(
                    tokio::fs::read(bundle_dir.join("files").join(file_name))
                        .await
                        .with_context(|| format!("读取 {} 的撤销内容失败", entry.path))?,
                ),
                None => None,
            };
            validated.push((target, before));
        }

        for (target, before) in validated {
            if let Some(contents) = before {
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(target, contents).await?;
            } else if target.exists() {
                tokio::fs::remove_file(target).await?;
            }
        }
        Ok(())
    }

    async fn baseline_file(&self, path: &str) -> Result<Option<Vec<u8>>> {
        if let Some(baseline) = &self.tracked_initial_baseline {
            return Ok(baseline.lock().await.files.get(path).cloned().flatten());
        }
        if let Some(baseline) = &self.native_initial_baseline {
            return Ok(baseline.get(path).cloned());
        }
        let git_dir = self.git_dir.as_ref().context("CodePro Git 基线缺失")?;
        let spec = format!("{INITIAL_BASELINE_REF}:{path}");
        let output = tokio::time::timeout(
            GIT_TIMEOUT,
            Command::new(&self.git_program)
                .args(["show", &spec])
                .current_dir(&self.working_dir)
                .env("GIT_DIR", git_dir)
                .env("GIT_WORK_TREE", &self.working_dir)
                .output(),
        )
        .await
        .map_err(|_| anyhow!("读取 CodePro 撤销基线超时"))??;
        Ok(output.status.success().then_some(output.stdout))
    }
}

fn safe_relative_target(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative_path = Path::new(relative);
    if relative_path.as_os_str().is_empty()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(anyhow!("CodePro 撤销清单包含不安全路径: {relative}"));
    }
    let mut target = root.to_path_buf();
    for component in relative_path.components() {
        let Component::Normal(name) = component else {
            unreachable!()
        };
        target.push(name);
        if let Ok(metadata) = std::fs::symlink_metadata(&target) {
            if metadata.file_type().is_symlink() {
                return Err(anyhow!("CodePro 撤销目标包含符号链接: {relative}"));
            }
        }
    }
    Ok(target)
}

fn canonical_evidence_root(path: &Path) -> Result<PathBuf> {
    let canonical = path.canonicalize()?;
    #[cfg(target_os = "windows")]
    {
        let display = canonical.to_string_lossy();
        if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(drive_path) = display.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(drive_path));
        }
    }
    Ok(canonical)
}

fn classify_capture_error(path: &Path, error: anyhow::Error) -> EvidenceCaptureOutcome {
    if let Some(io_error) = error.downcast_ref::<std::io::Error>() {
        if io_error.kind() == ErrorKind::PermissionDenied {
            return EvidenceCaptureOutcome::PermissionRequired {
                path: path.to_path_buf(),
                reason: io_error.to_string(),
            };
        }
    }
    EvidenceCaptureOutcome::IoFailure {
        path: path.to_path_buf(),
        reason: error.to_string(),
    }
}

fn ensure_scannable_evidence_root(path: &Path) -> Result<()> {
    if path.parent().is_none() {
        return Err(anyhow!(
            "CodePro 不能把文件系统根目录 {} 作为项目目录，请先选择或创建一个具体项目文件夹",
            path.display()
        ));
    }
    Ok(())
}

fn normalize_evidence_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let display = path.to_string_lossy();
        if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(drive_path) = display.strip_prefix(r"\\?\") {
            return PathBuf::from(drive_path);
        }
    }
    path.to_path_buf()
}

fn tracked_target(root: &Path, path: &str) -> Result<(String, PathBuf)> {
    let path = normalize_evidence_path(Path::new(path));
    let relative = if path.is_absolute() {
        path.strip_prefix(root)
            .with_context(|| format!("CodePro 文件不在当前项目内: {}", path.display()))?
            .to_path_buf()
    } else {
        path
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    let target = safe_relative_target(root, &relative)?;
    Ok((relative, target))
}

fn read_optional_file_hash(path: &Path) -> Result<Option<blake3::Hash>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(anyhow!(
            "CodePro 敏感文件不能是符号链接: {}",
            path.display()
        )),
        Ok(metadata) if metadata.is_file() => Ok(Some(blake3::hash(&std::fs::read(path)?))),
        Ok(_) => Err(anyhow!("CodePro 敏感路径不是普通文件: {}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn read_optional_regular_file(path: &Path) -> Result<Option<Vec<u8>>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(anyhow!(
            "CodePro 撤销目标不能是符号链接: {}",
            path.display()
        )),
        Ok(metadata) if metadata.is_file() => Ok(Some(tokio::fs::read(path).await?)),
        Ok(_) => Err(anyhow!("CodePro 撤销目标不是普通文件: {}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn build_tracked_evidence(root: &Path, tracked: &TrackedBaseline) -> Result<WorkspaceEvidence> {
    let baseline = tracked
        .files
        .iter()
        .filter_map(|(path, contents)| contents.clone().map(|contents| (path.clone(), contents)))
        .collect::<BTreeMap<_, _>>();
    let mut current = BTreeMap::new();
    for path in tracked.files.keys() {
        let target = safe_relative_target(root, path)?;
        if let Some(contents) = std::fs::read(&target)
            .map(Some)
            .or_else(|error| {
                if error.kind() == ErrorKind::NotFound {
                    Ok(None)
                } else {
                    Err(error)
                }
            })
            .with_context(|| format!("读取 CodePro 修改结果失败: {path}"))?
        {
            current.insert(path.clone(), contents);
        }
    }

    let sensitive_baseline = tracked
        .sensitive_files
        .iter()
        .filter_map(|(path, hash)| hash.map(|hash| (path.clone(), hash)))
        .collect::<BTreeMap<_, _>>();
    let mut current_sensitive = BTreeMap::new();
    for path in tracked.sensitive_files.keys() {
        let target = safe_relative_target(root, path)?;
        if let Some(hash) = read_optional_file_hash(&target)? {
            current_sensitive.insert(path.clone(), hash);
        }
    }

    build_native_evidence(&baseline, &current, &sensitive_baseline, &current_sensitive)
}

fn capture_regular_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut snapshot = BTreeMap::new();
    let mut total_bytes = 0usize;
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .filter_entry(should_scan_entry)
        .build();

    for entry in walker {
        let entry = entry.context("扫描项目文件失败")?;
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
            || is_sensitive_file(entry.path())
        {
            continue;
        }
        if snapshot.len() >= MAX_NATIVE_BASELINE_FILES {
            return Err(anyhow!(
                "CodePro 原生证据基线超过 {} 个文件上限，请安装 Git 或缩小项目目录",
                MAX_NATIVE_BASELINE_FILES
            ));
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .context("项目文件不在工作目录内")?
            .to_string_lossy()
            .replace('\\', "/");
        let contents =
            std::fs::read(entry.path()).with_context(|| format!("无法读取项目文件 {relative}"))?;
        total_bytes = total_bytes
            .checked_add(contents.len())
            .context("CodePro 原生证据基线大小溢出")?;
        if total_bytes > MAX_NATIVE_BASELINE_BYTES {
            return Err(anyhow!(
                "CodePro 原生证据基线超过 {} MiB 上限，请安装 Git 或缩小项目目录",
                MAX_NATIVE_BASELINE_BYTES / 1_048_576
            ));
        }
        snapshot.insert(relative, contents);
    }
    Ok(snapshot)
}

fn build_native_evidence(
    baseline: &BTreeMap<String, Vec<u8>>,
    current: &BTreeMap<String, Vec<u8>>,
    sensitive_baseline: &BTreeMap<String, blake3::Hash>,
    current_sensitive: &BTreeMap<String, blake3::Hash>,
) -> Result<WorkspaceEvidence> {
    let files_changed = baseline
        .keys()
        .chain(current.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| baseline.get(*path) != current.get(*path))
        .cloned()
        .collect::<Vec<_>>();
    let mut patch = String::new();

    for path in &files_changed {
        let before = baseline.get(path);
        let after = current.get(path);
        patch.push_str(&format!("diff --git a/{path} b/{path}\n"));
        match (before, after) {
            (None, Some(_)) => patch.push_str("new file mode 100644\n"),
            (Some(_), None) => patch.push_str("deleted file mode 100644\n"),
            _ => {}
        }
        let before_text = match before {
            Some(bytes) => std::str::from_utf8(bytes).ok(),
            None => Some(""),
        };
        let after_text = match after {
            Some(bytes) => std::str::from_utf8(bytes).ok(),
            None => Some(""),
        };
        match (before_text, after_text) {
            (Some(before_text), Some(after_text)) => {
                let old_header = if before.is_some() {
                    format!("a/{path}")
                } else {
                    "/dev/null".to_string()
                };
                let new_header = if after.is_some() {
                    format!("b/{path}")
                } else {
                    "/dev/null".to_string()
                };
                patch.push_str(
                    &TextDiff::from_lines(before_text, after_text)
                        .unified_diff()
                        .header(&old_header, &new_header)
                        .to_string(),
                );
            }
            _ => patch.push_str(&format!("Binary files a/{path} and b/{path} differ\n")),
        }
        if patch.len() > MAX_PATCH_BYTES {
            return Err(anyhow!(
                "CodePro 本次修改补丁超过 {} 字节上限",
                MAX_PATCH_BYTES
            ));
        }
    }

    Ok(WorkspaceEvidence {
        patch,
        files_changed,
        sensitive_files_changed: changed_sensitive_files(sensitive_baseline, current_sensitive),
    })
}

fn capture_sensitive_files(root: &Path) -> Result<BTreeMap<String, blake3::Hash>> {
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .filter_entry(should_scan_entry)
        .build();

    capture_sensitive_file_entries(root, walker)
}

fn capture_sensitive_file_entries<I>(
    root: &Path,
    entries: I,
) -> Result<BTreeMap<String, blake3::Hash>>
where
    I: IntoIterator<Item = std::result::Result<DirEntry, ignore::Error>>,
{
    let mut snapshot = BTreeMap::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "CodePro skipped an unreadable entry while scanning sensitive files"
                );
                continue;
            }
        };
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
            || !is_sensitive_file(entry.path())
        {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            tracing::warn!(
                path = %entry.path().display(),
                "CodePro skipped a sensitive file outside the project directory"
            );
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let contents = match std::fs::read(entry.path()) {
            Ok(contents) => contents,
            Err(error) => {
                tracing::warn!(
                    path = %relative,
                    error = %error,
                    "CodePro skipped an unreadable sensitive file"
                );
                continue;
            }
        };
        snapshot.insert(relative, blake3::hash(&contents));
    }
    Ok(snapshot)
}

fn should_scan_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0
        || !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_dir())
    {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !EXCLUDED_DIRECTORIES.contains(&name.as_ref())
}

fn is_sensitive_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name == ".env" || name.starts_with(".env.") || name.ends_with(".pem") || name.ends_with(".key")
}

fn changed_sensitive_files(
    baseline: &BTreeMap<String, blake3::Hash>,
    current: &BTreeMap<String, blake3::Hash>,
) -> Vec<String> {
    baseline
        .keys()
        .chain(current.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| baseline.get(*path) != current.get(*path))
        .cloned()
        .collect()
}

fn ensure_success(command: &str, output: &Output) -> Result<()> {
    if output.status.success() {
        return Ok(());
    }
    Err(anyhow!(
        "{} 失败: {}",
        command,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn user_git(project: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .args(args)
            .current_dir(project)
            .output()
            .await
            .unwrap()
    }

    #[test]
    fn filesystem_root_is_rejected_before_evidence_scanning() {
        let current = std::env::current_dir().unwrap().canonicalize().unwrap();
        let root = current.ancestors().last().unwrap();

        let error = ensure_scannable_evidence_root(root).unwrap_err();

        assert!(error.to_string().contains("项目文件夹"));
    }

    #[tokio::test]
    async fn project_start_uses_lazy_record_before_without_a_temporary_git_index() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("app.txt"), "before\n")
            .await
            .unwrap();

        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        assert!(evidence.git_dir.is_none());
        assert!(evidence.native_initial_baseline.is_none());
        assert!(evidence.tracked_initial_baseline.is_some());
        assert!(!project.path().join(".git").exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn large_dirty_project_never_runs_legacy_git_add_before_planning() {
        let project = tempfile::tempdir().unwrap();
        let generated = project.path().join("target").join("debug");
        tokio::fs::create_dir_all(&generated).await.unwrap();
        for index in 0..2_000 {
            tokio::fs::write(generated.join(format!("artifact-{index}.bin")), b"dirty")
                .await
                .unwrap();
        }
        let sentinel = project.path().join("legacy-git-add-was-called.txt");
        let helper = project.path().join("slow-git.cmd");
        tokio::fs::write(
            &helper,
            format!(
                "@echo off\r\nif \"%1\"==\"add\" (echo called>\"{}\" & ping 127.0.0.1 -n 70 >nul)\r\nexit /b 0\r\n",
                sentinel.display()
            ),
        )
        .await
        .unwrap();

        let started = std::time::Instant::now();
        let evidence = CodeProEvidence::capture_with_git_program(project.path(), &helper)
            .await
            .unwrap();

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(evidence.tracked_initial_baseline.is_some());
        assert!(!sentinel.exists());
    }

    #[tokio::test]
    async fn captures_only_changes_made_after_the_run_baseline() {
        let project = tempfile::tempdir().unwrap();
        let file = project.path().join("app.txt");
        tokio::fs::write(&file, "state before CodePro\n")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        evidence.record_before_path("app.txt").await.unwrap();
        tokio::fs::write(&file, "state changed by CodePro\n")
            .await
            .unwrap();
        let result = evidence.collect().await.unwrap();

        assert!(result.patch.contains("-state before CodePro"));
        assert!(result.patch.contains("+state changed by CodePro"));
        assert_eq!(result.files_changed, vec!["app.txt"]);
    }

    #[tokio::test]
    async fn supports_non_git_projects_without_adding_dot_git() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("old.txt"), "old")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        evidence.record_before_path("new.txt").await.unwrap();
        tokio::fs::write(project.path().join("new.txt"), "new")
            .await
            .unwrap();
        let result = evidence.collect().await.unwrap();

        assert!(!project.path().join(".git").exists());
        assert!(result.files_changed.contains(&"new.txt".to_string()));
        assert!(result.patch.contains("new file mode"));
    }

    #[tokio::test]
    async fn unregistered_user_or_shell_writes_are_not_attributed_to_codepro() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("app.txt"), "before\n")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        tokio::fs::write(project.path().join("app.txt"), "after\n")
            .await
            .unwrap();
        tokio::fs::write(project.path().join("created-by-shell.txt"), "new\n")
            .await
            .unwrap();
        let result = evidence.collect().await.unwrap();

        assert!(result.files_changed.is_empty());
        assert!(result.patch.is_empty());
        assert!(!project.path().join(".git").exists());
    }

    #[tokio::test]
    async fn lazy_evidence_captures_only_declared_targets() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("tracked.txt"), "before\n")
            .await
            .unwrap();
        tokio::fs::write(project.path().join("unrelated.txt"), "before\n")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        evidence.record_before_path("tracked.txt").await.unwrap();
        tokio::fs::write(project.path().join("tracked.txt"), "after\n")
            .await
            .unwrap();
        tokio::fs::write(project.path().join("unrelated.txt"), "external change\n")
            .await
            .unwrap();
        let result = evidence.collect().await.unwrap();

        assert_eq!(result.files_changed, vec!["tracked.txt"]);
        assert!(result.patch.contains("-before"));
        assert!(result.patch.contains("+after"));
        assert!(!result.patch.contains("unrelated.txt"));
        assert!(!result.patch.contains("external change"));
    }

    #[tokio::test]
    async fn falls_back_to_native_evidence_when_git_executable_is_missing() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("app.txt"), "before\n")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture_with_git_program(
            project.path(),
            "codepro-definitely-missing-git",
        )
        .await
        .unwrap();

        evidence.record_before_path("app.txt").await.unwrap();
        tokio::fs::write(project.path().join("app.txt"), "after\n")
            .await
            .unwrap();
        let result = evidence.collect().await.unwrap();

        assert_eq!(result.files_changed, vec!["app.txt"]);
        assert!(result.patch.contains("-before"));
        assert!(result.patch.contains("+after"));
    }

    #[tokio::test]
    async fn undo_bundle_restores_only_changed_files_without_git() {
        let project = tempfile::tempdir().unwrap();
        let bundle = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("app.txt"), "before\n")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture_with_git_program(
            project.path(),
            "codepro-definitely-missing-git",
        )
        .await
        .unwrap();
        evidence.record_before_path("app.txt").await.unwrap();
        evidence.record_before_path("new.txt").await.unwrap();
        tokio::fs::write(project.path().join("app.txt"), "after\n")
            .await
            .unwrap();
        tokio::fs::write(project.path().join("new.txt"), "new\n")
            .await
            .unwrap();

        evidence.persist_undo_bundle(bundle.path()).await.unwrap();
        CodeProEvidence::restore_undo_bundle(project.path(), bundle.path())
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(project.path().join("app.txt"))
                .await
                .unwrap(),
            "before\n"
        );
        assert!(!project.path().join("new.txt").exists());
    }

    #[tokio::test]
    async fn undo_refuses_to_overwrite_a_users_later_edit() {
        let project = tempfile::tempdir().unwrap();
        let bundle = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("app.txt"), "before\n")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture_with_git_program(
            project.path(),
            "codepro-definitely-missing-git",
        )
        .await
        .unwrap();
        evidence.record_before_path("app.txt").await.unwrap();
        tokio::fs::write(project.path().join("app.txt"), "agent change\n")
            .await
            .unwrap();
        evidence.persist_undo_bundle(bundle.path()).await.unwrap();
        tokio::fs::write(project.path().join("app.txt"), "user change\n")
            .await
            .unwrap();

        let error = CodeProEvidence::restore_undo_bundle(project.path(), bundle.path())
            .await
            .unwrap_err();

        assert!(error.to_string().contains("app.txt"));
        assert_eq!(
            tokio::fs::read_to_string(project.path().join("app.txt"))
                .await
                .unwrap(),
            "user change\n"
        );
    }

    #[tokio::test]
    async fn undo_restores_a_file_deleted_by_codepro() {
        let project = tempfile::tempdir().unwrap();
        let bundle = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("deleted.txt"), "restore me\n")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture_with_git_program(
            project.path(),
            "codepro-definitely-missing-git",
        )
        .await
        .unwrap();
        evidence.record_before_path("deleted.txt").await.unwrap();
        tokio::fs::remove_file(project.path().join("deleted.txt"))
            .await
            .unwrap();

        evidence.persist_undo_bundle(bundle.path()).await.unwrap();
        CodeProEvidence::restore_undo_bundle(project.path(), bundle.path())
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(project.path().join("deleted.txt"))
                .await
                .unwrap(),
            "restore me\n"
        );
    }

    #[tokio::test]
    async fn excludes_large_generated_directories_from_evidence() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("app.txt"), "before")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        evidence.record_before_path("app.txt").await.unwrap();
        tokio::fs::create_dir(project.path().join("target"))
            .await
            .unwrap();
        tokio::fs::write(project.path().join("target").join("large.bin"), "generated")
            .await
            .unwrap();
        tokio::fs::write(project.path().join("app.txt"), "after")
            .await
            .unwrap();
        let result = evidence.collect().await.unwrap();

        assert_eq!(result.files_changed, vec!["app.txt"]);
    }

    #[tokio::test]
    async fn reports_sensitive_file_changes_without_exposing_their_contents() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join(".env"), "API_KEY=before-secret")
            .await
            .unwrap();
        tokio::fs::write(project.path().join("app.txt"), "before")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        evidence.record_before_path(".env").await.unwrap();
        evidence.record_before_path("app.txt").await.unwrap();
        tokio::fs::write(project.path().join(".env"), "API_KEY=after-secret")
            .await
            .unwrap();
        tokio::fs::write(project.path().join("app.txt"), "after")
            .await
            .unwrap();
        let result = evidence.collect().await.unwrap();

        assert_eq!(result.sensitive_files_changed, vec![".env"]);
        assert!(!result.patch.contains("before-secret"));
        assert!(!result.patch.contains("after-secret"));
        assert!(result.patch.contains("app.txt"));
    }

    #[test]
    fn sensitive_scan_skips_unreadable_entries_instead_of_blocking_the_session() {
        let project = tempfile::tempdir().unwrap();
        let entries = vec![Err(ignore::Error::Io(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "access denied",
        )))];

        let snapshot = capture_sensitive_file_entries(project.path(), entries).unwrap();

        assert!(snapshot.is_empty());
    }

    #[tokio::test]
    async fn task_deltas_are_isolated_while_final_evidence_keeps_the_full_run() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("first.txt"), "before")
            .await
            .unwrap();
        tokio::fs::write(project.path().join("second.txt"), "before")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        evidence.record_before_path("first.txt").await.unwrap();
        tokio::fs::write(project.path().join("first.txt"), "task one")
            .await
            .unwrap();
        let first = evidence.collect_task_delta().await.unwrap();
        evidence.record_before_path("second.txt").await.unwrap();
        tokio::fs::write(project.path().join("second.txt"), "task two")
            .await
            .unwrap();
        let second = evidence.collect_task_delta().await.unwrap();
        let final_evidence = evidence.collect().await.unwrap();

        assert_eq!(first.files_changed, vec!["first.txt"]);
        assert_eq!(second.files_changed, vec!["second.txt"]);
        assert!(second.patch.contains("second.txt"));
        assert!(!second.patch.contains("first.txt"));
        assert!(final_evidence.patch.contains("first.txt"));
        assert!(final_evidence.patch.contains("second.txt"));
    }

    #[tokio::test]
    async fn task_delta_detects_each_registered_write_once() {
        let project = tempfile::tempdir().unwrap();
        tokio::fs::write(project.path().join("app.txt"), "zero\n")
            .await
            .unwrap();
        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

        evidence.record_before_path("app.txt").await.unwrap();
        tokio::fs::write(project.path().join("app.txt"), "one\n")
            .await
            .unwrap();
        let first = evidence.collect_task_delta().await.unwrap();
        assert_eq!(first.files_changed, vec!["app.txt"]);

        evidence.record_before_path("second.txt").await.unwrap();
        tokio::fs::write(project.path().join("second.txt"), "two\n")
            .await
            .unwrap();
        let second = evidence.collect_task_delta().await.unwrap();
        assert_eq!(second.files_changed, vec!["second.txt"]);

        let third = evidence.collect_task_delta().await.unwrap();
        assert!(third.files_changed.is_empty());
    }

    #[tokio::test]
    async fn does_not_change_the_users_real_git_index() {
        let project = tempfile::tempdir().unwrap();
        assert!(user_git(project.path(), &["init", "--quiet"])
            .await
            .status
            .success());
        assert!(user_git(
            project.path(),
            &["config", "user.email", "user@example.test"]
        )
        .await
        .status
        .success());
        assert!(user_git(project.path(), &["config", "user.name", "User"])
            .await
            .status
            .success());
        tokio::fs::write(project.path().join("app.txt"), "base")
            .await
            .unwrap();
        assert!(user_git(project.path(), &["add", "app.txt"])
            .await
            .status
            .success());
        assert!(
            user_git(project.path(), &["commit", "--quiet", "-m", "base"])
                .await
                .status
                .success()
        );
        tokio::fs::write(project.path().join("staged.txt"), "user staged")
            .await
            .unwrap();
        assert!(user_git(project.path(), &["add", "staged.txt"])
            .await
            .status
            .success());
        let index_before = user_git(project.path(), &["diff", "--cached", "--binary"]).await;

        let evidence = CodeProEvidence::capture(project.path()).await.unwrap();
        evidence.record_before_path("app.txt").await.unwrap();
        tokio::fs::write(project.path().join("app.txt"), "changed by CodePro")
            .await
            .unwrap();
        let result = evidence.collect().await.unwrap();
        let index_after = user_git(project.path(), &["diff", "--cached", "--binary"]).await;

        assert_eq!(index_before.stdout, index_after.stdout);
        assert!(result.files_changed.contains(&"app.txt".to_string()));
        assert!(!result.files_changed.contains(&"staged.txt".to_string()));
    }
}
