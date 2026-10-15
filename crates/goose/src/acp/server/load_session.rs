use super::tool_calls::conversion::{
    extract_tool_call_update_meta, pending_tool_call_from_request,
    tool_call_update_fields_from_response,
};
use super::tool_calls::enrichment::with_tool_chain_summary_meta;
use super::*;

#[cfg(any(windows, target_os = "macos"))]
const CODEPRO_WORKSPACE_RECONFIRMATION_REQUIRED: &str =
    "CodePro workspace must be re-confirmed before this session can be resumed";

#[cfg(any(windows, target_os = "macos"))]
struct PreparedResumeWorkspaceLease {
    session_id: String,
    lease_id: String,
    committed: bool,
    acquired_here: bool,
}

#[cfg(any(windows, target_os = "macos"))]
impl PreparedResumeWorkspaceLease {
    fn commit(mut self) {
        self.committed = true;
    }

    fn rollback(mut self) -> anyhow::Result<()> {
        if self.acquired_here {
            workspace_lease::rollback_failed_session_workspace_lease(&self.session_id)?;
        }
        self.committed = true;
        Ok(())
    }
}

#[cfg(any(windows, target_os = "macos"))]
impl Drop for PreparedResumeWorkspaceLease {
    fn drop(&mut self) {
        if !self.committed && self.acquired_here {
            if let Err(error) =
                workspace_lease::rollback_failed_session_workspace_lease(&self.session_id)
            {
                error!(
                    session_id = %self.session_id,
                    lease_id = %self.lease_id,
                    %error,
                    "failed to rollback an uncommitted resumed workspace lease"
                );
            }
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn codepro_workspace_reconfirmation_error() -> agent_client_protocol::Error {
    agent_client_protocol::Error::invalid_params().data(CODEPRO_WORKSPACE_RECONFIRMATION_REQUIRED)
}

#[cfg(any(windows, target_os = "macos"))]
fn prepare_codepro_resume_workspace_lease(
    session_type: &SessionType,
    session_id: &str,
    stored_cwd: &std::path::Path,
    requested_cwd: &std::path::Path,
    extension_data: &crate::session::extension_data::ExtensionData,
    meta: Option<&Meta>,
) -> Result<Option<PreparedResumeWorkspaceLease>, agent_client_protocol::Error> {
    if *session_type != SessionType::CodePro {
        return Ok(None);
    }

    let binding = crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::from_extension_data_strict(
        extension_data,
    )
    .map_err(|_| codepro_workspace_reconfirmation_error())?;
    let persisted_lease_id = match &binding {
        Some(
            crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::WritableProject {
                lease_id,
                ..
            },
        ) => Some(lease_id.clone()),
        _ => None,
    };
    let project_container = matches!(
        &binding,
        Some(
            crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::ProjectContainer { .. }
        )
    );
    let has_persisted_writable_binding = match binding {
        Some(crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::Unbound) => {
            if stored_cwd != requested_cwd {
                return Err(codepro_workspace_reconfirmation_error());
            }
            return Ok(None);
        }
        Some(
            crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::RootContainer {
                path,
            }
            | crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::ProjectContainer {
                path,
            },
        ) => {
            #[cfg(target_os = "macos")]
            let valid_container = if project_container {
                workspace_lease::validate_project_container_path(stored_cwd).is_ok()
            } else {
                workspace_lease::validate_root_container_path(stored_cwd).is_ok()
            };
            #[cfg(not(target_os = "macos"))]
            let valid_container = !project_container
                && workspace_lease::validate_root_container_path(stored_cwd).is_ok();
            if Path::new(&path) != stored_cwd || !valid_container {
                return Err(codepro_workspace_reconfirmation_error());
            }
            if stored_cwd == requested_cwd {
                return Ok(None);
            }
            let is_direct_child = requested_cwd
                .strip_prefix(stored_cwd)
                .is_ok_and(|relative| relative.components().count() == 1);
            if !is_direct_child {
                return Err(codepro_workspace_reconfirmation_error());
            }
            let lease_id = meta_string(meta, "workspaceLeaseId")?
                .ok_or_else(codepro_workspace_reconfirmation_error)?;
            let lease = workspace_lease::consume_allocated_workspace_lease(
                &lease_id,
                requested_cwd,
                session_id,
            )
            .map_err(|_| codepro_workspace_reconfirmation_error())?;
            workspace_lease::validate_consumed_workspace_lease(&lease, requested_cwd)
                .map_err(|_| codepro_workspace_reconfirmation_error())?;
            workspace_lease::bind_workspace_lease(session_id, lease)
                .map_err(|_| codepro_workspace_reconfirmation_error())?;
            return Ok(Some(PreparedResumeWorkspaceLease {
                session_id: session_id.to_string(),
                lease_id,
                committed: false,
                acquired_here: true,
            }));
        }
        Some(
            crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::WritableProject {
                path,
                ..
            },
        ) => {
            if Path::new(&path) != stored_cwd || stored_cwd != requested_cwd {
                return Err(codepro_workspace_reconfirmation_error());
            }
            true
        }
        None => false,
    };

    if workspace_lease::session_has_workspace_lease(session_id)
        .map_err(|_| codepro_workspace_reconfirmation_error())?
    {
        for cwd in [stored_cwd, requested_cwd] {
            workspace_lease::validate_session_workspace_lease(session_id, cwd)
                .map_err(|_| codepro_workspace_reconfirmation_error())?;
        }
        let authoritative_lease_id =
            workspace_lease::validated_session_workspace_lease_id(session_id, stored_cwd)
                .map_err(|_| codepro_workspace_reconfirmation_error())?;
        if persisted_lease_id
            .as_deref()
            .is_some_and(|id| id != authoritative_lease_id)
        {
            return Ok(Some(PreparedResumeWorkspaceLease {
                session_id: session_id.to_string(),
                lease_id: authoritative_lease_id,
                committed: false,
                acquired_here: false,
            }));
        }
        return Ok(None);
    }

    let Some(lease_id) = meta_string(meta, "workspaceLeaseId")? else {
        if !has_persisted_writable_binding {
            return Err(codepro_workspace_reconfirmation_error());
        }
        let lease_id =
            workspace_lease::reacquire_existing_session_workspace_lease(session_id, stored_cwd)
                .map_err(|_| codepro_workspace_reconfirmation_error())?;
        return Ok(Some(PreparedResumeWorkspaceLease {
            session_id: session_id.to_string(),
            lease_id,
            committed: false,
            acquired_here: true,
        }));
    };
    let lease = workspace_lease::consume_workspace_lease(&lease_id, stored_cwd)
        .map_err(|_| codepro_workspace_reconfirmation_error())?;
    workspace_lease::validate_consumed_workspace_lease(&lease, requested_cwd)
        .map_err(|_| codepro_workspace_reconfirmation_error())?;
    workspace_lease::bind_workspace_lease(session_id, lease)
        .map_err(|_| codepro_workspace_reconfirmation_error())?;
    Ok(Some(PreparedResumeWorkspaceLease {
        session_id: session_id.to_string(),
        lease_id,
        committed: false,
        acquired_here: true,
    }))
}

fn replay_audience_annotations(audience: &[Role]) -> Annotations {
    Annotations::new().audience(
        audience
            .iter()
            .map(|role| match role {
                Role::Assistant => agent_client_protocol::schema::v1::Role::Assistant,
                Role::User => agent_client_protocol::schema::v1::Role::User,
            })
            .collect::<Vec<_>>(),
    )
}

fn should_replay_system_notification(notification: &SystemNotificationContent) -> bool {
    match notification.notification_type {
        SystemNotificationType::ThinkingMessage => false,
        SystemNotificationType::ProgressMessage => notification
            .data
            .as_ref()
            .is_some_and(|data| data.get("event_id").is_some() && data.get("event_type").is_some()),
        _ => true,
    }
}

fn send_replay_content_chunk(
    cx: &ConnectionTo<Client>,
    session_id: &SessionId,
    message: &Message,
    content: ContentBlock,
) -> std::result::Result<(), agent_client_protocol::Error> {
    let chunk = ContentChunk::new(content).meta(replay_message_meta(message));
    let update = match message.role {
        Role::User => SessionUpdate::UserMessageChunk(chunk),
        Role::Assistant => SessionUpdate::AgentMessageChunk(chunk),
    };
    cx.send_notification(SessionNotification::new(session_id.clone(), update))
}

fn replay_messages_with_unique_ids(mut messages: Vec<Message>) -> Vec<Message> {
    // Repair only the client projection of old duplicate identities. Do not
    // migrate stored messages, tool call IDs, user sources, or run evidence.
    let mut reserved = messages
        .iter()
        .filter_map(|m| m.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let has_terminal = |message: &Message| {
        message.content.iter().any(|content| {
            matches!(content, MessageContent::SystemNotification(notification)
            if notification.notification_type == SystemNotificationType::TurnTerminal)
        })
    };
    let mut seen = messages
        .iter()
        .filter(|m| m.role == Role::User || has_terminal(m))
        .filter_map(|m| m.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut preceding_identity: Option<(String, String)> = None;
    for (index, message) in messages.iter_mut().enumerate() {
        // Control/retry identities must still resolve against persisted facts.
        if message.role != Role::Assistant || has_terminal(message) {
            preceding_identity = None;
            continue;
        }
        let Some(original_id) = message.id.clone() else {
            preceding_identity = None;
            continue;
        };
        // Consecutive deltas retain Conversation::push's existing identity
        // semantics. A separated reuse must not append to an earlier card.
        let id = if let Some((_, id)) = preceding_identity
            .as_ref()
            .filter(|(original, _)| original == &original_id)
        {
            id.clone()
        } else if seen.insert(original_id.clone()) {
            original_id.clone()
        } else {
            let mut suffix = 0;
            let id = loop {
                let candidate = format!("replay-{index}-{suffix}-{original_id}");
                if reserved.insert(candidate.clone()) {
                    break candidate;
                }
                suffix += 1;
            };
            tracing::warn!(original_message_id = %original_id, replay_message_id = %id,
                record_index = index, "Duplicate historical message identity isolated for replay");
            id
        };
        preceding_identity = Some((original_id.clone(), id.clone()));
        if id == original_id {
            continue;
        }
        message.id = Some(id);
    }
    messages
}

fn replay_conversation_to_client(
    cx: &ConnectionTo<Client>,
    session: &Session,
    supports_goose_custom_notifications: bool,
) -> Result<HashMap<String, crate::conversation::message::ToolRequest>, agent_client_protocol::Error>
{
    let session_id = SessionId::new(session.id.clone());
    let tool_call_notifier = ToolCallNotifier::new(cx, &session_id);
    let sid = sid_short(session_id.0.as_ref());

    let messages = replay_messages_with_unique_ids(
        session
            .conversation
            .as_ref()
            .map(|c| c.user_visible_messages())
            .unwrap_or_default(),
    );
    debug!(
        target: "perf",
        sid = %sid,
        messages = messages.len(),
            "perf: load_session messages loaded"
    );

    let mut replay_tool_requests =
        HashMap::<String, crate::conversation::message::ToolRequest>::new();

    for message in &messages {
        for content_item in &message.content {
            match content_item {
                MessageContent::Text(text) => {
                    let mut tc = TextContent::new(text.text.clone());
                    if let Some(audience) = text.audience() {
                        tc = tc.annotations(replay_audience_annotations(audience));
                    }
                    send_replay_content_chunk(cx, &session_id, message, ContentBlock::Text(tc))?;
                }
                MessageContent::Image(image) => {
                    let mut image_content =
                        ImageContent::new(image.data.clone(), image.mime_type.clone());
                    if let Some(audience) = image.audience() {
                        image_content =
                            image_content.annotations(replay_audience_annotations(audience));
                    }
                    send_replay_content_chunk(
                        cx,
                        &session_id,
                        message,
                        ContentBlock::Image(image_content),
                    )?;
                }
                MessageContent::ToolRequest(tool_request) => {
                    replay_tool_requests.insert(tool_request.id.clone(), tool_request.clone());

                    let pending_tool_call = pending_tool_call_from_request(tool_request);
                    let mut meta = pending_tool_call.identity_meta;
                    if let Some(chain_summary) = tool_request.persisted_chain_summary() {
                        meta = with_tool_chain_summary_meta(
                            meta,
                            &chain_summary.summary,
                            chain_summary.count,
                        );
                    }
                    let tool_call = pending_tool_call
                        .tool_call
                        .meta(merge_replay_message_meta(meta, message));

                    tool_call_notifier.send_initial(tool_call)?;
                }
                MessageContent::ToolResponse(tool_response) => {
                    let fields = tool_call_update_fields_from_response(
                        tool_response,
                        replay_tool_requests.get(&tool_response.id),
                    );

                    let update =
                        ToolCallUpdate::new(ToolCallId::new(tool_response.id.clone()), fields)
                            .meta(merge_replay_message_meta(
                                extract_tool_call_update_meta(tool_response),
                                message,
                            ));
                    tool_call_notifier.send_update(update)?;
                }
                MessageContent::Thinking(thinking) => {
                    cx.send_notification(SessionNotification::new(
                        session_id.clone(),
                        SessionUpdate::AgentThoughtChunk(
                            ContentChunk::new(ContentBlock::Text(TextContent::new(
                                thinking.thinking.clone(),
                            )))
                            .meta(replay_message_meta(message)),
                        ),
                    ))?;
                }
                MessageContent::SystemNotification(notification)
                    if should_replay_system_notification(notification) =>
                {
                    send_status_message_update(
                        cx,
                        supports_goose_custom_notifications,
                        session.id.as_str(),
                        notification,
                        None,
                    )?;
                }
                _ => {}
            }
        }

        if supports_goose_custom_notifications {
            if let Some(usage) = &message.metadata.usage {
                cx.send_notification(GooseSessionNotification {
                    session_id: session.id.clone(),
                    update: GooseSessionUpdate::MessageUsage(message_usage_update(
                        message.id.clone(),
                        usage,
                    )),
                })?;
            }
        }
    }

    // Restore after compaction from the host-bound store, not old tool text.
    use crate::session::extension_data::{CodeProTodoState, ExtensionState};
    if let Some(state) = CodeProTodoState::from_extension_data(&session.extension_data) {
        if state
            .selected
            .as_ref()
            .is_none_or(|binding| binding.session_id == session.id)
        {
            let notification = SystemNotificationContent {
                notification_type: SystemNotificationType::ProgressMessage,
                msg: String::new(),
                data: Some(serde_json::json!({
                    "type": "codepro_plan_context", "event_type": "plan_context", "schema_version": 1,
                    "event_id": format!("restored-plan-{}", session.id), "session_id": session.id,
                    "selected": state.selected, "plan": state.current(),
                })),
            };
            send_status_message_update(
                cx,
                supports_goose_custom_notifications,
                &session.id,
                &notification,
                None,
            )?;
        }
    }
    Ok(replay_tool_requests)
}

impl GooseAcpAgent {
    async fn restore_session_after_failed_load(&self, session: &Session) -> anyhow::Result<()> {
        let mut update = self
            .session_manager
            .update(&session.id)
            .working_dir(session.working_dir.clone())
            .extension_data(session.extension_data.clone())
            .goose_mode(session.goose_mode);
        update = match session.provider_name.as_ref() {
            Some(provider_name) => update.provider_name(provider_name.clone()),
            None => update.clear_provider_name(),
        };
        update = match session.model_config.as_ref() {
            Some(model_config) => update.model_config(model_config.clone()),
            None => update.clear_model_config(),
        };
        update.apply().await
    }

    pub(super) async fn handle_load_session(
        &self,
        cx: &ConnectionTo<Client>,
        args: LoadSessionRequest,
    ) -> Result<LoadSessionResponse, agent_client_protocol::Error> {
        debug!(?args, "load session request");
        validate_absolute_cwd(&args.cwd)?;

        let session_id_str = args.session_id.0.to_string();
        #[cfg(any(windows, target_os = "macos"))]
        let _lifecycle = workspace_lease::lock_session_lifecycle(&session_id_str)
            .await
            .internal_err_ctx("Failed to lock CodePro session lifecycle")?;
        #[cfg(any(windows, target_os = "macos"))]
        let load_transaction =
            workspace_lease::begin_session_lifecycle_transaction(&session_id_str)
                .internal_err_ctx("Failed to suspend CodePro session access for load")?;
        #[cfg(any(windows, target_os = "macos"))]
        {
            let mut active_prompt_runs = self.active_prompt_runs.lock().await;
            cancel_active_run(&mut active_prompt_runs, &session_id_str);
        }
        #[cfg(any(windows, target_os = "macos"))]
        load_transaction
            .wait_for_idle()
            .await
            .internal_err_ctx("Failed to drain CodePro session access for load")?;
        let sid = sid_short(&session_id_str);
        let t_start = std::time::Instant::now();

        let mut session = self
            .session_manager
            .get_session(&session_id_str, true)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id_str.clone()))
                    .data(format!("Session not found: {}", session_id_str))
            })?;
        let original_session = session.clone();

        #[cfg(any(windows, target_os = "macos"))]
        let mut resumed_lease = prepare_codepro_resume_workspace_lease(
            &session.session_type,
            &session_id_str,
            &session.working_dir,
            &args.cwd,
            &session.extension_data,
            args.meta.as_ref(),
        )?;
        let load_result = async {
            #[cfg(any(windows, target_os = "macos"))]
            if let Some(resumed_lease) = resumed_lease.as_ref() {
                let binding = crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::WritableProject {
                    path: args.cwd.to_string_lossy().into_owned(),
                    lease_id: resumed_lease.lease_id.clone(),
                };
                binding
                    .to_extension_data(&mut session.extension_data)
                    .map_err(|_| codepro_workspace_reconfirmation_error())?;
            }

            session = self
                .prepare_session_for_activation(session, args.cwd.clone(), args.mcp_servers, true)
                .await?;

            let replay_tool_requests = replay_conversation_to_client(
                cx,
                &session,
                self.supports_goose_custom_notifications(),
            )?;
            let (agent, extension_results) = self.prepare_acp_session_agent(cx, &session).await?;
            self.apply_session_recipe(&agent, &session).await?;

            self.session_manager
                .update(&session_id_str)
                .extension_data(session.extension_data.clone())
                .apply()
                .await
                .internal_err_ctx("Failed to persist resumed workspace binding")?;
            session = self
                .session_manager
                .get_session(&session_id_str, true)
                .await
                .internal_err_ctx("Failed to reload session")?;

            agent
                .extension_manager
                .update_working_dir(&session.working_dir)
                .await;
            let (mode_state, config_options) =
                build_session_setup_config(&self.provider_inventory, &session).await?;
            self.notify_session_setup(cx, &session).await?;

            let mut response = LoadSessionResponse::new().modes(mode_state);
            if let Some(co) = config_options {
                response = response.config_options(co);
            }
            response = response.meta(session_response_meta(&session, &extension_results));
            self.register_acp_session(
                session_id_str.clone(),
                session.session_type,
                agent,
                replay_tool_requests,
            )
            .await;
            Ok(response)
        }
        .await;

        let response = match load_result {
            Ok(response) => response,
            Err(error) => {
                let session_rollback = self
                    .restore_session_after_failed_load(&original_session)
                    .await;
                #[cfg(any(windows, target_os = "macos"))]
                let lease_rollback = resumed_lease
                    .take()
                    .map(PreparedResumeWorkspaceLease::rollback)
                    .transpose();
                #[cfg(not(any(windows, target_os = "macos")))]
                let lease_rollback: anyhow::Result<()> = Ok(());
                if session_rollback.is_err() || lease_rollback.is_err() {
                    return Err(agent_client_protocol::Error::internal_error().data(format!(
                        "{error}; failed load rollback: session={}; workspace={}",
                        session_rollback
                            .err()
                            .map(|error| error.to_string())
                            .unwrap_or_else(|| "ok".to_string()),
                        lease_rollback
                            .err()
                            .map(|error| error.to_string())
                            .unwrap_or_else(|| "ok".to_string())
                    )));
                }
                return Err(error);
            }
        };

        debug!(
            target: "perf",
            sid = %sid,
            ms = t_start.elapsed().as_millis() as u64,
            "perf: load_session_refactor done"
        );
        #[cfg(any(windows, target_os = "macos"))]
        if let Some(resumed_lease) = resumed_lease {
            resumed_lease.commit();
        }
        #[cfg(any(windows, target_os = "macos"))]
        load_transaction
            .commit_reopened()
            .internal_err_ctx("Failed to reopen CodePro session access")?;
        self.closed_session_ids.lock().await.remove(&session_id_str);
        self.schedule_idle_compaction(&session_id_str).await;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_duplicate_identity_isolates_records_without_rewriting_sources() {
        let duplicate = "chatcmpl-reused";
        let original = vec![
            Message::user().with_id("user-source").with_text("request"),
            Message::assistant()
                .with_id(duplicate)
                .with_text("first answer"),
            Message::user()
                .with_id("user-next")
                .with_text("next request"),
            Message::assistant()
                .with_id(duplicate)
                .with_text("second answer"),
            // An upstream ID can also collide with a generated replay alias.
            Message::assistant()
                .with_id("replay-3-0-chatcmpl-reused")
                .with_text("third answer"),
        ];
        let stored = serde_json::to_value(&original).unwrap();
        let replay = replay_messages_with_unique_ids(original.clone());
        let ids = replay
            .iter()
            .filter_map(|m| m.id.as_ref())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), replay.len());
        assert_eq!(replay[0].id, original[0].id);
        assert_eq!(replay[1].id, original[1].id);
        assert_eq!(replay[4].id, original[4].id);
        assert_eq!(replay[3].as_concat_text(), "second answer");
        assert_eq!(serde_json::to_value(&original).unwrap(), stored);
        assert_eq!(
            serde_json::to_value(replay_messages_with_unique_ids(original)).unwrap(),
            serde_json::to_value(replay).unwrap()
        );
    }

    #[test]
    fn replay_identity_preserves_user_and_tool_call_identity() {
        let request = Message::assistant()
            .with_id("user-source")
            .with_tool_request(
                "call-original",
                Ok(rmcp::model::CallToolRequestParams::new("test")),
            );
        let messages = vec![
            request,
            Message::user().with_id("user-source").with_text("request"),
            Message::assistant().with_text("legacy record without an ID"),
        ];
        let content = serde_json::to_value(&messages[0].content).unwrap();
        let replay = replay_messages_with_unique_ids(messages);
        assert_ne!(replay[0].id.as_deref(), Some("user-source"));
        assert_eq!(replay[1].id.as_deref(), Some("user-source"));
        assert_eq!(replay[2].id, None);
        assert_eq!(serde_json::to_value(&replay[0].content).unwrap(), content);
    }

    #[test]
    fn replay_identity_keeps_consecutive_deltas_together() {
        let messages = vec![
            Message::assistant().with_id("reused").with_text("first "),
            Message::assistant().with_id("reused").with_text("answer"),
            Message::user().with_id("next-request").with_text("next"),
            Message::assistant().with_id("reused").with_text("second "),
            Message::assistant().with_id("reused").with_text("answer"),
        ];
        let replay = replay_messages_with_unique_ids(messages);
        assert_eq!(replay[0].id, replay[1].id);
        assert_eq!(replay[3].id, replay[4].id);
        assert_ne!(replay[0].id, replay[3].id);
        let mut grouped = crate::conversation::Conversation::empty();
        grouped.extend(replay);
        assert_eq!(grouped.len(), 3);
        assert_eq!(grouped.messages()[0].as_concat_text(), "first answer");
        assert_eq!(grouped.messages()[2].as_concat_text(), "second answer");
    }

    #[test]
    fn replay_identity_never_rewrites_terminal_or_retry_facts() {
        let terminal = Message::assistant()
            .with_id("terminal-original")
            .with_system_notification_with_data(
                SystemNotificationType::TurnTerminal,
                "done",
                serde_json::json!({
                    "terminal_message_id": "terminal-original",
                    "source_user_message_id": "user-original",
                    "retry_of_terminal_message_id": "previous-terminal",
                    "run_id": "run-original",
                    "evidence_ids": ["audit-original"],
                }),
            );
        let messages = vec![
            Message::assistant()
                .with_id("terminal-original")
                .with_text("upstream collision"),
            Message::user()
                .with_id("user-original")
                .with_text("request"),
            terminal.clone(),
        ];
        let replay = replay_messages_with_unique_ids(messages);
        assert_ne!(replay[0].id, terminal.id);
        assert_eq!(
            serde_json::to_value(&replay[2]).unwrap(),
            serde_json::to_value(terminal).unwrap()
        );
        assert_eq!(replay[1].id.as_deref(), Some("user-original"));
    }

    fn notification(notification_type: SystemNotificationType) -> SystemNotificationContent {
        SystemNotificationContent {
            notification_type,
            msg: "status".to_string(),
            data: None,
        }
    }

    #[test]
    fn replay_skips_transient_progress_notifications() {
        assert!(!should_replay_system_notification(&notification(
            SystemNotificationType::ProgressMessage
        )));
        assert!(!should_replay_system_notification(&notification(
            SystemNotificationType::ThinkingMessage
        )));
    }

    #[test]
    fn replay_keeps_structured_codepro_activity_progress() {
        let mut activity = notification(SystemNotificationType::ProgressMessage);
        activity.data = Some(serde_json::json!({
            "event_id": "thinking-session-intent",
            "event_type": "intent_completed",
        }));

        assert!(should_replay_system_notification(&activity));
    }

    #[test]
    fn replay_keeps_durable_notifications() {
        assert!(should_replay_system_notification(&notification(
            SystemNotificationType::InlineMessage
        )));
        assert!(should_replay_system_notification(&notification(
            SystemNotificationType::CreditsExhausted
        )));
        assert!(should_replay_system_notification(&notification(
            SystemNotificationType::TurnTerminal
        )));
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn acquire_resume_lease(
        workspace: &std::path::Path,
    ) -> workspace_lease::AcquireWorkspaceLeaseResponse {
        workspace_lease::acquire_workspace_lease(workspace_lease::AcquireWorkspaceLeaseRequest {
            requested_path: workspace.to_string_lossy().into_owned(),
            expected_state: workspace_lease::WorkspaceState::EmptyDirectory,
            expected_identity: if cfg!(windows) {
                workspace
                    .to_string_lossy()
                    .replace('/', "\\")
                    .to_lowercase()
            } else {
                workspace.to_string_lossy().into_owned()
            },
        })
        .unwrap()
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn resume_meta(lease_id: &str) -> Meta {
        serde_json::from_value(serde_json::json!({ "workspaceLeaseId": lease_id })).unwrap()
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn codepro_resume_consumes_and_binds_a_fresh_workspace_lease() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        #[cfg(target_os = "macos")]
        let workspace = workspace.canonicalize().unwrap();
        let acquired = acquire_resume_lease(&workspace);
        let meta = resume_meta(&acquired.lease_id);

        let resumed_lease = prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "resume-session",
            &workspace,
            &workspace,
            &Default::default(),
            Some(&meta),
        )
        .unwrap();

        assert_eq!(
            resumed_lease.as_ref().map(|lease| lease.lease_id.as_str()),
            Some(acquired.lease_id.as_str())
        );
        assert!(workspace_lease::session_has_workspace_lease("resume-session").unwrap());
        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "second-session",
            &workspace,
            &workspace,
            &Default::default(),
            Some(&meta),
        )
        .is_err());
        assert!(!workspace_lease::session_has_workspace_lease("second-session").unwrap());
        resumed_lease.unwrap().commit();
        workspace_lease::release_session_workspace_lease("resume-session").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn codepro_resume_without_a_live_or_fresh_lease_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();

        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "missing-lease-session",
            &workspace,
            &workspace,
            &Default::default(),
            None,
        )
        .is_err());
        assert!(!workspace_lease::session_has_workspace_lease("missing-lease-session").unwrap());
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn persisted_writable_binding_resumes_without_user_reconfirmation() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        #[cfg(target_os = "macos")]
        let workspace = workspace.canonicalize().unwrap();
        std::fs::write(workspace.join("README.md"), "bound project").unwrap();
        let mut extension_data = crate::session::extension_data::ExtensionData::default();
        crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::WritableProject {
            path: workspace.to_string_lossy().into_owned(),
            lease_id: "expired-process-local-lease".to_string(),
        }
        .to_extension_data(&mut extension_data)
        .unwrap();

        let resumed = prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "persisted-binding-session",
            &workspace,
            &workspace,
            &extension_data,
            None,
        )
        .unwrap()
        .expect("the persisted binding should be rebound automatically");

        assert_ne!(resumed.lease_id, "expired-process-local-lease");
        assert!(workspace_lease::session_has_workspace_lease("persisted-binding-session").unwrap());
        resumed.commit();
        workspace_lease::release_session_workspace_lease("persisted-binding-session").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn stale_persisted_lease_recovers_only_the_same_live_workspace() {
        use crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding;
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let other = temp.path().join("other");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&other).unwrap();
        let session_id = "stale-persisted-lease-recovery";
        let acquired = acquire_resume_lease(&workspace);
        let lease =
            workspace_lease::consume_workspace_lease(&acquired.lease_id, &workspace).unwrap();
        workspace_lease::bind_workspace_lease(session_id, lease).unwrap();
        let mut data = Default::default();
        CodeProWorkspaceBinding::WritableProject {
            path: workspace.to_string_lossy().into_owned(),
            lease_id: "previous-process-lease".into(),
        }
        .to_extension_data(&mut data)
        .unwrap();
        assert!(workspace_lease::validate_session_workspace_binding(
            session_id,
            &workspace,
            "previous-process-lease"
        )
        .unwrap_err()
        .to_string()
        .contains("authoritative session lease"));
        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            session_id,
            &workspace,
            &other,
            &data,
            None
        )
        .is_err());
        let prepared = prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            session_id,
            &workspace,
            &workspace,
            &data,
            None,
        )
        .unwrap()
        .expect("stale binding must be refreshed before the next dispatch");
        assert_eq!(prepared.lease_id, acquired.lease_id);
        assert!(!prepared.acquired_here);
        prepared.rollback().unwrap();
        workspace_lease::validate_session_workspace_binding(
            session_id,
            &workspace,
            &acquired.lease_id,
        )
        .unwrap();
        let prepared = prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            session_id,
            &workspace,
            &workspace,
            &data,
            None,
        )
        .unwrap()
        .unwrap();
        drop(prepared);
        workspace_lease::validate_session_workspace_binding(
            session_id,
            &workspace,
            &acquired.lease_id,
        )
        .unwrap();
        CodeProWorkspaceBinding::WritableProject {
            path: workspace.to_string_lossy().into_owned(),
            lease_id: acquired.lease_id.clone(),
        }
        .to_extension_data(&mut data)
        .unwrap();
        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            session_id,
            &workspace,
            &workspace,
            &data,
            None
        )
        .unwrap()
        .is_none());
        assert!(workspace_lease::validated_session_workspace_lease_id(session_id, &other).is_err());
        workspace_lease::release_session_workspace_lease(session_id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn failed_resume_transaction_rolls_back_a_fresh_created_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("created-workspace");
        let acquired = workspace_lease::acquire_workspace_lease(
            workspace_lease::AcquireWorkspaceLeaseRequest {
                requested_path: workspace.to_string_lossy().into_owned(),
                expected_state: workspace_lease::WorkspaceState::Missing,
                expected_identity: workspace
                    .to_string_lossy()
                    .replace('/', "\\")
                    .to_lowercase(),
            },
        )
        .unwrap();
        let prepared = prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "failed-resume-session",
            &workspace,
            &workspace,
            &Default::default(),
            Some(&resume_meta(&acquired.lease_id)),
        )
        .unwrap()
        .unwrap();

        drop(prepared);

        assert!(!workspace.exists());
        assert!(!workspace_lease::session_has_workspace_lease("failed-resume-session").unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn unbound_and_root_container_resume_without_turning_cwd_into_a_workspace() {
        for binding in [
            crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::Unbound,
            crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::RootContainer {
                path: "D:\\".to_string(),
            },
        ] {
            let mut extension_data = Default::default();
            binding.to_extension_data(&mut extension_data).unwrap();
            let cwd = match &binding {
                crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::Unbound => {
                    std::path::Path::new("C:\\Users\\tester")
                }
                _ => std::path::Path::new("D:\\"),
            };
            prepare_codepro_resume_workspace_lease(
                &SessionType::CodePro,
                "non-writable-session",
                cwd,
                cwd,
                &extension_data,
                None,
            )
            .unwrap();
            assert!(!workspace_lease::session_has_workspace_lease("non-writable-session").unwrap());
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn root_container_session_can_bind_an_allocated_child_without_creating_a_new_session() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .components()
            .take(2)
            .collect::<std::path::PathBuf>();
        let capability = workspace_lease::issue_root_capability(
            "root-session",
            "root-run",
            "root-message",
            Some(&root),
            workspace_lease::RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let acquired = workspace_lease::allocate_workspace_child(
            workspace_lease::AllocateWorkspaceChildRequest {
                container_path: root.to_string_lossy().into_owned(),
                suggested_name: format!(
                    "codepro-root-{}",
                    uuid::Uuid::new_v4()
                        .simple()
                        .to_string()
                        .chars()
                        .take(12)
                        .collect::<String>()
                ),
                capability,
            },
        )
        .unwrap();
        let child = std::path::PathBuf::from(&acquired.working_dir);
        let mut extension_data = Default::default();
        crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::RootContainer {
            path: root.to_string_lossy().into_owned(),
        }
        .to_extension_data(&mut extension_data)
        .unwrap();

        let prepared = prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "root-session",
            &root,
            &child,
            &extension_data,
            Some(&resume_meta(&acquired.lease_id)),
        )
        .expect("an allocated child must bind to the existing root-container session")
        .expect("the child lease must be consumed by the existing session");

        assert!(workspace_lease::session_has_workspace_lease("root-session").unwrap());
        prepared.rollback().unwrap();
        assert!(!child.exists());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn project_container_resume_requires_owned_child_and_never_leases_parent() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let mut data = crate::session::extension_data::ExtensionData::default();
        crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::ProjectContainer {
            path: parent.to_string_lossy().into_owned(),
        }
        .to_extension_data(&mut data)
        .unwrap();
        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            &session,
            &parent,
            &parent,
            &data,
            None
        )
        .unwrap()
        .is_none());
        assert!(!workspace_lease::session_has_workspace_lease(&session).unwrap());
        let child = parent.join("项目");
        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            &session,
            &parent,
            &child,
            &data,
            None
        )
        .is_err());
        let capability = workspace_lease::issue_root_capability(
            &session,
            "run",
            "message",
            Some(&parent),
            workspace_lease::RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let allocated = workspace_lease::allocate_workspace_child(
            workspace_lease::AllocateWorkspaceChildRequest {
                container_path: parent.to_string_lossy().into_owned(),
                suggested_name: "项目".into(),
                capability,
            },
        )
        .unwrap();
        let prepared = prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            &session,
            &parent,
            &child,
            &data,
            Some(&resume_meta(&allocated.lease_id)),
        )
        .unwrap()
        .unwrap();
        assert!(workspace_lease::validate_session_workspace_lease(&session, &parent).is_err());
        assert!(workspace_lease::validate_session_workspace_lease(&session, &child).is_ok());
        prepared.rollback().unwrap();
        assert!(!child.exists());
    }

    #[cfg(windows)]
    #[test]
    fn malformed_workspace_binding_rejects_before_consuming_a_fresh_lease() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let acquired = acquire_resume_lease(&workspace);
        let meta = resume_meta(&acquired.lease_id);
        let mut extension_data = crate::session::extension_data::ExtensionData::default();
        extension_data.set_extension_state(
            crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::EXTENSION_NAME,
            crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding::VERSION,
            serde_json::json!({ "kind": "writable_project", "path": "D:\\" }),
        );

        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "invalid-binding-session",
            &workspace,
            &workspace,
            &extension_data,
            Some(&meta),
        )
        .is_err());
        workspace_lease::release_workspace_lease(&acquired.lease_id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn codepro_resume_cwd_mismatch_consumes_token_without_binding_session() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let changed = temp.path().join("changed");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&changed).unwrap();
        let acquired = acquire_resume_lease(&workspace);
        let meta = resume_meta(&acquired.lease_id);

        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "mismatch-session",
            &workspace,
            &changed,
            &Default::default(),
            Some(&meta),
        )
        .is_err());
        assert!(!workspace_lease::session_has_workspace_lease("mismatch-session").unwrap());
        assert!(prepare_codepro_resume_workspace_lease(
            &SessionType::CodePro,
            "mismatch-retry-session",
            &workspace,
            &workspace,
            &Default::default(),
            Some(&meta),
        )
        .is_err());
    }
}
