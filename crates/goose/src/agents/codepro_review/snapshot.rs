use super::git::ReadonlyGit;
use super::{
    ReviewCoverage, ReviewExclusion, ReviewExclusionReason, ReviewFile, ReviewHunk, ReviewModel,
    ReviewScope, ReviewSnapshot, MAX_REVIEW_CONTENT_BYTES, MAX_REVIEW_FILES, MAX_REVIEW_FILE_BYTES,
    REVIEW_SCHEMA_VERSION,
};
use crate::agents::platform_extensions::git::is_sensitive_git_path;
use anyhow::{bail, ensure, Result};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct SnapshotRequest {
    pub session_id: String,
    pub working_dir: PathBuf,
    pub scope: ReviewScope,
    pub base_ref: Option<String>,
    pub model: ReviewModel,
}

struct Entry {
    path: String,
    original_path: Option<String>,
    status: String,
    old_mode: String,
    new_mode: String,
    old_oid: String,
    new_oid: String,
}

enum Content {
    Bytes(Vec<u8>),
    Excluded(ReviewExclusionReason),
}

pub async fn capture_snapshot(
    input: &SnapshotRequest,
    cancel: CancellationToken,
) -> Result<ReviewSnapshot> {
    ensure!(
        !input.session_id.trim().is_empty()
            && !input.model.provider.trim().is_empty()
            && !input.model.model.trim().is_empty(),
        "review_identity_required"
    );
    ensure!(
        input.working_dir.is_absolute(),
        "review_absolute_directory_required"
    );
    match (&input.scope, &input.base_ref) {
        (ReviewScope::Branch, Some(base)) => {
            ensure!(
                !base.is_empty()
                    && base.len() <= 200
                    && !base.starts_with('-')
                    && !base.contains("..")
                    && base
                        .chars()
                        .all(|c| c.is_alphanumeric() || matches!(c, '/' | '-' | '_' | '.')),
                "invalid_review_base"
            );
        }
        (ReviewScope::Branch, None) => bail!("review_base_required"),
        (_, Some(_)) => bail!("review_base_not_allowed"),
        (_, None) => {}
    }
    let work = async {
        let git = ReadonlyGit::open(&input.working_dir, cancel.clone()).await?;
        for _ in 0..2 {
            let first = capture_once(&git, input).await?;
            let mut second = capture_once(&git, input).await?;
            if first.fingerprint == second.fingerprint {
                second.snapshot_id = uuid::Uuid::now_v7().to_string();
                second.captured_at = chrono::Utc::now().to_rfc3339();
                return Ok(second);
            }
        }
        bail!("repository_changed")
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => bail!("review_cancelled"),
        result = tokio::time::timeout(Duration::from_secs(120), work) => {
            result.map_err(|_| anyhow::anyhow!("review_capture_timeout"))?
        }
    }
}

async fn capture_once(git: &ReadonlyGit, input: &SnapshotRequest) -> Result<ReviewSnapshot> {
    let head = git.optional_head().await?;
    let mut args = vec![
        "diff".to_owned(),
        "--raw".into(),
        "-z".into(),
        "--no-abbrev".into(),
        "--find-renames".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
    ];
    let mut base_oid = None;
    let mut base_tip = None;
    match input.scope {
        ReviewScope::WorkingTree => {}
        ReviewScope::Staged => {
            args.push("--cached".into());
            if let Some(head) = &head {
                args.push(head.clone());
            }
        }
        ReviewScope::Branch => {
            let head = head
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("review_head_required"))?;
            let reference = format!(
                "{}^{{commit}}",
                input.base_ref.as_deref().unwrap_or_default()
            );
            let resolved = git
                .required(&["rev-parse", "--verify", "--end-of-options", &reference])
                .await?;
            let resolved = std::str::from_utf8(&resolved)?.trim().to_owned();
            let base = git.required(&["merge-base", &resolved, head]).await?;
            let base = std::str::from_utf8(&base)?.trim().to_owned();
            args.extend([base.clone(), head.to_owned()]);
            base_oid = Some(base);
            base_tip = Some(resolved);
        }
    }
    args.push("--".into());
    let raw = git
        .required(&args.iter().map(String::as_str).collect::<Vec<_>>())
        .await?;
    let mut entries = parse_entries(&raw)?;
    let untracked = if input.scope == ReviewScope::WorkingTree {
        git.required(&["ls-files", "--others", "--exclude-standard", "-z"])
            .await?
    } else {
        Vec::new()
    };
    for path in untracked
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        entries.push(Entry {
            path: std::str::from_utf8(path)?.to_owned(),
            original_path: None,
            status: "A".into(),
            old_mode: "000000".into(),
            new_mode: "100644".into(),
            old_oid: String::new(),
            new_oid: String::new(),
        });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let mut files = Vec::new();
    let mut excluded = Vec::new();
    let mut content_bytes = 0;
    for (index, entry) in entries.into_iter().enumerate() {
        validate_path(&entry.path)?;
        if let Some(path) = &entry.original_path {
            validate_path(path)?;
        }
        let content = if index >= MAX_REVIEW_FILES {
            Err(ReviewExclusionReason::FileLimit)
        } else {
            capture_file(git, input.scope, &entry).await?
        };
        match content {
            Ok(file) => {
                let bytes = file.old_text.len() + file.new_text.len() + file.diff.len();
                if content_bytes + bytes > MAX_REVIEW_CONTENT_BYTES {
                    excluded.push(ReviewExclusion {
                        path: entry.path,
                        reason: ReviewExclusionReason::ContentLimit,
                    });
                } else {
                    content_bytes += bytes;
                    files.push(file);
                }
            }
            Err(reason) => excluded.push(ReviewExclusion {
                path: entry.path,
                reason,
            }),
        }
    }
    let fingerprint = digest(&serde_json::to_vec(&(
        &git.root,
        &input.session_id,
        input.scope,
        &input.base_ref,
        &head,
        &base_oid,
        &base_tip,
        &input.model,
        digest(&raw),
        digest(&untracked),
        &files,
        &excluded,
    ))?);
    Ok(ReviewSnapshot {
        schema_version: REVIEW_SCHEMA_VERSION,
        snapshot_id: String::new(),
        session_id: input.session_id.clone(),
        scope: input.scope,
        base_ref: input.base_ref.clone(),
        head_oid: head,
        base_oid,
        model: input.model.clone(),
        files,
        coverage: if excluded.is_empty() {
            ReviewCoverage::Complete
        } else {
            ReviewCoverage::Partial
        },
        excluded_files: excluded,
        fingerprint,
        captured_at: String::new(),
    })
}

async fn capture_file(
    git: &ReadonlyGit,
    scope: ReviewScope,
    entry: &Entry,
) -> Result<std::result::Result<ReviewFile, ReviewExclusionReason>> {
    if is_sensitive_git_path(&entry.path)
        || entry
            .original_path
            .as_deref()
            .is_some_and(is_sensitive_git_path)
    {
        return Ok(Err(ReviewExclusionReason::SensitivePath));
    }
    if [&entry.old_mode, &entry.new_mode]
        .iter()
        .any(|mode| !matches!(mode.as_str(), "000000" | "100644" | "100755"))
    {
        return Ok(Err(ReviewExclusionReason::NonRegularFile));
    }
    let old = read_blob(git, &entry.old_oid).await?;
    let new = if entry.new_mode == "000000" {
        Content::Bytes(Vec::new())
    } else if scope == ReviewScope::WorkingTree {
        read_worktree(&git.root, &entry.path)?
    } else {
        read_blob(git, &entry.new_oid).await?
    };
    let (old, new) = match (old, new) {
        (Content::Bytes(old), Content::Bytes(new)) => (old, new),
        (Content::Excluded(reason), _) | (_, Content::Excluded(reason)) => return Ok(Err(reason)),
    };
    if old.contains(&0) || new.contains(&0) {
        return Ok(Err(ReviewExclusionReason::BinaryOrNonUtf8));
    }
    let (Ok(old_text), Ok(new_text)) = (std::str::from_utf8(&old), std::str::from_utf8(&new))
    else {
        return Ok(Err(ReviewExclusionReason::BinaryOrNonUtf8));
    };
    let text_diff = TextDiff::configure()
        .timeout(Duration::from_millis(100))
        .diff_lines(old_text, new_text);
    let unified = text_diff.unified_diff().context_radius(3).to_string();
    let hunks = text_diff
        .grouped_ops(3)
        .into_iter()
        .map(|ops| {
            let first = ops.first().expect("non-empty diff group");
            let last = ops.last().expect("non-empty diff group");
            let old_count = last.old_range().end - first.old_range().start;
            let new_count = last.new_range().end - first.new_range().start;
            ReviewHunk {
                old_start: (first.old_range().start + usize::from(old_count > 0)) as u32,
                old_count: old_count as u32,
                new_start: (first.new_range().start + usize::from(new_count > 0)) as u32,
                new_count: new_count as u32,
            }
        })
        .collect();
    Ok(Ok(ReviewFile {
        path: entry.path.clone(),
        original_path: entry.original_path.clone(),
        status: entry.status.clone(),
        old_text: old_text.into(),
        new_text: new_text.into(),
        old_hash: digest(&old),
        new_hash: digest(&new),
        diff: unified,
        hunks,
    }))
}

async fn read_blob(git: &ReadonlyGit, oid: &str) -> Result<Content> {
    if oid.is_empty() || oid.bytes().all(|byte| byte == b'0') {
        return Ok(Content::Bytes(Vec::new()));
    }
    ensure!(
        matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid_review_oid"
    );
    let size = git.required(&["cat-file", "-s", oid]).await?;
    let size: usize = std::str::from_utf8(&size)?.trim().parse()?;
    if size > MAX_REVIEW_FILE_BYTES {
        return Ok(Content::Excluded(ReviewExclusionReason::FileTooLarge));
    }
    let bytes = git.required(&["cat-file", "blob", oid]).await?;
    ensure!(bytes.len() == size, "review_blob_size_changed");
    Ok(Content::Bytes(bytes))
}

fn read_worktree(root: &Path, relative: &str) -> Result<Content> {
    let path = root.join(relative);
    let mut cursor = root.to_path_buf();
    for component in Path::new(relative).components() {
        cursor.push(component);
        let metadata = std::fs::symlink_metadata(&cursor)?;
        if is_link(&metadata) {
            return Ok(Content::Excluded(ReviewExclusionReason::NonRegularFile));
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(winapi::um::winbase::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_link(&metadata) {
        return Ok(Content::Excluded(ReviewExclusionReason::NonRegularFile));
    }
    ensure!(
        opened_path_matches(&file, &path)?,
        "review_file_identity_changed"
    );
    if metadata.len() > MAX_REVIEW_FILE_BYTES as u64 {
        return Ok(Content::Excluded(ReviewExclusionReason::FileTooLarge));
    }
    let mut bytes = Vec::new();
    file.take((MAX_REVIEW_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_REVIEW_FILE_BYTES {
        return Ok(Content::Excluded(ReviewExclusionReason::FileTooLarge));
    }
    Ok(Content::Bytes(bytes))
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn opened_path_matches(file: &std::fs::File, expected: &Path) -> Result<bool> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use winapi::um::fileapi::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle().cast(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    ensure!(
        length > 0 && (length as usize) < buffer.len(),
        "review_file_identity_unavailable"
    );
    let actual = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]));
    Ok(actual
        .as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy().replace('/', "\\")))
}

#[cfg(unix)]
fn opened_path_matches(file: &std::fs::File, expected: &Path) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let canonical = expected.canonicalize()?;
    let path_metadata = std::fs::metadata(&canonical)?;
    let opened = file.metadata()?;
    Ok(canonical == expected
        && opened.dev() == path_metadata.dev()
        && opened.ino() == path_metadata.ino())
}

fn parse_entries(bytes: &[u8]) -> Result<Vec<Entry>> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut entries = Vec::new();
    while let Some(header) = records.next() {
        let header = std::str::from_utf8(header)?;
        let parts = header
            .strip_prefix(':')
            .ok_or_else(|| anyhow::anyhow!("invalid_review_diff"))?
            .split_whitespace()
            .collect::<Vec<_>>();
        ensure!(
            parts.len() == 5 && parts[4] != "U",
            "review_unmerged_or_invalid_diff"
        );
        let first = std::str::from_utf8(
            records
                .next()
                .ok_or_else(|| anyhow::anyhow!("review_path_missing"))?,
        )?
        .to_owned();
        let (path, original_path) = if parts[4].starts_with(['R', 'C']) {
            let second = std::str::from_utf8(
                records
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("review_rename_path_missing"))?,
            )?;
            (second.to_owned(), Some(first))
        } else {
            (first, None)
        };
        entries.push(Entry {
            path,
            original_path,
            status: parts[4].into(),
            old_mode: parts[0].into(),
            new_mode: parts[1].into(),
            old_oid: parts[2].into(),
            new_oid: parts[3].into(),
        });
    }
    Ok(entries)
}

fn validate_path(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty()
            && path.len() <= 4096
            && !path.contains(['\0', '\\', ':'])
            && Path::new(path)
                .components()
                .all(|component| matches!(component, Component::Normal(_))),
        "invalid_review_path"
    );
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
