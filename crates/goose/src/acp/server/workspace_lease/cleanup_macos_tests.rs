use super::*;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    (temp, root)
}
fn audit(path: &Path) -> Result<Inspection> {
    inspect_with_projects(Path::new("/"), path, &[], || Ok(()))
}

#[test]
fn cleanup_readonly_unicode_summary_matches_bytes_and_empty_directory() {
    let (_temp, root) = fixture();
    let path = root.join("中文 空格.tmp");
    let bytes = "existing 中文🙂\n".as_bytes();
    fs::write(&path, bytes).unwrap();
    let before = fs::metadata(&path).unwrap();
    let inspection = audit(&path).unwrap();
    assert_eq!(inspection.summary.bytes, bytes.len() as u64);
    assert_eq!(
        inspection.summary.hash,
        Some(blake3::hash(bytes).to_hex().to_string())
    );
    assert_eq!(inspection.summary.target_type, "file");
    assert_eq!(
        inspection.summary.relative_path,
        path.strip_prefix("/").unwrap().to_str().unwrap()
    );
    inspection.revalidate_with_projects(&[]).unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        TargetVersion::from(&before),
        TargetVersion::from(&fs::metadata(&path).unwrap())
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    let empty = root.join("empty.tmp");
    fs::create_dir(&empty).unwrap();
    let inspection = audit(&empty).unwrap();
    assert_eq!(inspection.summary.target_type, "empty-directory");
    assert_eq!(inspection.summary.bytes, 0);
    assert!(inspection.summary.hash.is_none());
    fs::write(empty.join("keep"), "preserve").unwrap();
    assert!(inspection.revalidate_with_projects(&[]).is_err());
    assert!(audit(&empty).is_err());
    assert_eq!(fs::read_to_string(empty.join("keep")).unwrap(), "preserve");
}

#[test]
fn cleanup_readonly_rejects_links_special_files_and_missing_paths() {
    let (_temp, root) = fixture();
    let path = root.join("file.tmp");
    fs::write(&path, "keep").unwrap();
    let link = root.join("link.tmp");
    symlink(&path, &link).unwrap();
    assert!(audit(&link).is_err());
    let hard = root.join("hard.tmp");
    fs::hard_link(&path, &hard).unwrap();
    assert!(audit(&path).is_err());
    let fifo = root.join("fifo.tmp");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(audit(&fifo).is_err()); // O_NONBLOCK means an unopened FIFO must not hang.
    assert!(audit(&root.join("missing.tmp")).is_err());
    assert!(audit(Path::new("/")).is_err());
    assert!(audit(Path::new("relative.tmp")).is_err());
    assert!(audit(&root.join("../escape.tmp")).is_err());
    assert!(inspect_with_projects(&root, &path, &[], || Ok(())).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "keep");
}

#[test]
fn cleanup_readonly_rejects_project_overlap_and_markers() {
    let (_temp, root) = fixture();
    let path = root.join("file.tmp");
    fs::write(&path, "keep").unwrap();
    let identity = root.to_str().unwrap().to_owned();
    assert!(inspect_with_projects(Path::new("/"), &path, &[identity], || Ok(())).is_err());
    let inspection = audit(&path).unwrap();
    fs::write(root.join("Cargo.toml"), "project marker").unwrap();
    assert!(inspection.revalidate_with_projects(&[]).is_err());
    assert!(audit(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "keep");
    assert!(
        ensure_cleanup_allowlisted(Path::new("/"), Path::new("/Users/example/document.txt"))
            .is_err()
    );
    assert!(ensure_cleanup_allowlisted(
        Path::new("/"),
        Path::new("/Users/example/Library/Caches/entry")
    )
    .is_ok());
}

#[test]
fn cleanup_readonly_detects_source_substitution_during_inspection() {
    let (_temp, root) = fixture();
    let path = root.join("file.tmp");
    let original = root.join("original.tmp");
    fs::write(&path, "AUDITED").unwrap();
    let outcome = inspect_with_projects(Path::new("/"), &path, &[], || {
        fs::rename(&path, &original)?;
        fs::write(&path, "REPLACEMENT")?;
        Ok(())
    });
    assert!(outcome.is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "REPLACEMENT");
    assert_eq!(fs::read_to_string(&original).unwrap(), "AUDITED");
}

#[test]
fn cleanup_readonly_detects_parent_substitution_and_symlink_ancestry() {
    let (_temp, root) = fixture();
    let parent = root.join("cache");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("file.tmp");
    fs::write(&path, "AUDITED").unwrap();
    let moved = root.join("moved");
    let outcome = inspect_with_projects(Path::new("/"), &path, &[], || {
        fs::rename(&parent, &moved)?;
        fs::create_dir(&parent)?;
        fs::write(&path, "REPLACEMENT")?;
        Ok(())
    });
    assert!(outcome.is_err());
    assert_eq!(
        fs::read_to_string(moved.join("file.tmp")).unwrap(),
        "AUDITED"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "REPLACEMENT");
    let alias = root.join("alias");
    symlink(&moved, &alias).unwrap();
    assert!(audit(&alias.join("file.tmp")).is_err());
}

#[test]
fn cleanup_readonly_detects_content_and_link_changes_after_audit() {
    let (_temp, root) = fixture();
    let path = root.join("file.tmp");
    fs::write(&path, "BEFORE").unwrap();
    let inspection = audit(&path).unwrap();
    fs::write(&path, "AFTER!").unwrap();
    assert!(inspection.revalidate_with_projects(&[]).is_err());
    let inspection = audit(&path).unwrap();
    fs::hard_link(&path, root.join("additional.tmp")).unwrap();
    assert!(inspection.revalidate_with_projects(&[]).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "AFTER!");
}

#[test]
fn cleanup_readonly_rejects_unreadable_files_without_changing_permissions() {
    let (_temp, root) = fixture();
    let path = root.join("private.tmp");
    fs::write(&path, "preserve").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    let result = audit(&path);
    let mode = fs::metadata(&path).unwrap().mode() & 0o777;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    if unsafe { libc::geteuid() } != 0 {
        assert!(result.is_err());
    }
    assert_eq!(mode, 0);
    assert_eq!(fs::read_to_string(&path).unwrap(), "preserve");
}

#[test]
fn cleanup_registered_projects_preserve_posix_case_and_reject_malformed_facts() {
    let mut properties = HashMap::new();
    properties.insert(
        "workingDirs".into(),
        serde_json::json!(["/Users/Test/Project"]),
    );
    properties.insert(
        "codeproWorkspaceIdentity".into(),
        serde_json::json!("/Users/Test/Project"),
    );
    assert_eq!(
        registered_project_identities(&properties).unwrap(),
        vec!["/Users/Test/Project"]
    );
    properties.insert(
        "codeproWorkspaceIdentity".into(),
        serde_json::json!("/users/test/project"),
    );
    assert!(registered_project_identities(&properties).is_err());
    for invalid in ["/", "C:\\Project", "/Users/Test/../other"] {
        assert!(normalize_registered_project_path(invalid).is_err());
    }
    assert!(registered_project_identities(&HashMap::new()).is_err());
}
