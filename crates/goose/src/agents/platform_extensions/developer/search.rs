use ignore::WalkBuilder;
use rmcp::model::{CallToolResult, Content, Meta};
use schemars::JsonSchema;
use serde::Deserialize;
use std::path::{Path, PathBuf};

const DEFAULT_MAX_RESULTS: usize = 20;
const MAX_RESULTS: usize = 100;
const MAX_QUERY_BYTES: usize = 512;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 500;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SearchParams {
    /// Literal text to find. This is not a regular expression.
    pub query: String,
    /// File or directory inside the current workspace. Defaults to the workspace root.
    #[serde(default = "default_path")]
    pub path: String,
    /// Maximum number of matching lines to return (1-100).
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

fn default_path() -> String {
    ".".to_string()
}

fn default_max_results() -> usize {
    DEFAULT_MAX_RESULTS
}

#[derive(Default)]
pub struct SearchTool;

impl SearchTool {
    pub fn new() -> Self {
        Self
    }

    pub fn search_with_cwd(
        &self,
        params: SearchParams,
        working_dir: Option<&Path>,
    ) -> CallToolResult {
        match search_workspace(params, working_dir) {
            Ok(output) => CallToolResult::success(vec![Content::text(output).with_priority(0.0)]),
            Err(SearchError::OutsideWorkspace) => {
                let mut result =
                    CallToolResult::error(vec![
                        Content::text("拒绝搜索当前工作区之外的路径").with_priority(0.0)
                    ]);
                result.meta = Some(Meta(
                    serde_json::json!({ "codepro_failure": "outside_workspace" })
                        .as_object()
                        .expect("fixed failure metadata is an object")
                        .clone(),
                ));
                result
            }
            Err(SearchError::Other(error)) => {
                CallToolResult::error(vec![Content::text(error).with_priority(0.0)])
            }
        }
    }
}

enum SearchError {
    OutsideWorkspace,
    Other(String),
}

fn search_workspace(
    params: SearchParams,
    working_dir: Option<&Path>,
) -> Result<String, SearchError> {
    if params.query.is_empty() || params.query.len() > MAX_QUERY_BYTES {
        return Err(SearchError::Other(
            "搜索文本必须为 1 到 512 个 UTF-8 字节".to_string(),
        ));
    }
    let base = working_dir
        .ok_or_else(|| SearchError::Other("当前会话没有工作目录".to_string()))?
        .canonicalize()
        .map_err(|error| SearchError::Other(format!("无法解析工作目录：{error}")))?;
    let requested = PathBuf::from(&params.path);
    let joined = if requested.is_absolute() {
        requested
    } else {
        base.join(requested)
    };
    let root = joined
        .canonicalize()
        .map_err(|error| SearchError::Other(format!("无法解析搜索路径：{error}")))?;
    if !root.starts_with(&base) {
        return Err(SearchError::OutsideWorkspace);
    }

    let limit = params.max_results.clamp(1, MAX_RESULTS);
    let mut matches = Vec::new();
    let mut builder = WalkBuilder::new(&root);
    builder
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .ignore(true)
        .hidden(true)
        .follow_links(false);
    for entry in builder.build().flatten() {
        if matches.len() >= limit {
            break;
        }
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(&base) {
            continue;
        }
        let Ok(metadata) = canonical.metadata() else {
            continue;
        };
        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&canonical) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            if !line.contains(&params.query) {
                continue;
            }
            let relative = canonical.strip_prefix(&base).unwrap_or(&canonical);
            let bounded = if line.chars().count() > MAX_LINE_CHARS {
                format!("{}…", line.chars().take(MAX_LINE_CHARS).collect::<String>())
            } else {
                line.to_string()
            };
            matches.push(format!("{}:{}:{}", relative.display(), index + 1, bounded));
            if matches.len() >= limit {
                break;
            }
        }
    }

    if matches.is_empty() {
        Ok(format!(
            "未找到字面文本 {:?}（范围：{}）",
            params.query,
            root.display()
        ))
    } else {
        Ok(matches.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn text(result: &CallToolResult) -> String {
        result
            .content
            .iter()
            .filter_map(|content| content.as_text())
            .map(|content| content.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn search_finds_literal_lines_inside_workspace() {
        let workspace = TempDir::new().unwrap();
        fs::create_dir_all(workspace.path().join("src")).unwrap();
        fs::write(
            workspace.path().join("src/app.py"),
            "before\ndef _safe_target():\n    pass\n",
        )
        .unwrap();

        let result = SearchTool::new().search_with_cwd(
            SearchParams {
                query: "_safe_target".to_string(),
                path: "src".to_string(),
                max_results: 20,
            },
            Some(workspace.path()),
        );

        assert_ne!(result.is_error, Some(true));
        assert!(
            text(&result).contains("src\\app.py:2:def _safe_target()")
                || text(&result).contains("src/app.py:2:def _safe_target()")
        );
    }

    #[test]
    fn search_rejects_paths_outside_workspace() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "needle").unwrap();

        let result = SearchTool::new().search_with_cwd(
            SearchParams {
                query: "needle".to_string(),
                path: outside.path().to_string_lossy().into_owned(),
                max_results: 20,
            },
            Some(workspace.path()),
        );

        assert_eq!(result.is_error, Some(true));
        assert!(text(&result).contains("工作区之外"));
    }
}
