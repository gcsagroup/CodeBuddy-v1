use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimpleChangeRequest {
    pub(crate) target: PathBuf,
}

pub(crate) fn validate_simple_change_target(
    working_dir: &Path,
    target: &Path,
) -> Result<PathBuf, String> {
    let root = working_dir
        .canonicalize()
        .map_err(|error| format!("无法规范化工作目录：{error}"))?;
    let unresolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let metadata = std::fs::symlink_metadata(&unresolved)
        .map_err(|error| format!("无法读取目标文件元数据：{error}"))?;
    if !metadata.is_file() || is_link_or_reparse_point(&metadata) {
        return Err("目标必须是普通文件且不能是链接或重解析点".to_string());
    }
    let target = unresolved
        .canonicalize()
        .map_err(|error| format!("无法规范化目标文件：{error}"))?;
    if !target.starts_with(&root) {
        return Err("目标文件不在当前工作区内".to_string());
    }
    if is_sensitive_target(&target) {
        return Err("目标文件属于敏感路径".to_string());
    }
    Ok(target)
}

fn is_sensitive_target(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    let name = name.to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || matches!(name.as_str(), "id_rsa" | "id_ed25519" | "credentials.json")
        || name.starts_with("secrets.")
}

fn is_link_or_reparse_point(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::validate_simple_change_target;
    use std::path::Path;

    fn create_file(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("test file should have a parent")).unwrap();
        std::fs::write(path, "value\n").unwrap();
    }

    #[test]
    fn validates_an_existing_regular_workspace_file() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("src/app.rs");
        create_file(&target);

        assert_eq!(
            validate_simple_change_target(project.path(), &target).unwrap(),
            target.canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_sensitive_missing_directory_and_outside_targets() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let target = project.join("src/app.rs");
        let sensitive = project.join(".env");
        let directory = project.join("src");
        let outside = root.path().join("outside.rs");
        create_file(&target);
        create_file(&sensitive);
        create_file(&outside);

        assert!(validate_simple_change_target(&project, &sensitive).is_err());
        assert!(validate_simple_change_target(&project, &directory).is_err());
        assert!(validate_simple_change_target(&project, &project.join("missing.rs")).is_err());
        assert!(validate_simple_change_target(&project, &outside).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let real = project.path().join("src/real.rs");
        let link = project.path().join("src/link.rs");
        create_file(&real);
        symlink(&real, &link).unwrap();

        assert!(validate_simple_change_target(project.path(), &link).is_err());
    }
}
