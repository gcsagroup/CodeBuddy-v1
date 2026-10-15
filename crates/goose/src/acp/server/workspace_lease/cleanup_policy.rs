// Shared cleanup policy and response summary; native object operations stay platform-specific.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootCleanupTargetSummary {
    pub relative_path: String,
    pub target_type: &'static str,
    pub bytes: u64,
    pub modified_millis: u128,
    pub hash: Option<String>,
}

#[cfg(windows)]
fn reject_project_tree_cleanup(root: &Path, target: &Path) -> Result<()> {
    reject_cleanup_project_overlap(root, target, &registered_project_identities_for_cleanup()?)
}

fn reject_cleanup_project_overlap(root: &Path, target: &Path, projects: &[String]) -> Result<()> {
    let target_identity = normalize_identity(target)?;
    for project_identity in projects {
        if normalized_path_contains(&target_identity, project_identity)
            || normalized_path_contains(project_identity, &target_identity)
        {
            bail!("cleanup target overlaps a registered user project");
        }
    }

    let mut current = if target.is_dir() {
        target.to_path_buf()
    } else {
        target
            .parent()
            .ok_or_else(|| anyhow!("cleanup target has no parent"))?
            .to_path_buf()
    };
    loop {
        if directory_has_project_marker(&current)? {
            bail!("cleanup target is inside a user project or application data tree");
        }
        if current == root {
            break;
        }
        current = current
            .parent()
            .ok_or_else(|| anyhow!("cleanup target escaped its confirmed root"))?
            .to_path_buf();
    }
    Ok(())
}

fn registered_project_identities_for_cleanup() -> Result<Vec<String>> {
    #[cfg(test)]
    if let Some(identities) =
        TEST_REGISTERED_PROJECT_IDENTITIES.with(|value| value.borrow().clone())
    {
        return Ok(identities);
    }

    crate::sources::list_project_sources_strict_for_cleanup()
        .map_err(|error| anyhow!("failed to verify registered project boundaries: {error:?}"))?
        .into_iter()
        .try_fold(Vec::new(), |mut identities, project| {
            identities.extend(registered_project_identities(&project.properties)?);
            Ok(identities)
        })
}

fn directory_has_project_marker(directory: &Path) -> Result<bool> {
    for marker in [
        ".git",
        ".hg",
        ".svn",
        ".CodeBuddy",
        ".CodeAgentPro",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "package.json",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "Gemfile",
        "composer.json",
        "mix.exs",
        "CMakeLists.txt",
        ".idea",
        ".vscode",
    ] {
        match std::fs::symlink_metadata(directory.join(marker)) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("failed to inspect project marker"),
        }
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".sln") || name.ends_with(".csproj") || name.ends_with(".xcodeproj") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn registered_project_identities(
    properties: &HashMap<String, serde_json::Value>,
) -> Result<Vec<String>> {
    let working_dirs = properties
        .get("workingDirs")
        .ok_or_else(|| anyhow!("registered project is missing workingDirs"))
        .and_then(|value| {
            serde_json::from_value::<Vec<String>>(value.clone())
                .map_err(|_| anyhow!("registered project workingDirs are malformed"))
        })?;
    if working_dirs.is_empty() || working_dirs.iter().any(|path| path.trim().is_empty()) {
        bail!("registered project workingDirs are empty or malformed");
    }
    let claimed_identity = properties
        .get("codeproWorkspaceIdentity")
        .and_then(serde_json::Value::as_str)
        .filter(|identity| !identity.trim().is_empty())
        .ok_or_else(|| anyhow!("registered project is missing codeproWorkspaceIdentity"))?;
    let claimed_identity = normalize_registered_project_path(claimed_identity)?;
    let identities = working_dirs
        .iter()
        .map(|working_dir| normalize_registered_project_path(working_dir))
        .collect::<Result<Vec<_>>>()?;
    if !identities
        .iter()
        .any(|identity| identity == &claimed_identity)
    {
        bail!("registered project identity does not match its workingDirs");
    }
    Ok(identities)
}

fn normalized_path_contains(container: &str, candidate: &str) -> bool {
    Path::new(candidate).starts_with(Path::new(container))
}

fn ensure_cleanup_allowlisted(root: &Path, target: &Path) -> Result<()> {
    let relative = target.strip_prefix(root)?;
    let allowlisted = relative.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(
            name.as_str(),
            "tmp" | "temp" | "cache" | "caches" | "logs" | "target" | "build"
        ) || name.ends_with(".tmp")
            || name.ends_with(".cache")
            || name.ends_with(".log")
    });
    if !allowlisted {
        bail!("cleanup target is outside the conservative temp/cache/build allowlist");
    }
    Ok(())
}
