use anyhow::{bail, ensure, Result};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const MAX_GIT_OUTPUT: usize = 4 * 1024 * 1024;

pub(super) struct ReadonlyGit {
    pub root: PathBuf,
    settings: Vec<String>,
    cancel: CancellationToken,
}

impl ReadonlyGit {
    pub async fn open(directory: &Path, cancel: CancellationToken) -> Result<Self> {
        let mut git = Self {
            root: directory.to_path_buf(),
            settings: Vec::new(),
            cancel,
        };
        let root = git.required(&["rev-parse", "--show-toplevel"]).await?;
        git.root = PathBuf::from(std::str::from_utf8(&root)?.trim_end_matches(['\r', '\n']))
            .canonicalize()?;
        let (status, keys) = git
            .run(&[
                "config",
                "--null",
                "--name-only",
                "--get-regexp",
                r"^filter\..*\.(clean|smudge|process|required)$",
            ])
            .await?;
        ensure!(
            status.success() || status.code() == Some(1),
            "review_git_config_failed"
        );
        for key in keys.split(|byte| *byte == 0).filter(|key| !key.is_empty()) {
            let key = std::str::from_utf8(key)?;
            let value = if key.ends_with(".required") {
                "false"
            } else {
                ""
            };
            git.settings.push(format!("{key}={value}"));
        }
        Ok(git)
    }

    pub async fn required(&self, args: &[&str]) -> Result<Vec<u8>> {
        let (status, bytes) = self.run(args).await?;
        ensure!(status.success(), "review_git_failed: {}", args[0]);
        Ok(bytes)
    }

    pub async fn optional_head(&self) -> Result<Option<String>> {
        let (status, bytes) = self
            .run(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
            .await?;
        if status.success() {
            return Ok(Some(std::str::from_utf8(&bytes)?.trim().to_owned()));
        }
        let branch = self.required(&["symbolic-ref", "--quiet", "HEAD"]).await?;
        let branch = std::str::from_utf8(&branch)?.trim();
        let (missing, _) = self
            .run(&["show-ref", "--verify", "--quiet", branch])
            .await?;
        ensure!(missing.code() == Some(1), "review_head_unavailable");
        Ok(None)
    }

    pub async fn run(&self, args: &[&str]) -> Result<(ExitStatus, Vec<u8>)> {
        ensure!(!self.cancel.is_cancelled(), "review_cancelled");
        let mut command = Command::new("git");
        // Inherited Git routing must not redirect a session to another checkout.
        for (name, _) in std::env::vars_os() {
            if name
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(name);
            }
        }
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .args([
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
            ])
            .args(["-c", "core.pager=cat", "-c", "core.quotePath=false"]);
        for setting in &self.settings {
            command.args(["-c", setting]);
        }
        command
            .args(args)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("review_git_stdout_missing"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("review_git_stderr_missing"))?;
        let work = async {
            let (status, stdout, _) =
                tokio::try_join!(child.wait(), read_bounded(stdout), read_bounded(stderr),)?;
            Ok((status, stdout))
        };
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => bail!("review_cancelled"),
            result = tokio::time::timeout(Duration::from_secs(30), work) => {
                result.map_err(|_| anyhow::anyhow!("review_git_timeout"))?
            }
        }
    }
}

async fn read_bounded(reader: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_GIT_OUTPUT + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > MAX_GIT_OUTPUT {
        return Err(std::io::Error::other("review_git_output_limit"));
    }
    Ok(bytes)
}
