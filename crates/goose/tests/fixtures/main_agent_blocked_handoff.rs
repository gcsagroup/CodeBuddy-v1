// Regression for 20261007_2 / tser5vss: missing real input is a normal
// handoff, not a second host-authored interruption after the answer.
struct BlockedHandoffProvider {
    calls: std::sync::atomic::AtomicUsize,
    summary: String,
    legacy_finish_first: bool,
    exhaust_budget: bool,
    followup_before_pause: bool,
    answer_chunk_seen: Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl crate::providers::base::Provider for BlockedHandoffProvider {
    async fn stream(
        &self,
        _config: &goose_providers::model::ModelConfig,
        prompt: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.exhaust_budget {
            assert!(call < 3, "the exhausted budget must stop further provider calls");
            assert_eq!(tools.is_empty(), call == 2);
            // Adversarial provider ignores the tool surface. The last rejection
            // must not overwrite the budget reason with a third-failure reason.
            return Ok(stream_from_single_message(
                Message::assistant().with_tool_request(format!("unoffered-{call}"),
                    Ok(CallToolRequestParams::new("unoffered_fixture_tool"))),
                ProviderUsage::new("fixture".into(), Usage::default()),
            ));
        }
        if self.legacy_finish_first && call == 0 {
            return Ok(stream_from_single_message(
                Message::assistant().with_text("还没有真实订单文件，不能完成核对。"),
                ProviderUsage::new("fixture".into(), Usage::default()),
            ));
        }
        if call == 1 + usize::from(self.legacy_finish_first) + usize::from(self.followup_before_pause) {
            assert!(tools.is_empty(), "a committed pause cannot dispatch more work");
            let facts = prompt.split("# Committed run facts (not a user message)\n")
                .nth(1).expect("final answer needs the actual committed outcome")
                .lines().next().unwrap();
            let facts: serde_json::Value = serde_json::from_str(facts).expect("structured terminal facts");
            assert_eq!(facts["state"], "paused");
            assert_eq!(facts["completed"], false);
            assert!(facts["event_sequence"].as_u64().unwrap() > 0);
            let split = self.summary.char_indices().nth(12).unwrap().0;
            let first = self.summary[..split].to_string();
            let rest = self.summary[split..].to_string();
            let seen = self.answer_chunk_seen.clone();
            return Ok(Box::pin(async_stream::stream! {
                yield Ok((Some(Message::assistant().with_id("handoff-answer").with_text(first)), None));
                tokio::time::timeout(std::time::Duration::from_secs(3), seen.notified()).await
                    .expect("first answer chunk must reach the consumer before generation finishes");
                yield Ok((Some(Message::assistant().with_id("handoff-answer").with_text(rest)),
                    Some(ProviderUsage::new("fixture".into(), Usage::default()))));
            }));
        }
        assert_eq!(call, usize::from(self.legacy_finish_first) + usize::from(self.followup_before_pause && call > 0),
            "the answer must not reopen an execution/verification loop");
        if self.followup_before_pause && call == 1 {
            assert!(!tools.is_empty());
            assert!(messages.iter().any(|message| message.id.as_deref() == Some("accepted-before-pause")
                && message.as_concat_text().contains("暂不补文件")), "accepted input must reach the model before closing");
        }
        if self.legacy_finish_first {
            let feedback = prompt
                .split("# Previous host completion check (not a user message)\n\n")
                .nth(1)
                .expect("the model needs the actual rejection facts, not silence");
            let feedback: serde_json::Value =
                serde_json::from_str(feedback.trim()).expect("completion facts must be structured");
            assert_eq!(feedback["completion_accepted"], false);
            assert!(!feedback["gaps"].as_array().unwrap().is_empty());
            // MOIM adds the typed turn-context block (time/workdir/budget) to
            // the real user message. Exclude that existing transport context,
            // but require every remaining user text block to be the real input.
            let user_text = messages
                .iter()
                .filter(|message| message.role == Role::User)
                .flat_map(|message| &message.content)
                .filter_map(|content| match content {
                    MessageContent::Text(text)
                        if !crate::conversation::is_turn_context_text(&text.text) =>
                    {
                        Some(text.text.as_str())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(
                user_text,
                vec!["核对真实订单；缺文件就明确交接，不要说全部完成。"],
                "completion feedback must not manufacture a user instruction"
            );
        }
        Ok(stream_from_single_message(
            Message::assistant().with_tool_request(
                format!("missing-input-handoff-{call}"),
                Ok(
                    CallToolRequestParams::new(super::super::main_agent_contract::TOOL_NAME)
                        .with_arguments(
                            serde_json::json!({
                                "operation": "report_blocked", "summary": "Internal handoff draft; not the final user answer.",
                            })
                            .as_object()
                            .unwrap()
                            .clone(),
                        ),
                ),
            ),
            ProviderUsage::new("fixture".into(), Usage::default()),
        ))
    }

    fn get_name(&self) -> &str {
        "blocked-handoff-fixture"
    }
}

#[tokio::test]
async fn blocked_handoff_publishes_one_answer_after_pause_without_completing_requirements(
) -> Result<()> {
    run_blocked_handoff_regression(false, false, false).await
}

#[tokio::test]
async fn legacy_completion_rejection_is_context_not_a_fabricated_user_instruction() -> Result<()> {
    run_blocked_handoff_regression(true, false, false).await
}

#[tokio::test]
async fn budget_handoff_preserves_withdrawal_cause_and_publishes_one_answer() -> Result<()> {
    run_blocked_handoff_regression(false, true, false).await
}

#[tokio::test]
async fn blocked_handoff_consumes_input_accepted_before_pause() -> Result<()> {
    run_blocked_handoff_regression(false, false, true).await
}

async fn run_blocked_handoff_regression(legacy_finish_first: bool, exhaust_budget: bool, followup_before_pause: bool) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let manager = Arc::new(SessionManager::new(temp.path().join("sessions")));
    let runtime = CodeProRuntime::initialize_production(
        temp.path().join("runtime"),
        crate::agents::control_plane::RuntimeModePolicy::parse(Some("durable")),
    )
    .await?;
    let mut session = manager
        .create_session(
            temp.path().to_path_buf(),
            "missing input handoff".into(),
            SessionType::CodePro,
            GooseMode::Auto,
        )
        .await?;
    bind_test_workspace(&manager, &mut session).await?;
    let agent = Agent::with_config(
        AgentConfig::new(
            manager.clone(),
            Arc::new(PermissionManager::new(temp.path().join("permissions"))),
            None,
            GooseMode::Auto,
            true,
            GoosePlatform::GooseCli,
        )
        .with_codepro_runtime(runtime.clone())
        .with_codepro_event_log_root(temp.path().join("stream-events")),
    );
    let run_id = RunId::new("missing-input-run")?;
    runtime
        .create_or_verify_run(&session.id, run_id.clone(), "核对真实订单，不编造数据")
        .await?;
    runtime.control(&session.id, ControlCommand::CommitUserRequirements {
        run_id: run_id.clone(), revision: 1,
        requirements: vec![serde_json::from_value(serde_json::json!({
            "requirement_id":"verify-real-orders", "source_message_id":"user",
            "semantics":{"content":"使用真实订单实跑核对", "expected_effect":"observation", "target_resources":[]}
        }))?],
    }, None).await?;
    let requirements = runtime
        .snapshot(&session.id, &run_id)
        .await?
        .projection
        .user_requirements;
    let summary = if exhaust_budget { TOOL_TASK_PAUSED_MESSAGE } else {
        "缺少 data/真实订单.csv，因此没有完成实跑核对，也没有编造数据。补齐文件后可以继续。"
    };
    let provider = Arc::new(BlockedHandoffProvider {
        calls: std::sync::atomic::AtomicUsize::new(0),
        summary: summary.into(),
        legacy_finish_first,
        exhaust_budget,
        followup_before_pause,
        answer_chunk_seen: Arc::new(tokio::sync::Notify::new()),
    });
    agent
        .update_provider(
            provider.clone(),
            goose_providers::model::ModelConfig::new("fixture"),
            &session.id,
        )
        .await?;
    let scope = CodeProTaskScope::new_bound(
        run_id.as_str(),
        "main-agent",
        temp.path().canonicalize()?,
        vec!["**".into()],
        Vec::new(),
    )
    .and_then(|scope| scope.with_permission_session_id(&session.id))
    .map_err(anyhow::Error::msg)?;
    let mut options = UnifiedExecutorOptions::codepro_main_agent(CodeProTaskKind::ToolAction)
        .with_main_agent_control_run(run_id.clone())?;
    options.permission_scope = Some(scope);
    if exhaust_budget {
        let config = options.action_budget_config.as_mut().unwrap();
        config.current_limit_turns = 3;
        config.hard_limit_turns = 3;
        config.extension_turns = 0;
        config.finalization_reserve_turns = 1;
    }
    let mut events = agent
        .reply_codepro_unified(
            &session,
            Message::user()
                .with_id("user")
                .with_text("核对真实订单；缺文件就明确交接，不要说全部完成。"),
            SessionConfig {
                id: session.id.clone(),
                schedule_id: None,
                max_turns: Some(10),
                retry_config: None,
            },
            None,
            options,
        )
        .await?;
    let mut boundary_seen = false;
    let mut visible_answers = Vec::new();
    let mut terminals = 0;
    let mut followup_sent = false;
    while let Some(event) =
        tokio::time::timeout(std::time::Duration::from_secs(20), events.next()).await?
    {
        if let AgentEvent::Message(message) = event? {
            for content in &message.content {
                if followup_before_pause && !followup_sent && matches!(content,
                    MessageContent::ToolResponse(response) if response.id == "missing-input-handoff-0") {
                    agent.steer_codepro_run(&session.id, run_id.as_str(),
                        Message::user().with_id("accepted-before-pause").with_text("暂不补文件，请说明哪些内容还没核对。")).await?;
                    followup_sent = true;
                }
                if let MessageContent::SystemNotification(notification) = content {
                    if notification
                        .data
                        .as_ref()
                        .is_some_and(|data| data["type"] == "codepro_response_phase")
                    {
                        assert_eq!(
                            runtime
                                .snapshot(&session.id, &run_id)
                                .await?
                                .projection
                                .state,
                            RunState::Paused
                        );
                        boundary_seen = true;
                    }
                    if notification.notification_type == SystemNotificationType::TurnTerminal {
                        let persisted = manager.get_session(&session.id, false).await?;
                        let state = persisted.extension_data
                            .get_extension_state("codepro_unified_turn", "v1")
                            .expect("persisted turn state at the terminal boundary");
                        assert_eq!(state["status"], "paused",
                            "ACP may stop polling on TurnTerminal; persist the compatibility state first");
                        terminals += 1;
                        assert_eq!(notification.data.as_ref().unwrap()["status"], "interrupted");
                        if exhaust_budget {
                            assert_eq!(message.as_concat_text(), summary);
                        } else {
                            assert!(message.as_concat_text().is_empty(), "terminal must not replay the streamed answer");
                            assert_eq!(notification.data.as_ref().unwrap()["visible_text_available"], true);
                        }
                    }
                }
            }
            if message.metadata.user_visible
                && !message.as_concat_text().trim().is_empty()
                && boundary_seen
            {
                if !exhaust_budget {
                    assert!(agent.steer_codepro_run(&session.id, run_id.as_str(),
                        Message::user().with_text("下一轮再补充条件")).await.is_err(),
                        "paused answer must not accept input into an execution loop that will not consume it");
                    assert!(!agent.has_pending_steers(&session.id).await);
                }
                provider.answer_chunk_seen.notify_one();
                visible_answers.push(message.as_concat_text());
            }
        }
    }
    assert_eq!(visible_answers.concat(), summary);
    if !exhaust_budget {
        assert!(visible_answers.len() >= 2, "handoff should stream, not replay a buffered draft");
    }
    assert_eq!(terminals, 1);
    assert_eq!(
        provider.calls.load(Ordering::SeqCst),
        if exhaust_budget { 3 } else { 2 + usize::from(legacy_finish_first) + usize::from(followup_before_pause) }
    );
    let after = runtime.snapshot(&session.id, &run_id).await?;
    assert_eq!(after.projection.state, RunState::Paused);
    if exhaust_budget {
        assert!(after.events.iter().any(|event| matches!(&event.payload,
            crate::agents::protocol::RunEventPayload::RunPaused { reason, .. }
                if reason == "action_budget_boundary")));
    }
    assert_eq!(
        serde_json::to_value(after.projection.user_requirements)?,
        serde_json::to_value(requirements)?
    );
    let saved = manager.get_session(&session.id, true).await?;
    let answers = saved
        .conversation
        .as_ref()
        .unwrap()
        .messages()
        .iter()
        .filter(|message| message.metadata.user_visible && message.role == Role::Assistant)
        .filter(|message| !message.as_concat_text().trim().is_empty())
        .filter(|message| !legacy_finish_first || message.as_concat_text().contains(summary))
        .map(Message::as_concat_text)
        .collect::<Vec<_>>();
    assert_eq!(
        answers,
        vec![summary],
        "reload must preserve the same single answer"
    );
    Ok(())
}
