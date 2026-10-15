use super::*;
use crate::session::{generate_diagnostics, DiagnosticsLevel};

impl GooseAcpAgent {
    pub(super) async fn on_get_diagnostics(
        &self,
        req: DiagnosticsGetRequest,
    ) -> Result<DiagnosticsGetResponse, agent_client_protocol::Error> {
        let level = match req.level {
            DiagnosticsReportLevel::Summary => DiagnosticsLevel::Summary,
            DiagnosticsReportLevel::Full => DiagnosticsLevel::Full,
        };
        let report = generate_diagnostics(&self.session_manager, &req.session_id, level)
            .await
            .internal_err()?;
        let mut report = serde_json::to_value(report).internal_err()?;
        if matches!(level, DiagnosticsLevel::Full) {
            let tool_audit = diagnostic_tool_audit_index(&report);
            if let Some(fields) = report.as_object_mut() {
                fields.insert(
                    "codepro".to_string(),
                    self.codepro_control
                        .diagnostics_for_session(&req.session_id)
                        .await,
                );
                fields.insert("toolAuditIndex".to_string(), tool_audit);
            }
        }

        Ok(DiagnosticsGetResponse { report })
    }
}

fn diagnostic_tool_audit_index(report: &serde_json::Value) -> serde_json::Value {
    fn visit(
        value: &serde_json::Value,
        seen: &mut std::collections::BTreeSet<String>,
        records: &mut Vec<serde_json::Value>,
    ) {
        match value {
            serde_json::Value::Object(fields) => {
                if let Some(audit) = fields
                    .get("toolAudit")
                    .and_then(serde_json::Value::as_object)
                {
                    let audit_id = audit
                        .get("auditId")
                        .or_else(|| audit.get("audit_id"))
                        .and_then(serde_json::Value::as_str);
                    if let Some(audit_id) = audit_id.filter(|id| seen.insert((*id).to_string())) {
                        let selected = [
                            "auditId",
                            "toolName",
                            "outcome",
                            "failureKind",
                            "startedAt",
                            "completedAt",
                            "durationMs",
                            "taskScoped",
                            "taskScopeDigest",
                        ]
                        .into_iter()
                        .filter_map(|key| {
                            audit
                                .get(key)
                                .cloned()
                                .map(|value| (key.to_string(), value))
                        })
                        .collect::<serde_json::Map<_, _>>();
                        let mut selected = selected;
                        selected.insert(
                            "auditId".to_string(),
                            serde_json::Value::String(audit_id.to_string()),
                        );
                        records.push(serde_json::Value::Object(selected));
                    }
                }
                for child in fields.values() {
                    visit(child, seen, records);
                }
            }
            serde_json::Value::Array(values) => {
                for child in values {
                    visit(child, seen, records);
                }
            }
            _ => {}
        }
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut records = Vec::new();
    visit(report, &mut seen, &mut records);
    serde_json::json!({
        "records": records,
        "redacted": true,
        "source": "session_tool_receipts",
    })
}
