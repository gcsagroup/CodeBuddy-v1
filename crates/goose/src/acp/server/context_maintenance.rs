//! Idle context maintenance shares the prompt admission boundary. It never starts
//! a task or sends an artificial user instruction to the agent.
use super::*;

impl GooseAcpAgent {
    pub(super) async fn context_maintenance_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        self.context_maintenance_locks
            .lock()
            .await
            .entry(session_id.to_string())
            .or_default()
            .clone()
    }

    pub(super) async fn publish_context_usage(
        &self,
        cx: &ConnectionTo<Client>,
        session_id: &str,
    ) -> Result<(), agent_client_protocol::Error> {
        publish_usage(
            &self.session_manager,
            cx,
            session_id,
            self.supports_goose_custom_notifications(),
        )
        .await
        .internal_err_ctx("Failed to publish current context usage")
    }

    pub(super) async fn schedule_idle_compaction(&self, session_id: &str) {
        let Some(cx) = self.client_cx.get().cloned() else {
            return;
        };
        let Some(agent) = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|s| s.agent.clone())
        else {
            return;
        };
        let lock = self.context_maintenance_lock(session_id).await;
        // Multiple threshold/save/load/turn-end events coalesce into one operation.
        let Ok(guard) = lock.try_lock_owned() else {
            return;
        };
        let token = CancellationToken::new();
        let operation_id = format!("compaction-{}", Uuid::new_v4());
        {
            let mut active = self.active_prompt_runs.lock().await;
            if active.contains_key(session_id)
                || self.closed_session_ids.lock().await.contains(session_id)
            {
                return;
            }
            active.insert(
                session_id.to_string(),
                ActivePromptRun {
                    run_id: operation_id.clone(),
                    cancel_token: token.clone(),
                    stop_reason: ActivePromptStopReason::None,
                    durable_execution_bound: false,
                },
            );
        }
        let manager = self.session_manager.clone();
        let active = self.active_prompt_runs.clone();
        let session_id = session_id.to_string();
        let custom = self.supports_goose_custom_notifications();
        tokio::spawn(async move {
            let _guard = guard;
            let result = compact_idle(
                &agent,
                &manager,
                &cx,
                &session_id,
                &operation_id,
                &token,
                custom,
            )
            .await;
            if let Err(error) = result {
                tracing::warn!(%session_id, %error, "Idle context maintenance failed; task state retained");
            }
            let mut active = active.lock().await;
            take_active_run_stop_reason(&mut active, &session_id, &operation_id);
        });
    }
}

async fn publish_usage(
    manager: &SessionManager,
    cx: &ConnectionTo<Client>,
    session_id: &str,
    custom: bool,
) -> anyhow::Result<()> {
    let session = manager.get_session(session_id, false).await?;
    let totals = manager.get_session_usage_totals(session_id).await?;
    if let Some(updates) = build_usage_updates(&session, &totals) {
        if custom {
            cx.send_notification(updates.custom)?;
        }
        cx.send_notification(SessionNotification::new(
            SessionId::new(session_id.to_string()),
            SessionUpdate::UsageUpdate(updates.standard),
        ))?;
    }
    Ok(())
}

async fn lifecycle(
    manager: &SessionManager,
    cx: &ConnectionTo<Client>,
    session_id: &str,
    operation: (&str, &str),
    status: &str,
    error: Option<&str>,
    custom: bool,
) -> anyhow::Result<()> {
    let (operation_id, started) = operation;
    let mut message = crate::agents::compaction_lifecycle_message(
        operation_id,
        started,
        status,
        "auto",
        None,
        error,
    );
    // An idle summary does not execute or resume a completed task.
    if status == "completed" {
        for content in &mut message.content {
            if let MessageContent::SystemNotification(notification) = content {
                notification.msg = "对话上下文整理完成。".to_string();
            }
        }
    }
    manager.add_message(session_id, &message).await?;
    if custom {
        for content in &message.content {
            if let MessageContent::SystemNotification(notification) = content {
                if let Some(status) = status_message_from_system_notification(notification) {
                    cx.send_notification(GooseSessionNotification {
                        session_id: session_id.to_string(),
                        update: GooseSessionUpdate::StatusMessage(StatusMessageUpdate { status }),
                    })?;
                }
            }
        }
    }
    Ok(())
}

async fn compact_idle(
    agent: &Agent,
    manager: &SessionManager,
    cx: &ConnectionTo<Client>,
    session_id: &str,
    operation_id: &str,
    token: &CancellationToken,
    custom: bool,
) -> anyhow::Result<()> {
    #[cfg(any(windows, target_os = "macos"))]
    let _access = {
        let _lifecycle = workspace_lease::lock_session_lifecycle(session_id).await?;
        workspace_lease::acquire_session_access(session_id)?
    };
    let session = manager.get_session(session_id, true).await?;
    let Some(conversation) = session.conversation.as_ref() else {
        return Ok(());
    };
    if conversation.agent_visible_messages().is_empty() || token.is_cancelled() {
        return Ok(());
    }
    let provider = agent.provider().await?;
    if !crate::context_mgmt::check_if_compaction_needed(
        provider.as_ref(),
        conversation,
        None,
        &session,
    )
    .await?
    {
        return Ok(());
    }
    let config = session
        .model_config
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Missing session model configuration"))?;
    let started = chrono::Utc::now().to_rfc3339();
    lifecycle(
        manager,
        cx,
        session_id,
        (operation_id, &started),
        "started",
        None,
        custom,
    )
    .await?;
    let result = tokio::select! {
        biased;
        _ = token.cancelled() => {
            lifecycle(manager, cx, session_id, (operation_id, &started), "cancelled", None, custom).await?;
            return Ok(());
        }
        result = crate::context_mgmt::compact_messages(provider.as_ref(), config, session_id, conversation, false) => result,
    };
    let committed = async {
        let (compacted, usage) = result?;
        let before = crate::context_mgmt::visible_context_tokens(conversation).await?;
        let after = crate::context_mgmt::visible_context_tokens(&compacted).await?;
        anyhow::ensure!(
            after < before,
            "Compaction did not reduce the context; original history retained"
        );
        // Cancellation stops provider work; do not interrupt the history/usage commit.
        anyhow::ensure!(!token.is_cancelled(), "Compaction cancelled before commit");
        manager.replace_conversation(session_id, &compacted).await?;
        agent
            .update_session_metrics(session_id, session.schedule_id, &usage, true)
            .await?;
        publish_usage(manager, cx, session_id, custom).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    match committed {
        Ok(()) => {
            lifecycle(
                manager,
                cx,
                session_id,
                (operation_id, &started),
                "completed",
                None,
                custom,
            )
            .await
        }
        Err(error) => {
            lifecycle(
                manager,
                cx,
                session_id,
                (operation_id, &started),
                "failed",
                Some(&error.to_string()),
                custom,
            )
            .await?;
            Err(error)
        }
    }
}
