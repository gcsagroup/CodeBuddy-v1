//! Host observations for the configured local Git MCP. MCP text is never delivery proof.
use super::workers::SystemProcessGroupOwner;
use anyhow::{anyhow, Context, Result};
use rmcp::model::{CallToolResult, Content, JsonObject, Meta};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

const META: &str = "__goose_tool_update_meta";

pub(crate) fn mutates_repository(tool: &str) -> bool {
    matches!(
        tool,
        "git_add"
            | "git_commit"
            | "git_checkout"
            | "git_branch"
            | "git_pull"
            | "git_merge"
            | "git_fetch"
            | "git_push"
    )
}

/// Bind relative/default MCP paths to the same workspace the host audits. Mutable
/// server working-directory state must not redirect an omitted path to another repository.
pub(crate) fn bind_workspace_path(arguments: &mut Option<JsonObject>, root: &Path) {
    let args = arguments.get_or_insert_with(JsonObject::new);
    let path = args
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or(".");
    if !Path::new(path).is_absolute() {
        args.insert(
            "path".into(),
            serde_json::json!(root.join(path).to_string_lossy()),
        );
    }
}

/// Also used by the Node MCP transport: closing this runner closes the Windows job.
pub async fn run_supervised_cli(args: Vec<OsString>) -> Result<i32> {
    let owner = SystemProcessGroupOwner::new()?;
    let mut command = tokio::process::Command::new("git");
    command
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    owner.configure_command(&mut command);
    let mut child = command.spawn()?;
    owner.attach(&child)?;
    owner.resume(&child)?;
    let code = child.wait().await?.code().unwrap_or(1);
    owner.terminate_group()?;
    Ok(code)
}

async fn git(root: &Path, args: &[&str]) -> Result<String> {
    let owner = SystemProcessGroupOwner::new()?;
    let mut command = tokio::process::Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    owner.configure_command(&mut command);
    let child = command.spawn()?;
    owner.attach(&child)?;
    owner.resume(&child)?;
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output()).await;
    owner.terminate_group()?;
    let output = output.context("Git observation timed out")??;
    anyhow::ensure!(output.status.success(), "Git observation did not succeed");
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn snapshot(git_dir: &Path, common: &Path) -> Result<BTreeMap<String, String>> {
    fn visit(path: &Path, entries: &mut BTreeMap<String, String>) -> Result<()> {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            !metadata.file_type().is_symlink(),
            "Git state contains a symlink"
        );
        anyhow::ensure!(entries.len() < 4096, "Git state exceeds observation bound");
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                visit(&entry?.path(), entries)?;
            }
        } else if metadata.is_file() {
            anyhow::ensure!(
                metadata.len() <= 32 * 1024 * 1024,
                "Git state file exceeds observation bound"
            );
            let hash = blake3::hash(&std::fs::read(path)?);
            entries.insert(
                path.canonicalize()?.to_string_lossy().into_owned(),
                format!("blake3:{hash}"),
            );
        }
        Ok(())
    }
    let mut entries = BTreeMap::new();
    for path in [
        git_dir.join("HEAD"),
        git_dir.join("index"),
        git_dir.join("MERGE_HEAD"),
        common.join("packed-refs"),
        common.join("refs/heads"),
    ] {
        visit(&path, &mut entries)?;
    }
    Ok(entries)
}

struct PushTarget {
    remote: String,
    reference: String,
    commit: String,
}

pub(crate) struct GitObservation {
    root: PathBuf,
    git_dir: PathBuf,
    common: PathBuf,
    before: BTreeMap<String, String>,
    push: Option<PushTarget>,
    merge: bool,
}

impl GitObservation {
    pub(crate) async fn prepare(
        tool: &str,
        args: Option<&JsonObject>,
        root: &Path,
    ) -> Result<Option<Self>> {
        if !mutates_repository(tool) {
            return Ok(None);
        }
        let args = args.ok_or_else(|| anyhow!("Git arguments missing"))?;
        // A changed server working directory is not inferred from conversation text.
        let supplied = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("Git evidence requires an explicit repository path"))?;
        let root = root.canonicalize()?;
        let target = root.join(supplied).canonicalize()?;
        anyhow::ensure!(
            target.starts_with(&root),
            "Git target is outside the task workspace"
        );
        let git_dir = PathBuf::from(git(&target, &["rev-parse", "--absolute-git-dir"]).await?)
            .canonicalize()?;
        let common = target
            .join(git(&target, &["rev-parse", "--git-common-dir"]).await?)
            .canonicalize()?;
        // Linked worktree metadata outside the workspace is not a workspace write receipt.
        anyhow::ensure!(
            git_dir.starts_with(&root) && common.starts_with(&root),
            "Git metadata is outside the task workspace"
        );
        let before = snapshot(&git_dir, &common)?;
        let mut observation = Self {
            root: target,
            git_dir,
            common,
            before,
            push: None,
            merge: tool == "git_merge" && args.get("abort").and_then(|v| v.as_bool()) != Some(true),
        };
        if tool == "git_push"
            && !["dryRun", "delete", "tags"]
                .iter()
                .any(|key| args.get(*key).and_then(|v| v.as_bool()) == Some(true))
        {
            let remote = args
                .get("remote")
                .and_then(|v| v.as_str())
                .unwrap_or("origin");
            anyhow::ensure!(!remote.starts_with('-'), "Invalid remote name");
            let urls = git(
                &observation.root,
                &["remote", "get-url", "--push", "--all", remote],
            )
            .await?;
            anyhow::ensure!(
                urls.lines().count() == 1,
                "Multiple push destinations require separate verification"
            );
            let branch = match args.get("branch").and_then(|v| v.as_str()) {
                Some(branch) => branch.to_owned(),
                None => git(&observation.root, &["symbolic-ref", "--short", "HEAD"]).await?,
            };
            anyhow::ensure!(
                !branch.starts_with('-') && !branch.contains(':'),
                "Explicit branch required for push verification"
            );
            let branch = branch.strip_prefix("refs/heads/").unwrap_or(&branch);
            let reference = format!("refs/heads/{branch}");
            git(&observation.root, &["check-ref-format", &reference]).await?;
            let commit = git(&observation.root, &["rev-parse", "--verify", &reference]).await?;
            observation.push = Some(PushTarget {
                remote: urls,
                reference,
                commit,
            });
        }
        Ok(Some(observation))
    }

    pub(crate) async fn finish(self, result: &mut CallToolResult) -> Result<()> {
        let after = snapshot(&self.git_dir, &self.common)?;
        let mut versions = BTreeMap::new();
        for (path, version) in &after {
            if self.before.get(path) != Some(version) {
                versions.insert(path.clone(), version.clone());
            }
        }
        for path in self.before.keys() {
            if !after.contains_key(path) {
                versions.insert(path.clone(), "deleted".into());
            }
        }
        if !versions.is_empty() {
            let trusted = result
                .meta
                .get_or_insert_with(|| Meta(Default::default()))
                .0
                .entry(META)
                .or_insert_with(|| serde_json::json!({}));
            trusted["workspaceDelta"] = serde_json::json!({"changedPaths":versions.keys().collect::<Vec<_>>(), "resourceVersions":versions});
        }
        // A terminal conflict is an observed domain failure, not an uncertain write.
        // The adapter flag alone is untrusted; the host must confirm Git's live index.
        if self.merge
            && result.is_error == Some(true)
            && result.structured_content.as_ref().is_some_and(|body| {
                body["codebuddyGitOutcome"]["kind"] == "merge_conflict"
                    && body["codebuddyGitOutcome"]["exitCode"] == 1
            })
            && self.git_dir.join("MERGE_HEAD").is_file()
            && !git(&self.root, &["ls-files", "--unmerged", "-z"])
                .await?
                .is_empty()
        {
            let trusted = result
                .meta
                .get_or_insert_with(|| Meta(Default::default()))
                .0
                .entry(META)
                .or_insert_with(|| serde_json::json!({}));
            trusted["gitKnownConflict"] = serde_json::json!(true);
        }
        if result.is_error != Some(true) {
            if let Some(push) = self.push {
                let output = git(
                    &self.root,
                    &["ls-remote", "--refs", "--", &push.remote, &push.reference],
                )
                .await?;
                let expected = format!("{}\t{}", push.commit, push.reference);
                anyhow::ensure!(
                    output == expected,
                    "Remote ref does not match the requested commit; push remains unverified"
                );
                let resource = format!(
                    "git-remote:{}:{}",
                    blake3::hash(push.remote.as_bytes()),
                    push.reference
                );
                let evidence = serde_json::json!({"resource":resource,"version":push.commit});
                let trusted = result
                    .meta
                    .get_or_insert_with(|| Meta(Default::default()))
                    .0
                    .entry(META)
                    .or_insert_with(|| serde_json::json!({}));
                trusted["gitExternalEffect"] = evidence.clone();
                result.content.push(Content::text(format!("Host verified remote branch (use this external_effect resource/version for completion): {evidence}")));
            }
        }
        Ok(())
    }
}

pub(crate) fn known_conflict(result: &CallToolResult) -> bool {
    result.is_error == Some(true)
        && result
            .meta
            .as_ref()
            .and_then(|meta| meta.0.get(META))
            .is_some_and(|trusted| trusted["gitKnownConflict"] == true)
}

pub(crate) fn external_effect(result: &CallToolResult) -> Option<(String, String)> {
    if result.is_error == Some(true) {
        return None;
    }
    let evidence = result
        .meta
        .as_ref()?
        .0
        .get(META)?
        .get("gitExternalEffect")?;
    Some((
        evidence.get("resource")?.as_str()?.to_owned(),
        evidence.get("version")?.as_str()?.to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_git(root: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn git_mcp_default_paths_are_bound_to_the_audited_workspace() {
        let root = tempfile::tempdir().unwrap();
        for value in [
            None,
            Some(serde_json::json!({"path":"."}).as_object().unwrap().clone()),
            Some(
                serde_json::json!({"message":"commit"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        ] {
            let mut args = value;
            bind_workspace_path(&mut args, root.path());
            assert_eq!(
                PathBuf::from(args.unwrap()["path"].as_str().unwrap())
                    .canonicalize()
                    .unwrap(),
                root.path().canonicalize().unwrap()
            );
        }
        let mut args = Some(
            serde_json::json!({"path":root.path().join("subrepo")})
                .as_object()
                .unwrap()
                .clone(),
        );
        let before = args.clone();
        bind_workspace_path(&mut args, root.path());
        assert_eq!(args, before);
    }

    #[tokio::test]
    async fn git_mcp_conflict_requires_terminal_marker_and_real_unmerged_index() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fixture_git(root, &["init", "-b", "main"]);
        fixture_git(root, &["config", "user.name", "Acceptance"]);
        fixture_git(
            root,
            &["config", "user.email", "acceptance@example.invalid"],
        );
        fixture_git(root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("conflict.txt"), "base\n").unwrap();
        fixture_git(root, &["add", "."]);
        fixture_git(root, &["commit", "-m", "base"]);
        fixture_git(root, &["branch", "peer"]);
        std::fs::write(root.join("conflict.txt"), "main\n").unwrap();
        fixture_git(root, &["commit", "-am", "main"]);
        fixture_git(root, &["checkout", "peer"]);
        std::fs::write(root.join("conflict.txt"), "peer\n").unwrap();
        fixture_git(root, &["commit", "-am", "peer"]);
        fixture_git(root, &["checkout", "main"]);
        let args = serde_json::json!({"path":root,"branch":"peer"});
        let marker =
            serde_json::json!({"codebuddyGitOutcome":{"kind":"merge_conflict","exitCode":1}});
        let observation = GitObservation::prepare("git_merge", args.as_object(), root)
            .await
            .unwrap()
            .unwrap();
        let mut spoofed = CallToolResult::error(vec![]);
        spoofed.structured_content = Some(marker.clone());
        observation.finish(&mut spoofed).await.unwrap();
        assert!(
            !known_conflict(&spoofed),
            "an adapter claim without conflicts is not proof"
        );
        let observation = GitObservation::prepare("git_merge", args.as_object(), root)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            std::process::Command::new("git")
                .args(["merge", "peer"])
                .current_dir(root)
                .output()
                .unwrap()
                .status
                .code(),
            Some(1)
        );
        let mut conflict = CallToolResult::error(vec![]);
        conflict.structured_content = Some(marker);
        observation.finish(&mut conflict).await.unwrap();
        assert!(known_conflict(&conflict));
        assert_eq!(conflict.is_error, Some(true));
        let observation = GitObservation::prepare("git_merge", args.as_object(), root)
            .await
            .unwrap()
            .unwrap();
        let mut uncertain = CallToolResult::error(vec![]);
        observation.finish(&mut uncertain).await.unwrap();
        assert!(
            !known_conflict(&uncertain),
            "a timeout in an existing conflict is not a terminal merge result"
        );
    }

    #[tokio::test]
    async fn git_mcp_observation_requires_real_changes_and_remote_ref() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("工作 仓库");
        let remote = fixture.path().join("remote.git");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&remote).unwrap();
        fixture_git(&remote, &["init", "--bare"]);
        fixture_git(&root, &["init", "-b", "main"]);
        fixture_git(&root, &["config", "user.name", "Acceptance"]);
        fixture_git(
            &root,
            &["config", "user.email", "acceptance@example.invalid"],
        );
        fixture_git(&root, &["config", "commit.gpgsign", "false"]);
        fixture_git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let args =
            serde_json::json!({"path":root.to_str().unwrap(),"remote":"origin","branch":"main"});
        std::fs::write(root.join("中文.txt"), "both sides matter\n").unwrap();
        let observation = GitObservation::prepare("git_add", args.as_object(), &root)
            .await
            .unwrap()
            .unwrap();
        fixture_git(&root, &["add", "中文.txt"]);
        let mut result = CallToolResult::success(vec![]);
        observation.finish(&mut result).await.unwrap();
        assert!(
            result.meta.unwrap().0[META]["workspaceDelta"]["resourceVersions"]
                .as_object()
                .unwrap()
                .keys()
                .any(|path| path.ends_with("index"))
        );
        fixture_git(&root, &["commit", "-m", "fixture"]);
        let observation = GitObservation::prepare("git_push", args.as_object(), &root)
            .await
            .unwrap()
            .unwrap();
        let mut result = CallToolResult::success(vec![]);
        assert!(observation.finish(&mut result).await.is_err());
        assert!(
            external_effect(&result).is_none(),
            "MCP success without remote confirmation must not count"
        );
        let observation = GitObservation::prepare("git_push", args.as_object(), &root)
            .await
            .unwrap()
            .unwrap();
        fixture_git(&root, &["push", "origin", "main"]);
        observation.finish(&mut result).await.unwrap();
        assert!(external_effect(&result).is_some());
        let observation = GitObservation::prepare("git_push", args.as_object(), &root)
            .await
            .unwrap()
            .unwrap();
        let mut failed = CallToolResult::error(vec![]);
        observation.finish(&mut failed).await.unwrap();
        assert!(external_effect(&failed).is_none());
        let outside = serde_json::json!({"path":remote.to_str().unwrap()});
        assert!(
            GitObservation::prepare("git_add", outside.as_object(), &root)
                .await
                .is_err()
        );
    }
}
