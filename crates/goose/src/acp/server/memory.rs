use super::{GooseAcpAgent, ResultExt};
use crate::acp::custom_requests::{
    CodeProMemoryDeleteRequest, CodeProMemoryDeleteResponse, CodeProMemoryExportRequest,
    CodeProMemoryExportResponse, CodeProMemoryGetRequest, CodeProMemoryGetResponse,
    CodeProMemoryListRequest, CodeProMemoryListResponse, CodeProMemoryRecord,
    CodeProMemoryRecordResponse, CodeProMemoryStatus as WireMemoryStatus,
    CodeProMemoryStatusRequest, CodeProMemoryStatusResponse, CodeProMemoryTargetStatus,
    CodeProMemoryUpdateRequest, CODEPRO_MEMORY_SCHEMA_VERSION,
};
use crate::agents::platform_extensions::project_memory::{
    is_expired, is_recallable, review_fingerprint, wire_name, ProjectMemoryClient,
    ProjectMemoryEntry, ProjectMemoryReviewMutationError, ProjectMemoryStatus,
};
use chrono::{DateTime, SecondsFormat, Utc};
use std::path::Path;
use uuid::Uuid;

impl GooseAcpAgent {
    pub(super) async fn on_codepro_memory_list(
        &self,
        request: CodeProMemoryListRequest,
    ) -> Result<CodeProMemoryListResponse, agent_client_protocol::Error> {
        validate_request(request.schema_version, &request.working_dir)?;
        let page = ProjectMemoryClient::admin_list_page(
            self.memory_root.clone(),
            Path::new(&request.working_dir),
            request.include_expired,
            request.page_size,
            request.cursor.as_deref(),
        )
        .invalid_params_err()?;
        Ok(CodeProMemoryListResponse {
            schema_version: CODEPRO_MEMORY_SCHEMA_VERSION,
            project_identity: page.project_identity,
            records: page
                .entries
                .into_iter()
                .map(|entry| record_from_entry(entry, Path::new(&request.working_dir)))
                .collect(),
            next_cursor: page.next_cursor,
            total_records: page.total_entries,
            usage_bytes: page.usage_bytes,
            soft_limit_bytes: page.soft_limit_bytes,
            hard_limit_bytes: page.hard_limit_bytes,
        })
    }

    pub(super) async fn on_codepro_memory_update(
        &self,
        request: CodeProMemoryUpdateRequest,
    ) -> Result<CodeProMemoryRecordResponse, agent_client_protocol::Error> {
        validate_request(request.schema_version, &request.working_dir)?;
        let entry = ProjectMemoryClient::admin_update(
            self.memory_root.clone(),
            Path::new(&request.working_dir),
            &request.id,
            &request.content,
            &request.reason,
            request.ttl_days,
        )
        .invalid_params_err()?;
        Ok(CodeProMemoryRecordResponse {
            schema_version: CODEPRO_MEMORY_SCHEMA_VERSION,
            record: record_from_entry(entry, Path::new(&request.working_dir)),
        })
    }

    pub(super) async fn on_codepro_memory_delete(
        &self,
        request: CodeProMemoryDeleteRequest,
    ) -> Result<CodeProMemoryDeleteResponse, agent_client_protocol::Error> {
        validate_request(request.schema_version, &request.working_dir)?;
        let removed = ProjectMemoryClient::admin_delete(
            self.memory_root.clone(),
            Path::new(&request.working_dir),
            &request.id,
        )
        .invalid_params_err()?;
        Ok(CodeProMemoryDeleteResponse {
            schema_version: CODEPRO_MEMORY_SCHEMA_VERSION,
            removed,
        })
    }

    pub(super) async fn on_codepro_memory_export(
        &self,
        request: CodeProMemoryExportRequest,
    ) -> Result<CodeProMemoryExportResponse, agent_client_protocol::Error> {
        validate_request(request.schema_version, &request.working_dir)?;
        let (project_identity, entries) = ProjectMemoryClient::admin_list(
            self.memory_root.clone(),
            Path::new(&request.working_dir),
            request.include_expired,
        )
        .invalid_params_err()?;
        let records = entries
            .into_iter()
            .map(|entry| record_from_entry(entry, Path::new(&request.working_dir)))
            .collect::<Vec<_>>();
        let total_records = records.len();
        let json = serde_json::to_string_pretty(&CodeProMemoryListResponse {
            schema_version: CODEPRO_MEMORY_SCHEMA_VERSION,
            project_identity: project_identity.clone(),
            records,
            next_cursor: None,
            total_records,
            usage_bytes: 0,
            soft_limit_bytes: 0,
            hard_limit_bytes: 0,
        })
        .internal_err_ctx("Failed to serialize CodePro memory export")?;
        Ok(CodeProMemoryExportResponse {
            schema_version: CODEPRO_MEMORY_SCHEMA_VERSION,
            file_name: format!("codepro-memory-{project_identity}.json"),
            json,
        })
    }

    pub(super) async fn on_codepro_memory_get(
        &self,
        request: CodeProMemoryGetRequest,
    ) -> Result<CodeProMemoryGetResponse, agent_client_protocol::Error> {
        validate_request(request.schema_version, &request.working_dir)?;
        validate_uuid(&request.id, "id")?;
        let record =
            ProjectMemoryClient::admin_get_user_preference(self.memory_root.clone(), &request.id)
                .invalid_params_err()?
                .map(|entry| record_from_entry(entry, Path::new(&request.working_dir)));
        Ok(CodeProMemoryGetResponse {
            schema_version: CODEPRO_MEMORY_SCHEMA_VERSION,
            record,
        })
    }

    pub(super) async fn on_codepro_memory_status(
        &self,
        request: CodeProMemoryStatusRequest,
    ) -> Result<CodeProMemoryStatusResponse, agent_client_protocol::Error> {
        validate_request(request.schema_version, &request.working_dir)?;
        validate_uuid(&request.id, "id")?;
        validate_uuid(&request.action_id, "actionId")?;
        if request.review_fingerprint.len() != 64
            || !request
                .review_fingerprint
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("reviewFingerprint must be a 64-character hexadecimal digest"));
        }
        let expected_updated_at = DateTime::parse_from_rfc3339(&request.expected_updated_at)
            .map_err(|_| {
                agent_client_protocol::Error::invalid_params()
                    .data("expectedUpdatedAt must be an RFC 3339 timestamp")
            })?
            .with_timezone(&Utc);
        let target_status = match request.target_status {
            CodeProMemoryTargetStatus::Active => ProjectMemoryStatus::Active,
            CodeProMemoryTargetStatus::Disabled => ProjectMemoryStatus::Disabled,
        };
        let expected_status = match request.expected_status {
            WireMemoryStatus::Candidate => ProjectMemoryStatus::Candidate,
            WireMemoryStatus::Active => ProjectMemoryStatus::Active,
            WireMemoryStatus::Disabled => ProjectMemoryStatus::Disabled,
        };
        let (entry, changed) = ProjectMemoryClient::admin_review_user_preference_status(
            self.memory_root.clone(),
            &request.id,
            target_status,
            expected_status,
            expected_updated_at,
            &request.review_fingerprint,
        )
        .map_err(memory_review_error)?;
        Ok(CodeProMemoryStatusResponse {
            schema_version: CODEPRO_MEMORY_SCHEMA_VERSION,
            action_id: request.action_id,
            changed,
            record: record_from_entry(entry, Path::new(&request.working_dir)),
        })
    }
}
fn validate_request(
    schema_version: u16,
    working_dir: &str,
) -> Result<(), agent_client_protocol::Error> {
    if schema_version != CODEPRO_MEMORY_SCHEMA_VERSION {
        return Err(agent_client_protocol::Error::invalid_params().data(format!(
            "unsupported CodePro memory schema version {schema_version}"
        )));
    }
    if working_dir.trim().is_empty() {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("workingDir must not be empty".to_string()));
    }
    super::validate_absolute_cwd(Path::new(working_dir))
}

fn validate_uuid(value: &str, field: &str) -> Result<(), agent_client_protocol::Error> {
    Uuid::parse_str(value).map(|_| ()).map_err(|_| {
        agent_client_protocol::Error::invalid_params().data(format!("{field} must be a UUID"))
    })
}

fn memory_review_error(error: ProjectMemoryReviewMutationError) -> agent_client_protocol::Error {
    let (code, message, invalid_params) = match &error {
        ProjectMemoryReviewMutationError::Conflict(_) => {
            ("memory_review_conflict", error.message(), true)
        }
        ProjectMemoryReviewMutationError::Internal(_) => {
            ("memory_review_internal", error.message(), false)
        }
        ProjectMemoryReviewMutationError::UnknownCommit(_) => {
            ("memory_review_unknown_commit", error.message(), false)
        }
    };
    let data = serde_json::json!({
        "code": code,
        "message": message,
    });
    if invalid_params {
        agent_client_protocol::Error::invalid_params().data(data)
    } else {
        agent_client_protocol::Error::internal_error().data(data)
    }
}

fn record_from_entry(entry: ProjectMemoryEntry, workspace: &Path) -> CodeProMemoryRecord {
    let expired = is_expired(&entry, Utc::now());
    let recallable = is_recallable(&entry, workspace);
    let review_fingerprint = (entry.scope == "user" && wire_name(&entry.kind) == "preference")
        .then(|| review_fingerprint(&entry));
    CodeProMemoryRecord {
        id: entry.id,
        kind: wire_name(&entry.kind),
        subject: entry.subject,
        content: entry.content,
        scope: entry.scope,
        source: entry.source,
        status: match entry.status {
            ProjectMemoryStatus::Candidate => WireMemoryStatus::Candidate,
            ProjectMemoryStatus::Active => WireMemoryStatus::Active,
            ProjectMemoryStatus::Disabled => WireMemoryStatus::Disabled,
        },
        review_fingerprint,
        reason: entry.reason,
        source_ref: entry.source_ref,
        confidence: wire_name(&entry.confidence),
        created_at: entry.created_at.to_rfc3339(),
        updated_at: entry.updated_at.to_rfc3339_opts(SecondsFormat::Nanos, true),
        last_verified_at: entry.last_verified_at.map(|value| value.to_rfc3339()),
        expires_at: entry.expires_at.map(|value| value.to_rfc3339()),
        expired,
        recallable,
    }
}
