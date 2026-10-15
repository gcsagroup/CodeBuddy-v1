use crate::agents::agent_role::CodeProTaskKind;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct AnalysisReportEvidence {
    pub(crate) kind: String,
    pub(crate) value: String,
    pub(crate) failed: bool,
}

impl AnalysisReportEvidence {
    pub(crate) fn new(kind: impl Into<String>, value: impl Into<String>, failed: bool) -> Self {
        Self {
            kind: kind.into(),
            value: value.into(),
            failed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodeProReportKind {
    Test,
    Fix,
    Analysis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum CodeProReportClassification {
    ConfirmedBug,
    TestFailure,
    EnvironmentProblem,
    CodeProIncomplete,
    Unverified,
}

impl CodeProReportClassification {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::ConfirmedBug => "确认 Bug",
            Self::TestFailure => "测试失败",
            Self::EnvironmentProblem => "环境问题",
            Self::CodeProIncomplete => "CodePro 未完成",
            Self::Unverified => "未验证",
        }
    }
}

impl CodeProReportKind {
    pub(crate) const fn from_task_kind(task_kind: CodeProTaskKind) -> Option<Self> {
        match task_kind {
            CodeProTaskKind::FocusedTest | CodeProTaskKind::ProjectTest => Some(Self::Test),
            CodeProTaskKind::SimpleChange
            | CodeProTaskKind::BugFix
            | CodeProTaskKind::ComplexChange => Some(Self::Fix),
            CodeProTaskKind::ReadOnly => Some(Self::Analysis),
            CodeProTaskKind::Conversation | CodeProTaskKind::ToolAction => None,
        }
    }
}

pub(crate) fn insert_section_note(report: &mut String, heading: &str, note: &str) -> bool {
    let marker = format!("\n## {heading}\n");
    let Some(section_start) = report.find(&marker).map(|index| index + marker.len()) else {
        return false;
    };
    let tail = report
        .get(section_start..)
        .expect("section start comes from a matched UTF-8 marker");
    let section_end = [tail.find("\n## "), tail.find("\n<details>")]
        .into_iter()
        .flatten()
        .min()
        .map_or(report.len(), |offset| section_start + offset);
    report.insert_str(section_end, &format!("\n{}\n", note.trim()));
    true
}

pub(crate) fn sanitize_report_block(value: &str) -> String {
    let mut sanitized = value.to_string();

    for tag in ["<details", "</details", "<summary", "</summary"] {
        while let Some(index) = sanitized.to_ascii_lowercase().find(tag) {
            sanitized.replace_range(index..index + 1, "&lt;");
        }
    }

    sanitized
        .split('\n')
        .map(escape_markdown_heading)
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn sanitize_report_inline(value: &str) -> String {
    sanitize_report_block(&value.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn escape_markdown_heading(line: &str) -> String {
    let trimmed = line.trim_start();
    let leading_bytes = line.len() - trimmed.len();
    let hash_count = trimmed.bytes().take_while(|byte| *byte == b'#').count();
    let is_heading = (1..=6).contains(&hash_count)
        && trimmed
            .get(hash_count..)
            .and_then(|rest| rest.chars().next())
            .is_none_or(char::is_whitespace);
    if !is_heading {
        return line.to_string();
    }

    let mut escaped = String::with_capacity(line.len() + 1);
    escaped.push_str(
        line.get(..leading_bytes)
            .expect("leading whitespace ends on a UTF-8 boundary"),
    );
    escaped.push('\\');
    escaped.push_str(
        line.get(leading_bytes..)
            .expect("trimmed text starts on a UTF-8 boundary"),
    );
    escaped
}

#[cfg(test)]
mod tests {
    use super::{insert_section_note, CodeProReportClassification, CodeProReportKind};
    use crate::agents::agent_role::CodeProTaskKind;

    #[test]
    fn report_classifications_use_the_planned_user_labels() {
        let classifications = [
            (CodeProReportClassification::ConfirmedBug, "确认 Bug"),
            (CodeProReportClassification::TestFailure, "测试失败"),
            (CodeProReportClassification::EnvironmentProblem, "环境问题"),
            (
                CodeProReportClassification::CodeProIncomplete,
                "CodePro 未完成",
            ),
            (CodeProReportClassification::Unverified, "未验证"),
        ];

        let labels = classifications
            .iter()
            .map(|(classification, expected)| {
                assert_eq!(classification.label(), *expected);
                classification.label()
            })
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(labels.len(), classifications.len());
    }

    #[test]
    fn host_task_kind_selects_the_report_family() {
        for kind in [CodeProTaskKind::FocusedTest, CodeProTaskKind::ProjectTest] {
            assert_eq!(
                CodeProReportKind::from_task_kind(kind),
                Some(CodeProReportKind::Test)
            );
        }
        for kind in [
            CodeProTaskKind::SimpleChange,
            CodeProTaskKind::BugFix,
            CodeProTaskKind::ComplexChange,
        ] {
            assert_eq!(
                CodeProReportKind::from_task_kind(kind),
                Some(CodeProReportKind::Fix)
            );
        }
        assert_eq!(
            CodeProReportKind::from_task_kind(CodeProTaskKind::ReadOnly),
            Some(CodeProReportKind::Analysis)
        );
        assert_eq!(
            CodeProReportKind::from_task_kind(CodeProTaskKind::Conversation),
            None
        );
    }

    #[test]
    fn note_is_inserted_only_inside_the_named_section() {
        let mut report = "# 报告\n\n## 结论\n\n原结论。\n\n## 用户下一步\n\n继续。\n\n<details>\n技术证据\n</details>\n".to_string();

        assert!(insert_section_note(&mut report, "结论", "补充结论。"));

        let conclusion = report.find("## 结论").unwrap();
        let next = report.find("## 用户下一步").unwrap();
        let note = report.find("补充结论。").unwrap();
        assert!(conclusion < note && note < next);
        assert_eq!(report.matches("## 结论").count(), 1);
    }

    #[test]
    fn missing_section_is_not_silently_appended() {
        let mut report = "# 报告\n\n<details>\n技术证据\n</details>\n".to_string();
        let original = report.clone();

        assert!(!insert_section_note(&mut report, "结论", "不应追加。"));
        assert_eq!(report, original);
    }
}
