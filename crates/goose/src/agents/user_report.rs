#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct UserAgentResultV1 {
    pub(crate) agent: String,
    pub(crate) work: String,
    pub(crate) result: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UserReportV1 {
    pub(crate) schema_version: u8,
    pub(crate) result: String,
    pub(crate) agent_results: Vec<UserAgentResultV1>,
    pub(crate) changes: Vec<String>,
    pub(crate) verification: Vec<String>,
    pub(crate) user_actions: Vec<String>,
    pub(crate) technical_details: Vec<String>,
}

pub(crate) fn render_user_report_v1(report: &UserReportV1) -> String {
    assert_eq!(report.schema_version, 1, "UserReportV1 schema version");
    let mut output = String::from("# 任务报告\n");
    if report.agent_results.is_empty() {
        output.push_str("\n## 执行 Agent\n\n");
        output.push_str("做了什么：");
        output.push_str(&natural_sentence(&report.changes, "处理了你的需求。"));
        output.push_str("\n\n结果：");
        output.push_str(&natural_sentence(
            &report.verification,
            report.result.trim(),
        ));
        output.push('\n');
    } else {
        for agent_result in &report.agent_results {
            output.push_str("\n## ");
            output.push_str(agent_result.agent.trim());
            output.push_str("\n\n做了什么：");
            output.push_str(agent_result.work.trim());
            output.push_str("\n\n结果：");
            output.push_str(agent_result.result.trim());
            output.push('\n');
        }
        render_items(&mut output, "实际改动", &report.changes);
        render_items(&mut output, "验证记录", &report.verification);
    }

    output.push_str("\n## 总结\n\n");
    output.push_str(report.result.trim());
    output.push('\n');
    render_items(&mut output, "接下来需要你做什么", &report.user_actions);
    if !report.technical_details.is_empty() {
        output.push_str("\n<details>\n<summary>技术详情</summary>\n\n");
        for item in &report.technical_details {
            let item = item.trim();
            if !item.contains('\n') {
                output.push_str("- ");
            }
            output.push_str(item);
            output.push('\n');
        }
        output.push_str("\n</details>");
    }
    output
}

fn natural_sentence(items: &[String], fallback: &str) -> String {
    if items.is_empty() {
        return fallback.to_string();
    }
    items
        .iter()
        .map(|item| item.trim().trim_start_matches("- "))
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("；")
}

fn render_items(output: &mut String, heading: &str, items: &[String]) {
    if items.is_empty() {
        return;
    }
    output.push_str(&format!("\n### {heading}\n\n"));
    for item in items {
        output.push_str("- ");
        output.push_str(item.trim());
        output.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_report_v1_has_one_visible_contract_and_hides_empty_user_action() {
        let rendered = render_user_report_v1(&UserReportV1 {
            schema_version: 1,
            result: "已完成。".to_string(),
            agent_results: vec![UserAgentResultV1 {
                agent: "编码 Agent".to_string(),
                work: "完成了代码修改。".to_string(),
                result: "改动已保存。".to_string(),
            }],
            changes: vec!["更新了实现。".to_string()],
            verification: vec!["聚焦测试通过。".to_string()],
            user_actions: Vec::new(),
            technical_details: vec!["命令：`cargo test`".to_string()],
        });

        assert!(rendered.starts_with("# 任务报告"));
        assert!(rendered.contains("## 编码 Agent"));
        assert!(rendered.contains("做了什么：完成了代码修改。"));
        assert!(rendered.contains("结果：改动已保存。"));
        assert!(rendered.contains("## 总结\n\n已完成。"));
        assert!(!rendered.contains("### 做了什么"));
        assert!(!rendered.contains("NOT_RUN"));
        assert!(rendered.contains("<summary>技术详情</summary>"));
        assert!(!rendered.contains("限制"));
    }

    #[test]
    fn user_report_v1_omits_empty_technical_details_instead_of_showing_none() {
        let rendered = render_user_report_v1(&UserReportV1 {
            schema_version: 1,
            result: "已完成。".to_string(),
            agent_results: vec![UserAgentResultV1 {
                agent: "测试 Agent".to_string(),
                work: "检查了交付结果。".to_string(),
                result: "检查通过。".to_string(),
            }],
            changes: Vec::new(),
            verification: Vec::new(),
            user_actions: Vec::new(),
            technical_details: Vec::new(),
        });

        assert!(!rendered.contains("<details>"), "{rendered}");
        assert!(!rendered.contains("- 无。"), "{rendered}");
    }
}
