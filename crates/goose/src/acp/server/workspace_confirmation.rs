use super::*;

pub(super) const REFRESH_METHOD: &str = "_goose/unstable/workspace/confirmation/v1/refresh";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefreshRequest {
    session_id: String,
    run_id: String,
    source_message_id: String,
}

impl GooseAcpAgent {
    pub(super) async fn refresh_workspace_confirmation(
        &self,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, agent_client_protocol::Error> {
        if self.client_workspace_confirmation_refresh.get() != Some(&true) {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("Negotiate workspaceConfirmationRefresh version 1 first"));
        }
        let request: RefreshRequest = serde_json::from_value(params).invalid_params_err()?;
        let _lifecycle = workspace_lease::lock_session_lifecycle(&request.session_id)
            .await
            .internal_err()?;
        // A rejected refresh must not reopen a barrier committed by close/archive.
        // The lifecycle lock keeps it stable until our own transaction takes over.
        drop(workspace_lease::acquire_session_access(&request.session_id).invalid_params_err()?);
        let transaction = workspace_lease::begin_session_lifecycle_transaction(&request.session_id)
            .internal_err()?;
        transaction.wait_for_idle().await.internal_err()?;
        let session = self
            .session_manager
            .get_session(&request.session_id, true)
            .await
            .invalid_params_err()?;
        if session.session_type != SessionType::CodePro
            || session.archived_at.is_some()
            || self
                .closed_session_ids
                .lock()
                .await
                .contains(&request.session_id)
        {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("Confirmation requires an open CodePro session"));
        }
        let binding = CodeProWorkspaceBinding::from_extension_data_strict(&session.extension_data)
            .invalid_params_err()?;
        let root = match binding {
            Some(CodeProWorkspaceBinding::Unbound) => None,
            #[cfg(windows)]
            Some(CodeProWorkspaceBinding::RootContainer { path }) => Some(path),
            #[cfg(target_os = "macos")]
            Some(CodeProWorkspaceBinding::ProjectContainer { path }) => Some(path),
            #[cfg(target_os = "macos")]
            Some(CodeProWorkspaceBinding::RootContainer { .. }) => None,
            _ => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("This workspace no longer requires project confirmation"))
            }
        };
        self.codepro_control
            .validate_workspace_confirmation_run(
                &request.session_id,
                &session.working_dir,
                &request.run_id,
                &request.source_message_id,
            )
            .await
            .map_err(codepro_control::acp_error)?;
        let messages = session
            .conversation
            .as_ref()
            .map(|c| c.messages().as_slice())
            .unwrap_or(&[]);
        let source_index = messages
            .iter()
            .position(|message| {
                message.role == Role::User
                    && message.id.as_deref() == Some(&request.source_message_id)
                    && message.metadata.task_run_id.as_deref() == Some(&request.run_id)
            })
            .ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data("Original task message is missing")
            })?;
        if messages
            .iter()
            .rev()
            .filter(|m| m.role == Role::User)
            .find_map(|m| m.metadata.task_run_id.as_deref())
            != Some(request.run_id.as_str())
        {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("A different task superseded this confirmation"));
        }
        let event_name = if cfg!(target_os = "macos") {
            "codepro.needs_project_workspace_v1"
        } else {
            "codepro.needs_workspace"
        };
        // Only a persisted host notification can establish the waiting operation.
        // Client paths, suggested names and old nonces are not refreshed as authority.
        let mut confirmation = messages[source_index + 1..]
            .iter()
            .rev()
            .filter(|message| message.role == Role::Assistant)
            .flat_map(|message| message.content.iter().rev())
            .find_map(|content| match content {
                MessageContent::SystemNotification(notification)
                    if notification.notification_type == SystemNotificationType::InlineMessage =>
                {
                    let data = notification.data.as_ref()?;
                    let context: workspace_lease::RootCapabilityContext =
                        serde_json::from_value(data.get("capability")?.clone()).ok()?;
                    (data.get("event")?.as_str()? == event_name
                        && context.session_id == request.session_id
                        && context.run_id == request.run_id
                        && context.source_message_id == request.source_message_id)
                        .then(|| data.clone())
                }
                _ => None,
            })
            .ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data("No persisted workspace confirmation matches this task")
            })?;
        let capability = workspace_lease::refresh_workspace_capability(
            &request.session_id,
            &request.run_id,
            &request.source_message_id,
            root.as_deref().map(Path::new),
        )
        .invalid_params_err()?;
        confirmation["capability"] = serde_json::to_value(capability).internal_err()?;
        confirmation["rootContainerPath"] = serde_json::to_value(root).internal_err()?;
        transaction.commit_reopened().internal_err()?;
        Ok(confirmation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (tempfile::TempDir, GooseAcpAgent, Session, serde_json::Value) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let scheduler_sessions = Arc::new(SessionManager::new(root.join("scheduler-sessions")));
        let scheduler =
            crate::scheduler::Scheduler::new(root.join("scheduler"), scheduler_sessions)
                .await
                .unwrap();
        let provider_factory: AcpProviderFactory = Arc::new(|_, _, _| {
            Box::pin(async { panic!("refresh must never access a model provider") })
        });
        let agent = GooseAcpAgent::new(GooseAcpAgentOptions {
            provider_factory,
            builtins: Vec::new(),
            data_dir: root.join("data"),
            config_dir: root.join("config"),
            disable_session_naming: true,
            goose_platform: GoosePlatform::GooseCli,
            additional_source_roots: Vec::new(),
            scheduler,
        })
        .await
        .unwrap();
        let parent = root.join("中文 父目录");
        std::fs::create_dir(&parent).unwrap();
        std::fs::write(parent.join("preserve.txt"), "unchanged").unwrap();
        let session = agent
            .session_manager
            .create_session(
                parent.clone(),
                "refresh".into(),
                SessionType::CodePro,
                GooseMode::default(),
            )
            .await
            .unwrap();
        workspace_lease::reopen_session_access(&session.id).unwrap();
        let mut data = session.extension_data.clone();
        CodeProWorkspaceBinding::Unbound
            .to_extension_data(&mut data)
            .unwrap();
        agent
            .session_manager
            .update(&session.id)
            .extension_data(data)
            .apply()
            .await
            .unwrap();
        let run = format!("run-{}", Uuid::new_v4());
        let mut source = Message::user()
            .with_text("Create the project")
            .with_generated_id();
        source.metadata.task_run_id = Some(run.clone());
        let source_id = source.id.as_deref().unwrap();
        agent
            .codepro_control
            .register_prompt_run_with_source(
                &session.id,
                &run,
                "Create the project",
                Some(source_id),
                Some(&parent),
            )
            .await
            .unwrap();
        agent
            .session_manager
            .add_message(&session.id, &source)
            .await
            .unwrap();
        let capability = workspace_lease::issue_root_capability(
            &session.id,
            &run,
            source_id,
            None,
            workspace_lease::RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let event = serde_json::json!({
            "event": if cfg!(target_os = "macos") { "codepro.needs_project_workspace_v1" } else { "codepro.needs_workspace" },
            "rootContainerPath": null, "suggestedChildName": "中文项目", "writableRoot": null, "capability": capability,
        });
        agent
            .session_manager
            .add_message(
                &session.id,
                &Message::assistant()
                    .with_system_notification_with_data(
                        SystemNotificationType::InlineMessage,
                        "waiting",
                        event.clone(),
                    )
                    .with_generated_id(),
            )
            .await
            .unwrap();
        (temp, agent, session, event)
    }

    fn request(event: &serde_json::Value) -> serde_json::Value {
        let c = &event["capability"];
        serde_json::json!({"sessionId":c["sessionId"], "runId":c["runId"], "sourceMessageId":c["sourceMessageId"]})
    }

    #[tokio::test]
    async fn refresh_workspace_confirmation_preserves_task_and_waits_for_explicit_confirmation() {
        let (_temp, agent, session, event) = fixture().await;
        let params = request(&event);
        assert!(agent
            .dispatch_custom_request(REFRESH_METHOD, params.clone())
            .await
            .is_err());
        agent
            .client_workspace_confirmation_refresh
            .set(true)
            .unwrap();
        let old: workspace_lease::RootCapabilityContext =
            serde_json::from_value(event["capability"].clone()).unwrap();
        workspace_lease::expire_confirmation_for_test(&old);
        let before = agent
            .codepro_control
            .runtime()
            .snapshot(
                &session.id,
                &crate::agents::protocol::RunId::new(old.run_id.clone()).unwrap(),
            )
            .await
            .unwrap();
        // A prompt/load holding the common access permit must finish first.
        let permit = workspace_lease::acquire_session_access(&session.id).unwrap();
        let refresh = agent.dispatch_custom_request(REFRESH_METHOD, params.clone());
        tokio::pin!(refresh);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), &mut refresh)
                .await
                .is_err()
        );
        drop(permit);
        let first = refresh.await.unwrap();
        assert_ne!(first["capability"]["nonce"], event["capability"]["nonce"]);
        assert_eq!(request(&first), params);
        let (second, third) = tokio::join!(
            agent.dispatch_custom_request(REFRESH_METHOD, params.clone()),
            agent.dispatch_custom_request(REFRESH_METHOD, params.clone())
        );
        assert_eq!(second.unwrap(), first);
        assert_eq!(third.unwrap(), first);
        let after = agent
            .codepro_control
            .runtime()
            .snapshot(
                &session.id,
                &crate::agents::protocol::RunId::new(old.run_id.clone()).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(before.projection, after.projection);
        let saved = agent
            .session_manager
            .get_session(&session.id, true)
            .await
            .unwrap();
        assert_eq!(saved.conversation.unwrap().messages().len(), 2);
        assert!(matches!(
            CodeProWorkspaceBinding::from_extension_data(&saved.extension_data),
            Some(CodeProWorkspaceBinding::Unbound)
        ));
        assert_eq!(std::fs::read_dir(&session.working_dir).unwrap().count(), 1);
        assert_eq!(
            std::fs::read_to_string(session.working_dir.join("preserve.txt")).unwrap(),
            "unchanged"
        );
        #[cfg(target_os = "macos")]
        {
            let request = |capability| workspace_lease::AllocateWorkspaceChildRequest {
                container_path: session.working_dir.to_string_lossy().into_owned(),
                suggested_name: "中文项目".into(),
                capability,
            };
            assert!(workspace_lease::allocate_workspace_child(request(old)).is_err());
            assert!(!session.working_dir.join("中文项目").exists());
            let lease = workspace_lease::allocate_workspace_child(request(
                serde_json::from_value(first["capability"].clone()).unwrap(),
            ))
            .unwrap();
            assert!(session.working_dir.join("中文项目").is_dir());
            assert!(agent
                .dispatch_custom_request(REFRESH_METHOD, params)
                .await
                .is_err());
            workspace_lease::release_workspace_lease(&lease.lease_id).unwrap();
        }
    }

    #[tokio::test]
    async fn refresh_workspace_confirmation_rejects_forged_bound_archived_closed_and_terminal_tasks(
    ) {
        let (_temp, agent, session, event) = fixture().await;
        agent
            .client_workspace_confirmation_refresh
            .set(true)
            .unwrap();
        let params = request(&event);
        for field in ["sessionId", "runId", "sourceMessageId"] {
            let mut forged = params.clone();
            forged[field] = serde_json::json!("different");
            assert!(agent
                .dispatch_custom_request(REFRESH_METHOD, forged)
                .await
                .is_err());
        }
        agent
            .session_manager
            .update(&session.id)
            .archived_at(Some(chrono::Utc::now()))
            .apply()
            .await
            .unwrap();
        assert!(agent
            .dispatch_custom_request(REFRESH_METHOD, params.clone())
            .await
            .is_err());
        agent
            .session_manager
            .update(&session.id)
            .archived_at(None)
            .apply()
            .await
            .unwrap();
        agent
            .closed_session_ids
            .lock()
            .await
            .insert(session.id.clone());
        let closed_barrier = workspace_lease::begin_session_close(&session.id).unwrap();
        assert!(agent
            .dispatch_custom_request(REFRESH_METHOD, params.clone())
            .await
            .is_err());
        assert!(workspace_lease::acquire_session_access(&session.id).is_err());
        #[cfg(target_os = "macos")]
        {
            agent.client_project_containers.set(true).unwrap();
            assert!(agent.dispatch_custom_request(
                workspace_lease::ALLOCATE_PROJECT_CHILD_METHOD,
                serde_json::json!({"containerPath":session.working_dir,"suggestedName":"中文项目","capability":event["capability"]}),
            ).await.is_err());
            assert!(workspace_lease::acquire_session_access(&session.id).is_err());
        }
        drop(closed_barrier);
        workspace_lease::reopen_session_access(&session.id).unwrap();
        agent.closed_session_ids.lock().await.remove(&session.id);
        let saved = agent
            .session_manager
            .get_session(&session.id, false)
            .await
            .unwrap();
        let mut bound = saved.extension_data.clone();
        CodeProWorkspaceBinding::WritableProject {
            path: session.working_dir.to_string_lossy().into_owned(),
            lease_id: "bound-fixture".into(),
        }
        .to_extension_data(&mut bound)
        .unwrap();
        agent
            .session_manager
            .update(&session.id)
            .extension_data(bound)
            .apply()
            .await
            .unwrap();
        assert!(agent
            .dispatch_custom_request(REFRESH_METHOD, params.clone())
            .await
            .is_err());
        agent
            .session_manager
            .update(&session.id)
            .extension_data(saved.extension_data)
            .apply()
            .await
            .unwrap();
        agent
            .codepro_control
            .cancel_prompt_run(&session.id, params["runId"].as_str().unwrap())
            .await
            .unwrap();
        assert!(agent
            .dispatch_custom_request(REFRESH_METHOD, params)
            .await
            .is_err());
        assert_eq!(std::fs::read_dir(&session.working_dir).unwrap().count(), 1);
    }
}
