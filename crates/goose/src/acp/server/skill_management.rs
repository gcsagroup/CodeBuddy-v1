use super::*;
use agent_client_protocol::{JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, UntypedMessage};

impl GooseAcpAgent {
    pub(super) async fn on_list_managed_skills(
        &self,
        req: SkillManagementListRequest,
    ) -> Result<SkillManagementListResponse, agent_client_protocol::Error> {
        self.skill_management
            .list_response(req.project_dir.as_deref())
    }

    pub(super) async fn on_read_managed_skill(
        &self,
        req: SkillManagementReadRequest,
    ) -> Result<SkillManagementReadResponse, agent_client_protocol::Error> {
        Ok(SkillManagementReadResponse {
            skill: self
                .skill_management
                .read(req.project_dir.as_deref(), &req.source)?,
        })
    }

    pub(super) async fn on_preview_skill_change(
        &self,
        req: SkillManagementPreviewRequest,
    ) -> Result<SkillManagementPreviewResponse, agent_client_protocol::Error> {
        self.skill_management.preview(req.project_dir, req.change)
    }

    pub(super) async fn on_preview_skill_download(
        &self,
        req: SkillManagementDownloadPreviewRequest,
    ) -> Result<SkillManagementPreviewResponse, agent_client_protocol::Error> {
        self.skill_management
            .preview_download(req.project_dir, req.destination, &req.url)
            .await
    }

    pub(super) async fn on_apply_skill_change(
        &self,
        req: SkillManagementApplyRequest,
    ) -> Result<SkillManagementApplyResponse, agent_client_protocol::Error> {
        let preview = self.skill_management.pending(&req.preview_token)?;
        let approval = if preview.requires_confirmation {
            let request = self
                .skill_management
                .confirmation_request(&req.preview_token)?;
            let response = self
                .request_skill_management_confirmation(request.clone())
                .await?;
            Some(self.skill_management.approve(&request, response)?)
        } else {
            None
        };
        self.skill_management.apply(&req.preview_token, approval)
    }

    pub(super) async fn on_list_skill_recoveries(
        &self,
        req: SkillManagementRecoveryListRequest,
    ) -> Result<SkillManagementRecoveryListResponse, agent_client_protocol::Error> {
        Ok(SkillManagementRecoveryListResponse {
            entries: self
                .skill_management
                .recovery_list(req.project_dir.as_deref())?,
        })
    }

    async fn request_skill_management_confirmation(
        &self,
        request: RequestSkillManagementConfirmation,
    ) -> Result<SkillManagementConfirmationResponse, agent_client_protocol::Error> {
        let cx = self.client_cx.get().ok_or_else(|| {
            agent_client_protocol::Error::internal_error().data("ACP client is not connected")
        })?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        cx.send_request(RequestSkillManagementConfirmationMessage(request))
            .on_receiving_result(move |result| async move {
                let _ = tx.send(result.map(|response| response.0));
                Ok(())
            })?;
        rx.await.map_err(|_| {
            agent_client_protocol::Error::internal_error()
                .data("skill management confirmation request was dropped")
        })?
    }
}

#[derive(Debug, Clone)]
struct RequestSkillManagementConfirmationMessage(RequestSkillManagementConfirmation);

impl JsonRpcMessage for RequestSkillManagementConfirmationMessage {
    fn matches_method(method: &str) -> bool {
        method == REQUEST_SKILL_MANAGEMENT_CONFIRMATION_METHOD
    }

    fn method(&self) -> &str {
        REQUEST_SKILL_MANAGEMENT_CONFIRMATION_METHOD
    }

    fn to_untyped_message(&self) -> Result<UntypedMessage, agent_client_protocol::Error> {
        UntypedMessage::new(REQUEST_SKILL_MANAGEMENT_CONFIRMATION_METHOD, &self.0)
    }

    fn parse_message(
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<Self, agent_client_protocol::Error> {
        if !Self::matches_method(method) {
            return Err(agent_client_protocol::Error::method_not_found());
        }
        Ok(Self(agent_client_protocol::util::json_cast_params(params)?))
    }
}

impl JsonRpcRequest for RequestSkillManagementConfirmationMessage {
    type Response = SkillManagementConfirmationResponseMessage;
}

#[derive(Debug, Clone)]
struct SkillManagementConfirmationResponseMessage(SkillManagementConfirmationResponse);

impl JsonRpcResponse for SkillManagementConfirmationResponseMessage {
    fn into_json(self, _method: &str) -> Result<serde_json::Value, agent_client_protocol::Error> {
        serde_json::to_value(self.0).map_err(agent_client_protocol::Error::into_internal_error)
    }

    fn from_value(
        _method: &str,
        value: serde_json::Value,
    ) -> Result<Self, agent_client_protocol::Error> {
        Ok(Self(agent_client_protocol::util::json_cast(&value)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_message_uses_the_bounded_client_method_and_response_shape() {
        let request =
            RequestSkillManagementConfirmationMessage(RequestSkillManagementConfirmation {
                preview_token: "preview".into(),
                nonce: "nonce".into(),
                operation: "delete".into(),
                target: "sample".into(),
                source: None,
                expected_version: None,
                expires_at: "2026-09-05T00:00:00Z".into(),
            });
        assert_eq!(
            request.method(),
            REQUEST_SKILL_MANAGEMENT_CONFIRMATION_METHOD
        );
        let response = SkillManagementConfirmationResponseMessage::from_value(
            request.method(),
            serde_json::json!({ "decision": "confirm", "nonce": "nonce" }),
        )
        .unwrap();
        assert_eq!(
            response.0.decision,
            SkillManagementConfirmationDecision::Confirm
        );
    }
}
