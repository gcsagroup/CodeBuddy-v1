use ignore::WalkBuilder;
use quick_xml::events::Event;
use quick_xml::Reader;
use rmcp::model::{CallToolResult, Content, Meta};
use schemars::JsonSchema;
use serde::Deserialize;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

const MAX_DOCUMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_EXTRACTED_CHARS: usize = 120_000;
const MAX_PATH_CANDIDATES: usize = 5;

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DocumentReadParams {
    /// Path to a file inside the current workspace. Supports PDF, DOCX, XLSX,
    /// PPTX with format-aware extraction; all other files are read as UTF-8 text.
    pub path: String,
    /// Optional 1-based first line of extracted text (inclusive).
    pub start_line: Option<usize>,
    /// Optional 1-based last line of extracted text (inclusive).
    pub end_line: Option<usize>,
}

#[derive(Default)]
pub struct DocumentTool;

impl DocumentTool {
    pub fn new() -> Self {
        Self
    }

    pub fn document_read_with_cwd(
        &self,
        params: DocumentReadParams,
        working_dir: Option<&Path>,
    ) -> CallToolResult {
        self.document_read_with_cwd_authorized(params, working_dir, false)
    }

    pub fn document_read_with_cwd_authorized(
        &self,
        params: DocumentReadParams,
        working_dir: Option<&Path>,
        allow_outside_workspace: bool,
    ) -> CallToolResult {
        match extract_document(&params, working_dir, allow_outside_workspace) {
            Ok(text) => CallToolResult::success(vec![Content::text(text).with_priority(0.0)]),
            Err(error) => {
                let outside_workspace = matches!(error, DocumentReadError::OutsideWorkspace);
                let mut result =
                    CallToolResult::error(vec![
                        Content::text(format!("无法读取文档：{error}")).with_priority(0.0)
                    ]);
                if outside_workspace {
                    result.meta = Some(Meta(
                        serde_json::json!({ "codepro_failure": "outside_workspace" })
                            .as_object()
                            .expect("fixed failure metadata is an object")
                            .clone(),
                    ));
                }
                result
            }
        }
    }
}

#[derive(Debug)]
enum DocumentReadError {
    OutsideWorkspace,
    Other(String),
}

impl std::fmt::Display for DocumentReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OutsideWorkspace => formatter.write_str("拒绝读取当前工作区之外的文档"),
            Self::Other(message) => formatter.write_str(message),
        }
    }
}

fn extract_document(
    params: &DocumentReadParams,
    working_dir: Option<&Path>,
    allow_outside_workspace: bool,
) -> Result<String, DocumentReadError> {
    let start = params.start_line.unwrap_or(1);
    if start == 0 || params.end_line.is_some_and(|end| end < start) {
        return Err(DocumentReadError::Other(
            "行范围无效：start_line 从 1 开始，end_line 不得小于 start_line".into(),
        ));
    }
    let resolved = resolve_workspace_path(&params.path, working_dir, allow_outside_workspace)?;
    let metadata = std::fs::metadata(&resolved.actual)
        .map_err(|error| DocumentReadError::Other(error.to_string()))?;
    if !metadata.is_file() {
        return Err(DocumentReadError::Other("目标不是文件".to_string()));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(DocumentReadError::Other(format!(
            "文件超过 {} MB 限制",
            MAX_DOCUMENT_BYTES / 1024 / 1024
        )));
    }

    let extension = resolved
        .actual
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let text = match extension.as_str() {
        "pdf" => extract_pdf(&resolved.actual).map_err(DocumentReadError::Other)?,
        "docx" => extract_office_xml(&resolved.actual, OfficeKind::Word)
            .map_err(DocumentReadError::Other)?,
        "xlsx" => extract_office_xml(&resolved.actual, OfficeKind::Excel)
            .map_err(DocumentReadError::Other)?,
        "pptx" => extract_office_xml(&resolved.actual, OfficeKind::PowerPoint)
            .map_err(DocumentReadError::Other)?,
        _ => std::fs::read_to_string(&resolved.actual)
            .map_err(|error| DocumentReadError::Other(format!("无法读取 .{extension}：{error}")))?,
    };
    let text = if params.start_line.is_some() || params.end_line.is_some() {
        let total = text.lines().count();
        if start > total {
            return Err(DocumentReadError::Other(format!(
                "起始行 {start} 超出文档范围（共 {total} 行）"
            )));
        }
        let end = params.end_line.unwrap_or(total).min(total);
        let selected = text
            .lines()
            .skip(start - 1)
            .take(end - start + 1)
            .collect::<Vec<_>>()
            .join("\n");
        format!("[第 {start}–{end} 行，共 {total} 行]\n{selected}")
    } else {
        text
    };
    let output = if resolved.requested == resolved.actual {
        text
    } else {
        format!(
            "[已自动纠正文档路径]\n请求路径：{}\n实际路径：{}\n\n{text}",
            resolved.requested.display(),
            resolved.actual.display()
        )
    };
    Ok(bound_text(output))
}

struct ResolvedDocumentPath {
    requested: PathBuf,
    actual: PathBuf,
}

fn resolve_workspace_path(
    path: &str,
    working_dir: Option<&Path>,
    allow_outside_workspace: bool,
) -> Result<ResolvedDocumentPath, DocumentReadError> {
    let base = working_dir
        .ok_or_else(|| DocumentReadError::Other("当前会话没有工作目录".to_string()))?
        .canonicalize()
        .map_err(|error| DocumentReadError::Other(format!("无法解析工作目录：{error}")))?;
    let requested = PathBuf::from(path);
    let joined = if requested.is_absolute() {
        requested
    } else {
        base.join(requested)
    };
    match joined.canonicalize() {
        Ok(canonical) => {
            if !allow_outside_workspace && !canonical.starts_with(&base) {
                return Err(DocumentReadError::OutsideWorkspace);
            }
            Ok(ResolvedDocumentPath {
                requested: canonical.clone(),
                actual: canonical,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let candidates = find_filename_candidates(&base, &joined);
            if candidates.len() == 1 {
                return Ok(ResolvedDocumentPath {
                    requested: joined,
                    actual: candidates[0].clone(),
                });
            }
            Err(DocumentReadError::Other(render_path_not_found(
                &joined,
                &base,
                &candidates,
            )))
        }
        Err(error) => Err(DocumentReadError::Other(format!(
            "无法解析文件路径：{error}"
        ))),
    }
}

fn find_filename_candidates(base: &Path, requested: &Path) -> Vec<PathBuf> {
    let Some(requested_name) = requested.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    let mut builder = WalkBuilder::new(base);
    builder
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .ignore(true)
        .hidden(true);

    for entry in builder.build().flatten() {
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let Some(candidate_name) = entry.path().file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let matches = if cfg!(windows) {
            candidate_name.eq_ignore_ascii_case(requested_name)
        } else {
            candidate_name == requested_name
        };
        if !matches {
            continue;
        }
        let Ok(canonical) = entry.path().canonicalize() else {
            continue;
        };
        if canonical.starts_with(base) && !candidates.contains(&canonical) {
            candidates.push(canonical);
            if candidates.len() >= MAX_PATH_CANDIDATES {
                break;
            }
        }
    }
    candidates
}

fn render_path_not_found(requested: &Path, base: &Path, candidates: &[PathBuf]) -> String {
    let mut message = format!(
        "错误类型：path_not_found\n请求路径：{}\n停止猜测路径。",
        requested.display()
    );
    if candidates.is_empty() {
        message.push_str(&format!(
            "\n请先调用 tree 检查最近的已存在目录：path=\"{}\", depth=3，然后根据实际目录内容重试。",
            base.display()
        ));
    } else {
        message.push_str("\n发现多个同名候选，不能自动选择：");
        for candidate in candidates {
            message.push_str(&format!("\n- {}", candidate.display()));
        }
        message.push_str(&format!(
            "\n请先调用 tree 检查 path=\"{}\"，确认精确路径后再读取。",
            base.display()
        ));
    }
    message
}

fn bound_text(text: String) -> String {
    if text.chars().count() <= MAX_EXTRACTED_CHARS {
        return text;
    }
    let mut bounded = text.chars().take(MAX_EXTRACTED_CHARS).collect::<String>();
    bounded.push_str("\n\n[文档内容过长，已截断]");
    bounded
}

fn extract_pdf(path: &Path) -> Result<String, String> {
    let document = lopdf::Document::load(path).map_err(|error| error.to_string())?;
    let pages = document.get_pages().keys().copied().collect::<Vec<_>>();
    document
        .extract_text(&pages)
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy)]
enum OfficeKind {
    Word,
    Excel,
    PowerPoint,
}

fn extract_office_xml(path: &Path, kind: OfficeKind) -> Result<String, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut output = String::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().to_ascii_lowercase();
        if !office_entry_matches(&name, kind) {
            continue;
        }
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|error| error.to_string())?;
        append_xml_text(&xml, &mut output)?;
        output.push('\n');
        if output.chars().count() >= MAX_EXTRACTED_CHARS {
            break;
        }
    }
    if output.trim().is_empty() {
        return Err("文档中没有可提取的文字".to_string());
    }
    Ok(output)
}

fn office_entry_matches(name: &str, kind: OfficeKind) -> bool {
    match kind {
        OfficeKind::Word => name == "word/document.xml",
        OfficeKind::Excel => {
            name == "xl/sharedstrings.xml"
                || (name.starts_with("xl/worksheets/") && name.ends_with(".xml"))
        }
        OfficeKind::PowerPoint => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
    }
}

fn append_xml_text(xml: &str, output: &mut String) -> Result<(), String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(Event::Text(text)) => {
                let decoded = text.decode().map_err(|error| error.to_string())?;
                let unescaped =
                    quick_xml::escape::unescape(&decoded).map_err(|error| error.to_string())?;
                if !unescaped.trim().is_empty() {
                    if !output.is_empty() {
                        output.push(' ');
                    }
                    output.push_str(unescaped.trim());
                }
            }
            Ok(Event::CData(text)) => {
                let decoded = text.decode().map_err(|error| error.to_string())?;
                if !decoded.trim().is_empty() {
                    if !output.is_empty() {
                        output.push(' ');
                    }
                    output.push_str(decoded.trim());
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::RawContent;
    use std::io::Write;
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn first_text(result: &CallToolResult) -> &str {
        match &result.content[0].raw {
            RawContent::Text(text) => &text.text,
            _ => panic!("expected text content"),
        }
    }

    fn office_fixture(workspace: &Path, file_name: &str, entry: &str, xml: &str) -> PathBuf {
        let path = workspace.join(file_name);
        let file = File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(entry, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(xml.as_bytes()).unwrap();
        archive.finish().unwrap();
        path
    }

    #[test]
    fn reads_docx_text_inside_workspace() {
        let workspace = tempdir().unwrap();
        let path = workspace.path().join("需求.docx");
        let file = File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(
                r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:p><w:t>教务系统需求</w:t></w:p></w:document>"#
                    .as_bytes(),
            )
            .unwrap();
        archive.finish().unwrap();

        let result = DocumentTool::new().document_read_with_cwd(
            DocumentReadParams {
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            },
            Some(workspace.path()),
        );

        assert!(!result.is_error.unwrap_or(false));
        assert!(first_text(&result).contains("教务系统需求"));
    }

    #[test]
    fn rejects_documents_outside_workspace() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let path = outside.path().join("secret.txt");
        std::fs::write(&path, "secret").unwrap();

        let result = DocumentTool::new().document_read_with_cwd(
            DocumentReadParams {
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            },
            Some(workspace.path()),
        );

        assert!(result.is_error.unwrap_or(false));
        assert!(first_text(&result).contains("工作区之外"));
        assert_eq!(
            result
                .meta
                .as_ref()
                .and_then(|meta| meta.0.get("codepro_failure")),
            Some(&serde_json::json!("outside_workspace"))
        );
    }

    #[test]
    fn reads_exact_outside_document_after_explicit_confirmation() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let path = outside.path().join("approved.txt");
        std::fs::write(&path, "approved content").unwrap();

        let result = DocumentTool::new().document_read_with_cwd_authorized(
            DocumentReadParams {
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            },
            Some(workspace.path()),
            true,
        );

        assert!(!result.is_error.unwrap_or(false));
        assert_eq!(first_text(&result), "approved content");
    }

    #[test]
    fn reads_xlsx_shared_strings_inside_workspace() {
        let workspace = tempdir().unwrap();
        let path = office_fixture(
            workspace.path(),
            "测试.xlsx",
            "xl/sharedStrings.xml",
            r#"<?xml version="1.0"?><sst><si><t>学生名单</t></si></sst>"#,
        );

        let result = DocumentTool::new().document_read_with_cwd(
            DocumentReadParams {
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            },
            Some(workspace.path()),
        );

        assert!(!result.is_error.unwrap_or(false));
        assert!(first_text(&result).contains("学生名单"));
    }

    #[test]
    fn reads_pptx_slide_text_inside_workspace() {
        let workspace = tempdir().unwrap();
        let path = office_fixture(
            workspace.path(),
            "方案.pptx",
            "ppt/slides/slide1.xml",
            r#"<?xml version="1.0"?><p:sld xmlns:p="p"><a:t xmlns:a="a">项目方案</a:t></p:sld>"#,
        );

        let result = DocumentTool::new().document_read_with_cwd(
            DocumentReadParams {
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            },
            Some(workspace.path()),
        );

        assert!(!result.is_error.unwrap_or(false));
        assert!(first_text(&result).contains("项目方案"));
    }

    #[test]
    fn corrects_a_missing_path_to_one_unique_workspace_filename() {
        let workspace = tempdir().unwrap();
        let documentation = workspace.path().join("documentation/codebuddy");
        std::fs::create_dir_all(&documentation).unwrap();
        let actual = documentation.join("最新开发规划.md");
        std::fs::write(&actual, "当前规划内容").unwrap();

        let requested = workspace.path().join("codebuddy/最新开发规划.md");
        let result = DocumentTool::new().document_read_with_cwd(
            DocumentReadParams {
                path: requested.to_string_lossy().to_string(),
                ..Default::default()
            },
            Some(workspace.path()),
        );

        assert!(!result.is_error.unwrap_or(false));
        let text = first_text(&result);
        assert!(text.contains("当前规划内容"));
        assert!(text.contains("已自动纠正文档路径"));
        assert!(text.contains("documentation"));
        assert!(text.contains("最新开发规划.md"));
    }

    #[test]
    fn reports_candidates_instead_of_guessing_when_filename_is_ambiguous() {
        let workspace = tempdir().unwrap();
        let first = workspace.path().join("documentation/codebuddy");
        let second = workspace.path().join("archive");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("规划.md"), "current").unwrap();
        std::fs::write(second.join("规划.md"), "archive").unwrap();

        let result = DocumentTool::new().document_read_with_cwd(
            DocumentReadParams {
                path: "规划.md".to_string(),
                ..Default::default()
            },
            Some(workspace.path()),
        );

        assert!(result.is_error.unwrap_or(false));
        let text = first_text(&result);
        assert!(text.contains("path_not_found"));
        assert!(text.contains("tree"));
        assert!(text.contains("documentation"));
        assert!(text.contains("archive"));
    }

    #[test]
    fn tells_the_agent_to_discover_the_directory_when_no_candidate_exists() {
        let workspace = tempdir().unwrap();

        let result = DocumentTool::new().document_read_with_cwd(
            DocumentReadParams {
                path: "不存在的规划.md".to_string(),
                ..Default::default()
            },
            Some(workspace.path()),
        );

        assert!(result.is_error.unwrap_or(false));
        let text = first_text(&result);
        assert!(text.contains("path_not_found"));
        assert!(text.contains("停止猜测路径"));
        assert!(text.contains("tree"));
        assert!(text.contains(&workspace.path().display().to_string()));
    }
}
