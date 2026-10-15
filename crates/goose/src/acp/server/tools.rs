use super::*;
use crate::agents::codepro_workspace_binding::CodeProWorkspacePermissions;
use crate::agents::extension_manager::get_parameter_names;
use crate::agents::platform_extensions::tool_registry::{
    codepro_tool_spec, CodeProPermissionClass,
};
use crate::agents::reply_parts::is_tool_visible_to_app;
use crate::config::permission::PermissionLevel;
use crate::permission::permission_inspector::codepro_effective_permission_level;
use crate::session::extension_data::ExtensionState as CodeProExtensionState;
use goose_sdk_types::custom_requests::{
    GrantCodeProRestrictedReadonlyRequest, ToolListItem, ToolPermissionLevel,
};
use rmcp::model::CallToolRequestParams;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectToolPermissionRequirement {
    Allow,
    RequireApproval,
    Deny,
}

fn direct_tool_permission_requirement(
    tool_name: &str,
    user_permission: Option<PermissionLevel>,
) -> DirectToolPermissionRequirement {
    match codepro_effective_permission_level(tool_name, user_permission.clone())
        .or(user_permission)
        .unwrap_or(PermissionLevel::AskBefore)
    {
        PermissionLevel::AlwaysAllow => DirectToolPermissionRequirement::Allow,
        PermissionLevel::AskBefore => DirectToolPermissionRequirement::RequireApproval,
        PermissionLevel::NeverAllow => DirectToolPermissionRequirement::Deny,
    }
}

fn display_permission_class(class: CodeProPermissionClass) -> ToolPermissionClass {
    match class {
        CodeProPermissionClass::ReadOnly => ToolPermissionClass::ReadOnly,
        CodeProPermissionClass::WorkspaceWrite => ToolPermissionClass::WorkspaceWrite,
        CodeProPermissionClass::ExternalWrite => ToolPermissionClass::ExternalWrite,
        CodeProPermissionClass::HighRisk => ToolPermissionClass::HighRisk,
        CodeProPermissionClass::Forbidden => ToolPermissionClass::Forbidden,
    }
}

impl GooseAcpAgent {
    pub(super) async fn on_get_tools(
        &self,
        req: GetToolsRequest,
    ) -> Result<GetToolsResponse, agent_client_protocol::Error> {
        let _workspace_access = self
            .acquire_session_dispatch_access(&req.session_id, true)
            .await?;
        let session_id = &req.session_id;
        let agent = self.get_session_agent(&req.session_id).await?;
        let goose_mode = agent.goose_mode().await;
        let permission_manager = self.permission_manager();

        let mut tools: Vec<ToolListItem> = agent
            .list_tools(session_id, req.extension_name)
            .await
            .into_iter()
            .map(|tool| {
                let user_permission = permission_manager.get_user_permission(&tool.name);
                let permission =
                    codepro_effective_permission_level(&tool.name, user_permission.clone())
                        .or(user_permission)
                        .or_else(|| {
                            if goose_mode == GooseMode::SmartApprove {
                                permission_manager.get_smart_approve_permission(&tool.name)
                            } else if goose_mode == GooseMode::Approve {
                                Some(PermissionLevel::AskBefore)
                            } else {
                                None
                            }
                        })
                        .map(|p| match p {
                            PermissionLevel::AlwaysAllow => ToolPermissionLevel::AlwaysAllow,
                            PermissionLevel::AskBefore => ToolPermissionLevel::AskBefore,
                            PermissionLevel::NeverAllow => ToolPermissionLevel::NeverAllow,
                        });
                ToolListItem {
                    name: tool.name.to_string(),
                    description: tool
                        .description
                        .as_ref()
                        .map(|d| d.as_ref().to_string())
                        .unwrap_or_default(),
                    parameters: get_parameter_names(&tool),
                    permission,
                    input_schema: serde_json::Value::Object(tool.input_schema.as_ref().clone()),
                    output_schema: tool
                        .output_schema
                        .as_ref()
                        .map(|s| serde_json::to_value(s).unwrap_or(serde_json::Value::Null)),
                }
            })
            .collect();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(GetToolsResponse { tools })
    }

    pub(super) async fn on_call_tool(
        &self,
        req: GooseToolCallRequest,
    ) -> Result<GooseToolCallResponse, agent_client_protocol::Error> {
        let _workspace_access = self
            .acquire_session_dispatch_access(&req.session_id, true)
            .await?;
        let session_id = &req.session_id;
        let session = self
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.clone()))
                    .data(format!("Session not found: {session_id}"))
            })?;
        let agent = self.get_session_agent(&req.session_id).await?;
        let tools = agent.list_tools(session_id, None).await;

        let Some(tool) = tools.iter().find(|t| *t.name == req.name) else {
            return Err(agent_client_protocol::Error::invalid_params().data("tool not found"));
        };

        if !is_tool_visible_to_app(tool) {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("tool is not visible to app clients"));
        }

        let arguments = match req.arguments {
            serde_json::Value::Object(map) => Some(map),
            serde_json::Value::Null => None,
            _ => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("tool arguments must be an object"));
            }
        };

        let tool_call = {
            let mut params = CallToolRequestParams::new(req.name);
            if let Some(args) = arguments {
                params = params.with_arguments(args);
            }
            params
        };

        let request_id = format!("direct_tool_{}", Uuid::new_v4());
        let method_context = agent
            .tool_call_context(&session, request_id.clone(), false)
            .await;
        agent
            .extension_manager
            .check_computer_method(&method_context, &tool_call)
            .await
            .map_err(|error| {
                agent_client_protocol::Error::invalid_params().data(error.to_string())
            })?;
        let explicitly_confirmed = self
            .authorize_direct_tool_call(session_id, &tool_call, &request_id)
            .await?;

        let ctx = agent
            .tool_call_context(&session, request_id, explicitly_confirmed)
            .await;
        let tool_result = agent
            .extension_manager
            .dispatch_tool_call(&ctx, tool_call, CancellationToken::new())
            .await
            .map_err(|e| agent_client_protocol::Error::internal_error().data(e.to_string()))?;

        let result = tool_result
            .result
            .await
            .map_err(|e| agent_client_protocol::Error::internal_error().data(e.to_string()))?;

        let content = result
            .content
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| agent_client_protocol::Error::internal_error().data(e.to_string()))?;

        Ok(GooseToolCallResponse {
            content,
            structured_content: result.structured_content,
            is_error: result.is_error.unwrap_or(false),
            meta: result.meta.and_then(|m| serde_json::to_value(m).ok()),
        })
    }

    async fn authorize_direct_tool_call(
        &self,
        session_id: &str,
        tool_call: &CallToolRequestParams,
        request_id: &str,
    ) -> Result<bool, agent_client_protocol::Error> {
        let tool_name = tool_call.name.as_ref();
        let permission_manager = self.permission_manager();
        match direct_tool_permission_requirement(
            tool_name,
            permission_manager.get_user_permission(tool_name),
        ) {
            DirectToolPermissionRequirement::Allow => return Ok(false),
            DirectToolPermissionRequirement::Deny => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data(format!("Tool '{tool_name}' is denied by permission policy")));
            }
            DirectToolPermissionRequirement::RequireApproval => {}
        }

        let permission_class = codepro_tool_spec(tool_name)
            .map(|spec| display_permission_class(spec.permission))
            .unwrap_or(ToolPermissionClass::Legacy);
        let authorization_scope = ToolAuthorizationScope::Global;
        let arguments = tool_call.arguments.clone().unwrap_or_default();
        let fields = ToolCallUpdateFields::new()
            .title(format_tool_name(tool_name))
            .kind(ToolKind::default())
            .status(ToolCallStatus::Pending)
            .raw_input(serde_json::Value::Object(arguments));
        let permission_request = RequestPermissionRequest::new(
            SessionId::new(session_id.to_string()),
            ToolCallUpdate::new(ToolCallId::new(request_id.to_string()), fields),
            permission_options_for_context(Some(permission_class), Some(authorization_scope)),
        )
        .meta(codepro_permission_request_meta(
            Some(permission_class),
            Some(ToolExtensionSource::Platform),
            Some(authorization_scope),
            None,
        ));

        let cx = self.client_cx.get().ok_or_else(|| {
            agent_client_protocol::Error::internal_error()
                .data("Tool approval is unavailable because the ACP client is disconnected")
        })?;
        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        cx.send_request(permission_request)
            .on_receiving_result(move |result| async move {
                let _ = response_tx.send(result);
                Ok(())
            })?;
        let response = response_rx
            .await
            .map_err(|_| {
                agent_client_protocol::Error::internal_error()
                    .data("Tool approval response channel closed")
            })?
            .map_err(|error| {
                agent_client_protocol::Error::internal_error()
                    .data(format!("Tool approval request failed: {error}"))
            })?;
        let decision = PermissionDecision::from(&response.outcome);

        match decision {
            PermissionDecision::AllowOnce => Ok(true),
            PermissionDecision::AllowAlways => {
                if long_term_allow_is_safe(Some(permission_class), Some(authorization_scope)) {
                    permission_manager
                        .update_user_permission(tool_name, PermissionLevel::AlwaysAllow);
                    Ok(true)
                } else {
                    Err(agent_client_protocol::Error::invalid_params()
                        .data(format!("Tool '{tool_name}' cannot be permanently allowed")))
                }
            }
            PermissionDecision::RejectAlways => {
                permission_manager.update_user_permission(tool_name, PermissionLevel::NeverAllow);
                Err(agent_client_protocol::Error::invalid_params()
                    .data(format!("Tool '{tool_name}' was denied by the user")))
            }
            PermissionDecision::RejectOnce | PermissionDecision::Cancel => {
                Err(agent_client_protocol::Error::invalid_params()
                    .data(format!("Tool '{tool_name}' was not approved")))
            }
        }
    }

    pub(super) async fn on_set_tool_permissions(
        &self,
        req: SetToolPermissionsRequest,
    ) -> Result<SetToolPermissionsResponse, agent_client_protocol::Error> {
        let permission_manager = self.permission_manager();
        for entry in &req.tool_permissions {
            let level = match entry.permission {
                ToolPermissionLevel::AlwaysAllow => PermissionLevel::AlwaysAllow,
                ToolPermissionLevel::AskBefore => PermissionLevel::AskBefore,
                ToolPermissionLevel::NeverAllow => PermissionLevel::NeverAllow,
            };
            let level = codepro_effective_permission_level(&entry.tool_name, Some(level.clone()))
                .unwrap_or(level);
            permission_manager.update_user_permission(&entry.tool_name, level);
        }
        Ok(SetToolPermissionsResponse {})
    }

    pub(super) async fn on_grant_codepro_restricted_readonly(
        &self,
        req: GrantCodeProRestrictedReadonlyRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        let _workspace_access = self
            .acquire_session_dispatch_access(&req.session_id, false)
            .await?;
        let session = self
            .session_manager
            .get_session(&req.session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(req.session_id.clone()))
            })?;
        if session.session_type != crate::session::SessionType::CodePro {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("restricted read-only capability is only available for CodePro sessions"));
        }
        let mut extension_data = session.extension_data;
        let mut perms =
            CodeProWorkspacePermissions::from_extension_data(&extension_data).unwrap_or_default();
        perms.restricted_readonly_allowed = true;
        perms.to_extension_data(&mut extension_data).map_err(|e| {
            agent_client_protocol::Error::internal_error().data(format!(
                "failed to serialize CodePro workspace permissions: {e}"
            ))
        })?;
        self.session_manager
            .update(&req.session_id)
            .extension_data(extension_data)
            .apply()
            .await
            .map_err(|e| {
                agent_client_protocol::Error::internal_error().data(format!(
                    "failed to persist CodePro workspace permissions: {e}"
                ))
            })?;
        Ok(EmptyResponse {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_git_tool_calls_enforce_host_permission_classes() {
        assert_eq!(
            direct_tool_permission_requirement("git_status", None),
            DirectToolPermissionRequirement::Allow
        );
        assert_eq!(
            direct_tool_permission_requirement("git_stage", None),
            DirectToolPermissionRequirement::RequireApproval
        );
        assert_eq!(
            direct_tool_permission_requirement("git_push", Some(PermissionLevel::AlwaysAllow)),
            DirectToolPermissionRequirement::RequireApproval
        );
        assert_eq!(
            direct_tool_permission_requirement("git_commit", Some(PermissionLevel::NeverAllow)),
            DirectToolPermissionRequirement::Deny
        );
    }
}
