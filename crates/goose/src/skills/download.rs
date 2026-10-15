use agent_client_protocol::Error;
use reqwest::{redirect::Policy, Client, StatusCode};
use serde::Deserialize;
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tokio::net::lookup_host;
use url::Url;
use uuid::Uuid;

const MAX_REDIRECTS: usize = 5;
const MAX_FILES: usize = 64;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const PROVENANCE_FILE: &str = ".codebuddy-source.json";

#[derive(Debug, Clone)]
pub(super) struct StagedDownload {
    pub path: PathBuf,
    pub files: Vec<String>,
    pub provenance: String,
}

#[derive(Debug, Deserialize)]
struct GitHubCommit {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GitHubEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    url: String,
    download_url: Option<String>,
}

pub(super) async fn stage_download(url: &str) -> Result<StagedDownload, Error> {
    let requested = parse_https_url(url)?;
    let root = std::env::temp_dir()
        .join("CodeBuddy")
        .join("skill-downloads");
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| download_error("download_stage_failed"))?;
    let stage = root.join(Uuid::new_v4().simple().to_string());
    tokio::fs::create_dir(&stage)
        .await
        .map_err(|_| download_error("download_stage_failed"))?;

    let result = if let Some(source) = parse_github_directory(&requested) {
        stage_github_directory(&source, &requested, &stage).await
    } else {
        stage_direct_document(&requested, &stage).await
    };
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&stage).await;
    }
    result
}

async fn stage_direct_document(url: &Url, stage: &Path) -> Result<StagedDownload, Error> {
    if url.path_segments().and_then(Iterator::last) != Some("SKILL.md") {
        return Err(download_error("unsupported_download_url"));
    }
    let (resolved, body) = fetch_bytes(url.clone(), MAX_FILE_BYTES).await?;
    validate_skill_document(&body)?;
    write_staged_file(stage, Path::new("SKILL.md"), &body).await?;
    let provenance = json!({
        "kind": "https_skill_md",
        "requestedUrl": url,
        "resolvedUrl": resolved,
        "singleFile": true,
    });
    write_provenance(stage, &provenance).await?;
    Ok(StagedDownload {
        path: stage.to_path_buf(),
        files: vec!["SKILL.md".into(), PROVENANCE_FILE.into()],
        provenance: resolved.to_string(),
    })
}

#[derive(Debug)]
struct GitHubDirectory {
    owner: String,
    repository: String,
    reference: String,
    directory: String,
}

fn parse_github_directory(url: &Url) -> Option<GitHubDirectory> {
    if url.host_str()? != "github.com" {
        return None;
    }
    let segments: Vec<_> = url
        .path_segments()?
        .filter(|part| !part.is_empty())
        .collect();
    if segments.len() < 5 || segments[2] != "tree" {
        return None;
    }
    Some(GitHubDirectory {
        owner: segments[0].to_string(),
        repository: segments[1].trim_end_matches(".git").to_string(),
        reference: segments[3].to_string(),
        directory: segments[4..].join("/"),
    })
}

async fn stage_github_directory(
    source: &GitHubDirectory,
    requested: &Url,
    stage: &Path,
) -> Result<StagedDownload, Error> {
    let commit_url = github_api_url(&format!(
        "repos/{}/{}/commits/{}",
        source.owner, source.repository, source.reference
    ))?;
    let commit: GitHubCommit = fetch_json(commit_url).await?;
    if commit.sha.len() != 40 || !commit.sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(download_error("invalid_github_commit"));
    }
    let contents_url = github_api_url(&format!(
        "repos/{}/{}/contents/{}?ref={}",
        source.owner, source.repository, source.directory, commit.sha
    ))?;
    let mut pending = vec![contents_url];
    let mut files = Vec::new();
    let mut total = 0usize;
    while let Some(directory_url) = pending.pop() {
        let entries: Vec<GitHubEntry> = fetch_json(directory_url).await?;
        for entry in entries {
            if files.len() + pending.len() >= MAX_FILES {
                return Err(download_error("download_file_limit"));
            }
            match entry.kind.as_str() {
                "dir" => pending.push(parse_github_api_entry_url(&entry.url)?),
                "file" => {
                    let relative = github_relative_path(&entry.path, &source.directory)?;
                    let download_url = entry
                        .download_url
                        .as_deref()
                        .ok_or_else(|| download_error("unsupported_github_entry"))?;
                    let (_, body) =
                        fetch_bytes(parse_https_url(download_url)?, MAX_FILE_BYTES).await?;
                    total = total
                        .checked_add(body.len())
                        .ok_or_else(|| download_error("download_size_limit"))?;
                    if total > MAX_TOTAL_BYTES {
                        return Err(download_error("download_size_limit"));
                    }
                    write_staged_file(stage, &relative, &body).await?;
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
                _ => return Err(download_error("linked_download_entry")),
            }
        }
    }
    if !files.iter().any(|path| path == "SKILL.md") {
        return Err(download_error("missing_skill_document"));
    }
    let raw = tokio::fs::read(stage.join("SKILL.md"))
        .await
        .map_err(|_| download_error("missing_skill_document"))?;
    validate_skill_document(&raw)?;
    let provenance = json!({
        "kind": "github_directory",
        "requestedUrl": requested,
        "commit": commit.sha,
        "directory": source.directory,
    });
    write_provenance(stage, &provenance).await?;
    files.push(PROVENANCE_FILE.into());
    files.sort();
    Ok(StagedDownload {
        path: stage.to_path_buf(),
        files,
        provenance: format!(
            "{}@{}",
            requested,
            provenance["commit"].as_str().unwrap_or_default()
        ),
    })
}

fn github_api_url(path: &str) -> Result<Url, Error> {
    parse_https_url(&format!("https://api.github.com/{path}"))
}

fn parse_github_api_entry_url(value: &str) -> Result<Url, Error> {
    let url = parse_https_url(value)?;
    if url.host_str() != Some("api.github.com") {
        return Err(download_error("unexpected_download_host"));
    }
    Ok(url)
}

fn github_relative_path(path: &str, root: &str) -> Result<PathBuf, Error> {
    let relative = path
        .strip_prefix(root)
        .and_then(|value| value.strip_prefix('/'))
        .ok_or_else(|| download_error("download_path_escape"))?;
    validate_relative_path(Path::new(relative))
}

async fn fetch_json<T: for<'de> Deserialize<'de>>(url: Url) -> Result<T, Error> {
    let (_, bytes) = fetch_bytes(url, MAX_TOTAL_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(|_| download_error("invalid_download_response"))
}

async fn fetch_bytes(mut url: Url, maximum: usize) -> Result<(Url, Vec<u8>), Error> {
    for _ in 0..=MAX_REDIRECTS {
        let address = resolve_public_address(&url).await?;
        let host = url
            .host_str()
            .ok_or_else(|| download_error("invalid_download_url"))?;
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .user_agent("CodeBuddy-Skill-Downloader/1")
            .resolve(host, address)
            .build()
            .map_err(|_| download_error("download_failed"))?;
        let mut response = client.get(url.clone()).send().await.map_err(|error| {
            if error.is_timeout() {
                download_error("download_timeout")
            } else {
                download_error("download_failed")
            }
        })?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| download_error("invalid_redirect"))?;
            url = parse_https_url(
                url.join(location)
                    .map_err(|_| download_error("invalid_redirect"))?
                    .as_str(),
            )?;
            continue;
        }
        if response.status() != StatusCode::OK {
            return Err(download_error("download_http_error"));
        }
        if response
            .content_length()
            .is_some_and(|size| size > maximum as u64)
        {
            return Err(download_error("download_size_limit"));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| download_error("download_failed"))?
        {
            if body.len() + chunk.len() > maximum {
                return Err(download_error("download_size_limit"));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok((url, body));
    }
    Err(download_error("redirect_limit"))
}

fn parse_https_url(value: &str) -> Result<Url, Error> {
    let url = Url::parse(value).map_err(|_| download_error("invalid_download_url"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err(download_error("unsafe_download_url"));
    }
    Ok(url)
}

async fn resolve_public_address(url: &Url) -> Result<SocketAddr, Error> {
    let host = url
        .host_str()
        .ok_or_else(|| download_error("invalid_download_url"))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses: Vec<_> = lookup_host((host, port))
        .await
        .map_err(|_| download_error("download_dns_failed"))?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(download_error("private_network_rejected"));
    }
    Ok(addresses[0])
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 240)
        }
        IpAddr::V6(ip) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local())
        }
    }
}

fn validate_relative_path(path: &Path) -> Result<PathBuf, Error> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(download_error("download_path_escape"));
    }
    Ok(path.to_path_buf())
}

async fn write_staged_file(stage: &Path, relative: &Path, bytes: &[u8]) -> Result<(), Error> {
    let relative = validate_relative_path(relative)?;
    let destination = stage.join(relative);
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| download_error("download_stage_failed"))?;
    }
    tokio::fs::write(destination, bytes)
        .await
        .map_err(|_| download_error("download_stage_failed"))
}

async fn write_provenance(stage: &Path, provenance: &serde_json::Value) -> Result<(), Error> {
    let bytes = serde_json::to_vec_pretty(provenance)
        .map_err(|_| download_error("download_stage_failed"))?;
    write_staged_file(stage, Path::new(PROVENANCE_FILE), &bytes).await
}

fn validate_skill_document(bytes: &[u8]) -> Result<(), Error> {
    let raw = std::str::from_utf8(bytes).map_err(|_| download_error("invalid_skill_document"))?;
    if super::parse_skill_content(raw, Path::new("download"), true).is_none() {
        return Err(download_error("invalid_skill_document"));
    }
    Ok(())
}

fn download_error(reason: &'static str) -> Error {
    Error::invalid_params().data(json!({ "reason": reason }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_https_credentials_and_local_addresses() {
        assert!(parse_https_url("http://example.com/SKILL.md").is_err());
        assert!(parse_https_url("https://user:secret@example.com/SKILL.md").is_err());
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("10.1.2.3".parse().unwrap()));
        assert!(!is_public_ip("::1".parse().unwrap()));
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn github_directory_is_bounded_and_relative() {
        let url =
            parse_https_url("https://github.com/openai/example/tree/main/skills/demo").unwrap();
        let source = parse_github_directory(&url).unwrap();
        assert_eq!(source.owner, "openai");
        assert_eq!(source.repository, "example");
        assert_eq!(source.reference, "main");
        assert_eq!(source.directory, "skills/demo");
        assert_eq!(
            github_relative_path("skills/demo/scripts/run.ps1", &source.directory).unwrap(),
            PathBuf::from("scripts/run.ps1")
        );
        assert!(github_relative_path("skills/other/SKILL.md", &source.directory).is_err());
        assert!(validate_relative_path(Path::new("../escape")).is_err());
    }

    #[test]
    fn downloaded_document_requires_valid_skill_frontmatter() {
        assert!(validate_skill_document(b"not frontmatter").is_err());
        assert!(
            validate_skill_document(b"---\nname: demo\ndescription: Demo\n---\nDo it.\n").is_ok()
        );
    }
}
