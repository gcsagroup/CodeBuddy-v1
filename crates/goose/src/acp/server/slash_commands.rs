use super::*;

impl GooseAcpAgent {
    pub(super) async fn on_list_slash_commands(
        &self,
        req: ListSlashCommandsRequest,
    ) -> Result<ListSlashCommandsResponse, agent_client_protocol::Error> {
        let session_id = req
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty());
        let Some(session_id) = session_id else {
            return Ok(ListSlashCommandsResponse {
                available_commands:
                    crate::acp::response_builder::available_commands_for_optional_working_dir(None),
            });
        };
        let _workspace_access = self
            .acquire_session_dispatch_access(session_id, true)
            .await?;
        let session = self
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {}", session_id))
            })?;
        if let Some(requested) = req
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            if std::path::Path::new(requested) != session.working_dir {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("cwd cannot override the persisted session workspace"));
            }
        }
        let cwd = session.working_dir;

        Ok(ListSlashCommandsResponse {
            available_commands:
                crate::acp::response_builder::available_commands_for_optional_working_dir(Some(
                    cwd.as_path(),
                )),
        })
    }
}
