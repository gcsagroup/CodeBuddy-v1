use std::{env, process::Command};

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8(output.stdout).ok()?;
    Some(value.trim().to_owned())
}

fn emit_rerun_if_changed(path: Option<String>) {
    if let Some(path) = path {
        println!("cargo:rerun-if-changed={path}");
    }
}

fn source_dirty(status: Option<String>) -> &'static str {
    match status {
        Some(status) if status.is_empty() => "false",
        Some(_) => "true",
        None => "unknown",
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=GOOSE_BUILD_REVISION");
    println!("cargo:rerun-if-env-changed=GOOSE_BUILD_DIRTY");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    emit_rerun_if_changed(git_output(&["rev-parse", "--git-path", "HEAD"]));
    emit_rerun_if_changed(git_output(&["rev-parse", "--git-path", "index"]));

    let revision = env::var("GOOSE_BUILD_REVISION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            git_output(&["rev-parse", "--verify", "HEAD"]).filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_owned());
    let dirty = env::var("GOOSE_BUILD_DIRTY")
        .ok()
        .filter(|value| matches!(value.as_str(), "true" | "false" | "unknown"))
        .unwrap_or_else(|| source_dirty(git_output(&["status", "--porcelain"])).to_owned());

    println!("cargo:rustc-env=GOOSE_BUILD_REVISION={revision}");
    println!("cargo:rustc-env=GOOSE_BUILD_DIRTY={dirty}");
}

#[cfg(test)]
mod tests {
    use super::source_dirty;

    #[test]
    fn build_metadata_marks_empty_git_status_as_clean() {
        assert_eq!(source_dirty(Some(String::new())), "false");
    }

    #[test]
    fn build_metadata_marks_nonempty_git_status_as_dirty() {
        assert_eq!(source_dirty(Some(" M app.rs".to_owned())), "true");
    }

    #[test]
    fn build_metadata_marks_missing_git_status_as_unknown() {
        assert_eq!(source_dirty(None), "unknown");
    }
}
