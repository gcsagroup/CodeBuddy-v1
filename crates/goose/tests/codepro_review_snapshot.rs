use goose::agents::codepro_review::{
    capture_snapshot, validate_finding_location, Finding, ReviewCoverage, ReviewExclusionReason,
    ReviewModel, ReviewScope, ReviewSide, SnapshotRequest, MAX_REVIEW_CONTENT_BYTES,
    MAX_REVIEW_FILES,
};
use std::path::Path;
use std::process::Command;
use tempfile::{tempdir, TempDir};
use tokio_util::sync::CancellationToken;

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .args(["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false"])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn repository() -> TempDir {
    let root = tempdir().unwrap();
    git(root.path(), &["init", "--initial-branch=main"]);
    git(root.path(), &["config", "user.name", "Review Test"]);
    git(
        root.path(),
        &["config", "user.email", "review@example.invalid"],
    );
    git(root.path(), &["config", "core.autocrlf", "false"]);
    std::fs::write(root.path().join("tracked.txt"), "base\n").unwrap();
    git(root.path(), &["add", "tracked.txt"]);
    git(root.path(), &["commit", "-m", "base"]);
    root
}

fn request(root: &Path, scope: ReviewScope) -> SnapshotRequest {
    SnapshotRequest {
        session_id: "review-test".into(),
        working_dir: root.to_path_buf(),
        scope,
        base_ref: None,
        model: ReviewModel {
            provider: "test".into(),
            model: "test-model".into(),
        },
    }
}

#[tokio::test]
async fn scopes_include_untracked_content_without_changing_the_index() {
    let root = repository();
    let path = root.path();
    std::fs::write(path.join("tracked.txt"), "staged\n").unwrap();
    git(path, &["add", "tracked.txt"]);
    std::fs::write(path.join("tracked.txt"), "unstaged\n").unwrap();
    std::fs::write(path.join("new.txt"), "new content\n").unwrap();
    let index = std::fs::read(path.join(".git/index")).unwrap();
    let head = git(path, &["rev-parse", "HEAD"]);
    let status = git(path, &["status", "--porcelain=v1", "-z"]);
    let unstaged = capture_snapshot(
        &request(path, ReviewScope::WorkingTree),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let tracked = unstaged
        .files
        .iter()
        .find(|f| f.path == "tracked.txt")
        .unwrap();
    assert_eq!(tracked.old_text, "staged\n");
    assert_eq!(tracked.new_text, "unstaged\n");
    assert!(unstaged
        .files
        .iter()
        .any(|f| f.path == "new.txt" && f.new_text == "new content\n"));
    let staged = capture_snapshot(
        &request(path, ReviewScope::Staged),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(staged.files.len(), 1);
    assert_eq!(staged.files[0].old_text, "base\n");
    assert_eq!(staged.files[0].new_text, "staged\n");
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
    assert_eq!(git(path, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(path, &["status", "--porcelain=v1", "-z"]), status);
    assert_eq!(
        std::fs::read_to_string(path.join("tracked.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("new.txt")).unwrap(),
        "new content\n"
    );
}

#[tokio::test]
async fn branch_review_uses_merge_base_and_ignores_uncommitted_edits() {
    let root = repository();
    let path = root.path();
    git(path, &["switch", "-c", "comparison"]);
    std::fs::write(path.join("base-only.txt"), "comparison only\n").unwrap();
    git(path, &["add", "base-only.txt"]);
    git(path, &["commit", "-m", "comparison"]);
    git(path, &["switch", "main"]);
    std::fs::write(path.join("tracked.txt"), "committed\n").unwrap();
    git(path, &["add", "tracked.txt"]);
    git(path, &["commit", "-m", "review target"]);
    std::fs::write(path.join("tracked.txt"), "uncommitted\n").unwrap();
    let mut input = request(path, ReviewScope::Branch);
    input.base_ref = Some("comparison".into());
    let snapshot = capture_snapshot(&input, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].old_text, "base\n");
    assert_eq!(snapshot.files[0].new_text, "committed\n");
    git(path, &["switch", "--detach"]);
    assert!(capture_snapshot(&input, CancellationToken::new())
        .await
        .is_ok());
}

#[tokio::test]
async fn unborn_staged_review_and_session_subdirectory_work() {
    let root = tempdir().unwrap();
    git(root.path(), &["init", "--initial-branch=main"]);
    std::fs::create_dir(root.path().join("nested")).unwrap();
    std::fs::write(root.path().join("new.txt"), "first\n").unwrap();
    git(root.path(), &["add", "new.txt"]);
    let input = request(&root.path().join("nested"), ReviewScope::Staged);
    let snapshot = capture_snapshot(&input, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(snapshot.head_oid, None);
    assert_eq!(snapshot.files[0].old_text, "");
    assert_eq!(snapshot.files[0].new_text, "first\n");
    let mut branch = request(root.path(), ReviewScope::Branch);
    branch.base_ref = Some("main".into());
    assert!(capture_snapshot(&branch, CancellationToken::new())
        .await
        .is_err());
}

#[tokio::test]
async fn excluded_content_is_partial_and_fingerprints_track_content() {
    let root = repository();
    let path = root.path();
    std::fs::write(path.join(".env"), "SECRET=do-not-send\n").unwrap();
    std::fs::write(path.join("binary.bin"), [0, 1, 2]).unwrap();
    std::fs::write(path.join("large.txt"), vec![b'x'; 65 * 1024]).unwrap();
    std::fs::write(path.join("tracked.txt"), "one!\n").unwrap();
    let input = request(path, ReviewScope::WorkingTree);
    let first = capture_snapshot(&input, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(first.coverage, ReviewCoverage::Partial);
    assert_eq!(first.excluded_files.len(), 3);
    assert_eq!(first.files.len(), 1);
    assert!(!serde_json::to_string(&first)
        .unwrap()
        .contains("do-not-send"));
    let modified = std::fs::metadata(path.join("tracked.txt"))
        .unwrap()
        .modified()
        .unwrap();
    std::fs::write(path.join("tracked.txt"), "two!\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(path.join("tracked.txt"))
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let second = capture_snapshot(&input, CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(first.fingerprint, second.fingerprint);
}

#[tokio::test]
async fn deleted_lines_are_valid_only_on_the_old_side() {
    let root = repository();
    std::fs::remove_file(root.path().join("tracked.txt")).unwrap();
    let snapshot = capture_snapshot(
        &request(root.path(), ReviewScope::WorkingTree),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let mut finding = Finding {
        id: "finding-1".into(),
        priority: 1,
        title: "Deleted entry".into(),
        body: "This deletion changes the entry point.".into(),
        path: "tracked.txt".into(),
        side: ReviewSide::Old,
        start_line: 1,
        end_line: 1,
    };
    assert!(validate_finding_location(&finding, &snapshot).is_ok());
    finding.side = ReviewSide::New;
    assert!(validate_finding_location(&finding, &snapshot).is_err());
    finding.side = ReviewSide::Old;
    finding.start_line = 0;
    assert!(validate_finding_location(&finding, &snapshot).is_err());
    finding.start_line = 1;
    finding.path = "../tracked.txt".into();
    assert!(validate_finding_location(&finding, &snapshot).is_err());
}

#[tokio::test]
async fn cancellation_and_invalid_ref_are_explicit_errors() {
    let root = repository();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(
        capture_snapshot(&request(root.path(), ReviewScope::WorkingTree), cancel)
            .await
            .is_err()
    );
    let mut input = request(root.path(), ReviewScope::Branch);
    input.base_ref = Some("--help".into());
    assert!(capture_snapshot(&input, CancellationToken::new())
        .await
        .is_err());
    input.scope = ReviewScope::Staged;
    input.base_ref = Some("main".into());
    assert!(capture_snapshot(&input, CancellationToken::new())
        .await
        .is_err());
}

#[tokio::test]
async fn renamed_sensitive_content_and_git_filters_are_not_exposed() {
    let root = repository();
    let path = root.path();
    std::fs::write(path.join(".env"), "PRIVATE_REVIEW_SENTINEL\n").unwrap();
    std::fs::write(path.join(".gitattributes"), "tracked.txt filter=audit\n").unwrap();
    git(path, &["add", ".env", ".gitattributes"]);
    git(path, &["commit", "-m", "fixture metadata"]);
    git(path, &["mv", ".env", "public.txt"]);
    let staged = capture_snapshot(
        &request(path, ReviewScope::Staged),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(staged.coverage, ReviewCoverage::Partial);
    assert!(!serde_json::to_string(&staged)
        .unwrap()
        .contains("PRIVATE_REVIEW_SENTINEL"));
    git(
        path,
        &[
            "config",
            "filter.audit.clean",
            "echo invoked > filter-ran; cat",
        ],
    );
    std::fs::write(path.join("tracked.txt"), "changed\n").unwrap();
    capture_snapshot(
        &request(path, ReviewScope::WorkingTree),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!path.join("filter-ran").exists());
}

#[tokio::test]
async fn rename_preserves_old_location_and_rejects_invalid_priority() {
    let root = repository();
    git(root.path(), &["mv", "tracked.txt", "renamed.txt"]);
    std::fs::write(root.path().join("renamed.txt"), "base\nx\n").unwrap();
    git(root.path(), &["add", "renamed.txt"]);
    let snapshot = capture_snapshot(
        &request(root.path(), ReviewScope::Staged),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let file = snapshot
        .files
        .iter()
        .find(|f| f.path == "renamed.txt")
        .unwrap();
    assert_eq!(file.original_path.as_deref(), Some("tracked.txt"));
    let finding = Finding {
        id: "finding-1".into(),
        priority: 4,
        title: "Invalid".into(),
        body: "Invalid priority.".into(),
        path: "renamed.txt".into(),
        side: ReviewSide::New,
        start_line: 2,
        end_line: 2,
    };
    assert!(validate_finding_location(&finding, &snapshot).is_err());
}

#[tokio::test]
async fn nested_untracked_paths_and_ignored_files_are_handled() {
    let root = repository();
    std::fs::create_dir(root.path().join("nested")).unwrap();
    std::fs::write(root.path().join("nested/new.txt"), "nested content\n").unwrap();
    std::fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
    std::fs::write(root.path().join("ignored.txt"), "not reviewed\n").unwrap();
    let snapshot = capture_snapshot(
        &request(root.path(), ReviewScope::WorkingTree),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(snapshot
        .files
        .iter()
        .any(|file| file.path == "nested/new.txt" && file.new_text == "nested content\n"));
    assert!(!snapshot.files.iter().any(|file| file.path == "ignored.txt"));
}

#[tokio::test]
async fn file_and_content_limits_produce_explicit_partial_coverage() {
    let root = repository();
    for index in 0..=MAX_REVIEW_FILES {
        std::fs::write(root.path().join(format!("new-{index:03}.txt")), "new\n").unwrap();
    }
    let snapshot = capture_snapshot(
        &request(root.path(), ReviewScope::WorkingTree),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(snapshot.files.len(), MAX_REVIEW_FILES);
    assert_eq!(snapshot.coverage, ReviewCoverage::Partial);
    assert_eq!(snapshot.excluded_files.len(), 1);
    assert!(matches!(
        snapshot.excluded_files[0].reason,
        ReviewExclusionReason::FileLimit
    ));

    let large_root = repository();
    for index in 0..4 {
        std::fs::write(
            large_root.path().join(format!("large-{index}.txt")),
            "line\n".repeat(12_000),
        )
        .unwrap();
    }
    let large = capture_snapshot(
        &request(large_root.path(), ReviewScope::WorkingTree),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(large.coverage, ReviewCoverage::Partial);
    assert!(large
        .excluded_files
        .iter()
        .any(|file| matches!(file.reason, ReviewExclusionReason::ContentLimit)));
    assert!(
        large
            .files
            .iter()
            .map(|file| file.old_text.len() + file.new_text.len() + file.diff.len())
            .sum::<usize>()
            <= MAX_REVIEW_CONTENT_BYTES
    );
}

#[tokio::test]
async fn staged_symlinks_and_submodules_are_excluded_without_reading_targets() {
    let root = repository();
    let blob = git(root.path(), &["rev-parse", "HEAD:tracked.txt"]);
    let blob = std::str::from_utf8(&blob).unwrap().trim();
    let head = git(root.path(), &["rev-parse", "HEAD"]);
    let head = std::str::from_utf8(&head).unwrap().trim();
    git(
        root.path(),
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("120000,{blob},link"),
        ],
    );
    git(
        root.path(),
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{head},submodule"),
        ],
    );
    let snapshot = capture_snapshot(
        &request(root.path(), ReviewScope::Staged),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(snapshot.files.is_empty());
    assert_eq!(snapshot.coverage, ReviewCoverage::Partial);
    assert_eq!(snapshot.excluded_files.len(), 2);
    assert!(snapshot
        .excluded_files
        .iter()
        .all(|file| matches!(file.reason, ReviewExclusionReason::NonRegularFile)));
}

#[tokio::test]
async fn continuously_changing_repository_never_returns_a_stable_snapshot() {
    use std::io::{Seek, SeekFrom, Write};
    use std::sync::{Arc, Barrier};

    let root = repository();
    let path = root.path().join("tracked.txt");
    std::fs::write(&path, format!("{:016}\n", 0)).unwrap();
    let ready = Arc::new(Barrier::new(2));
    let writer_ready = ready.clone();
    let stop = CancellationToken::new();
    let writer_stop = stop.clone();
    let writer = std::thread::spawn(move || {
        let mut file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        writer_ready.wait();
        let mut version = 1u64;
        while !writer_stop.is_cancelled() {
            file.seek(SeekFrom::Start(0)).unwrap();
            writeln!(file, "{version:016}").unwrap();
            version += 1;
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    });
    ready.wait();
    let result = capture_snapshot(
        &request(root.path(), ReviewScope::WorkingTree),
        CancellationToken::new(),
    )
    .await;
    stop.cancel();
    writer.join().unwrap();
    assert_eq!(result.unwrap_err().to_string(), "repository_changed");
}
