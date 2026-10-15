use super::*;
use crate::session::session_manager::SessionType;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct NoToolProvider {
    calls: AtomicUsize,
    semantic_response: Option<String>,
}

#[async_trait::async_trait]
impl crate::providers::base::Provider for NoToolProvider {
    async fn stream(
        &self,
        _config: &goose_providers::model::ModelConfig,
        prompt: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<crate::providers::base::MessageStream, ProviderError> {
        assert!(!prompt.contains("routing_evidence"));
        assert!(!messages
            .iter()
            .any(|message| message.as_concat_text().contains("Routing evidence")));
        self.calls.fetch_add(1, Ordering::SeqCst);
        let text = if prompt.contains("semantic intent router") {
            assert!(tools.is_empty());
            self.semantic_response.clone().unwrap_or_else(|| {
                r#"{"intent":"conversation","direct_change_target":null,"project_memory_management":false,"clarification":null,"public_summary":"直接回复。"}"#.to_string()
            })
        } else {
            "仅说明，不执行。".to_string()
        };
        Ok(crate::providers::base::stream_from_single_message(
            Message::assistant().with_text(text),
            crate::providers::base::ProviderUsage::new(
                "routing-test".to_string(),
                crate::providers::base::Usage::default(),
            ),
        ))
    }

    fn get_name(&self) -> &str {
        "routing-evidence-test"
    }
}

fn completed_activity(message: &Message) -> Option<ActivityEvent> {
    message.content.iter().find_map(|content| {
        let MessageContent::SystemNotification(notification) = content else {
            return None;
        };
        let event: ActivityEvent = serde_json::from_value(notification.data.clone()?).ok()?;
        (event.event_type == ActivityEventKind::IntentCompleted).then_some(event)
    })
}

#[tokio::test]
async fn routing_evidence_records_the_models_conversation_decision() -> Result<()> {
    let project = tempfile::tempdir()?;
    let data = tempfile::tempdir()?;
    let manager = Arc::new(SessionManager::new(data.path().join("sessions")));
    let agent = Agent::with_config(AgentConfig::new(
        manager.clone(),
        Arc::new(PermissionManager::new(data.path().join("permissions"))),
        None,
        GooseMode::Auto,
        true,
        GoosePlatform::GooseCli,
    ));
    let session = manager
        .create_session(
            project.path().to_path_buf(),
            "routing shortcut".to_string(),
            SessionType::CodePro,
            GooseMode::Auto,
        )
        .await?;
    let provider = Arc::new(NoToolProvider::default());
    agent
        .update_provider(
            provider.clone(),
            goose_providers::model::ModelConfig::new("routing-test"),
            &session.id,
        )
        .await?;
    let events = agent
        .reply_codepro_with_intent_for_test(
            session.clone(),
            Message::user().with_id("shortcut-user").with_text("你好"),
            SessionConfig {
                id: session.id.clone(),
                schedule_id: None,
                max_turns: Some(2),
                retry_config: None,
            },
            None,
            CodeProIntentDecision {
                intent: CodeProIntent::Conversation,
                clarification: None,
                public_summary: Some("直接回复。".to_string()),
                warning: None,
            },
            CodeProRunContext {
                classification_source: CodeProClassificationSource::SemanticModel,
                ..Default::default()
            },
        )
        .await?
        .try_collect::<Vec<_>>()
        .await?;
    let completed = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::Message(message) => completed_activity(message),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(completed.len(), 1);
    let evidence = completed[0]
        .routing_evidence
        .as_ref()
        .expect("shortcut evidence");
    assert_eq!(
        evidence.classification_source,
        CodeProClassificationSource::SemanticModel
    );
    assert_eq!(evidence.classified_intent, CodeProIntent::Conversation);
    assert_eq!(evidence.effective_intent, CodeProIntent::Conversation);
    assert_eq!(
        evidence.effective_intent_reason,
        CodeProEffectiveIntentReason::ClassifiedIntent
    );
    assert_eq!(
        evidence.simple_change_check,
        CodeProSimpleChangeCheck::NotApplicable
    );
    assert_eq!(evidence.semantic_warning, None);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn model_selected_direct_target_drives_the_simple_change_route() -> Result<()> {
    let project = tempfile::tempdir()?;
    let data = tempfile::tempdir()?;
    std::fs::write(
        project.path().join("app.ts"),
        "export const greeting = () => 'hello';\n",
    )?;
    std::fs::write(
        project.path().join("app.test.ts"),
        "// protected assertion\n",
    )?;
    let manager = Arc::new(SessionManager::new(data.path().join("sessions")));
    let agent = Agent::with_config(AgentConfig::new(
        manager.clone(),
        Arc::new(PermissionManager::new(data.path().join("permissions"))),
        None,
        GooseMode::Auto,
        true,
        GoosePlatform::GooseCli,
    ));
    let session = manager
        .create_session(
            project.path().to_path_buf(),
            "model direct route".to_string(),
            SessionType::CodePro,
            GooseMode::Auto,
        )
        .await?;
    let provider = Arc::new(NoToolProvider::default());
    agent
        .update_provider(
            provider,
            goose_providers::model::ModelConfig::new("routing-test"),
            &session.id,
        )
        .await?;
    let semantic = parse_semantic_decision(
        r#"{"intent":"change","direct_change_target":"app.ts","change_execution":"direct","project_memory_management":false,"focused_test":false,"clarification":null,"public_summary":"修复 app.ts 并运行指定验证。"}"#,
    );
    let target = validate_simple_change_target(
        project.path(),
        Path::new(semantic.direct_change_target.as_deref().unwrap()),
    )
    .map_err(anyhow::Error::msg)?;
    let events = agent
        .reply_codepro_with_intent_for_test(
            session.clone(),
            Message::user().with_id("typescript-user").with_text(
                "请修复当前失败的 TypeScript 测试，只修改 app.ts，不要修改 app.test.ts。修改后运行 node --test --test-isolation=none app.test.ts 验证。",
            ),
            SessionConfig {
                id: session.id.clone(),
                schedule_id: None,
                max_turns: Some(2),
                retry_config: None,
            },
            None,
            semantic.decision,
            CodeProRunContext {
                classification_source: CodeProClassificationSource::SemanticModel,
                simple_change: Some(SimpleChangeRequest { target }),
                ..Default::default()
            },
        )
        .await?
        .try_collect::<Vec<_>>()
        .await?;
    let evidence = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::Message(message) => completed_activity(message),
            _ => None,
        })
        .next()
        .and_then(|event| event.routing_evidence)
        .expect("model routing evidence");
    assert_eq!(
        evidence.classification_source,
        CodeProClassificationSource::SemanticModel
    );
    assert_eq!(evidence.classified_intent, CodeProIntent::Change);
    assert_eq!(
        evidence.simple_change_check,
        CodeProSimpleChangeCheck::Matched
    );
    assert_eq!(
        evidence.execution_route,
        CodeProExecutionRoute::SimpleChange
    );
    assert_eq!(
        std::fs::read_to_string(project.path().join("app.test.ts"))?,
        "// protected assertion\n"
    );
    Ok(())
}

#[tokio::test]
async fn routing_evidence_records_the_model_decision_and_survives_session_reload() -> Result<()> {
    for (source, warning) in [
        (CodeProClassificationSource::SemanticModel, None),
        (
            CodeProClassificationSource::SemanticRouterPostprocessed,
            Some(CodeProIntentWarning::SemanticRouterInvalidOutput),
        ),
    ] {
        let project = tempfile::tempdir()?;
        let data = tempfile::tempdir()?;
        std::fs::write(project.path().join("app.js"), "original\n")?;
        let manager = Arc::new(SessionManager::new(data.path().join("sessions")));
        let agent = Agent::with_config(AgentConfig::new(
            manager.clone(),
            Arc::new(PermissionManager::new(data.path().join("permissions"))),
            None,
            GooseMode::Auto,
            true,
            GoosePlatform::GooseCli,
        ));
        let session = manager
            .create_session(
                project.path().to_path_buf(),
                "routing evidence".to_string(),
                SessionType::CodePro,
                GooseMode::Auto,
            )
            .await?;
        let provider = Arc::new(NoToolProvider::default());
        agent
            .update_provider(
                provider.clone(),
                goose_providers::model::ModelConfig::new("routing-test"),
                &session.id,
            )
            .await?;
        let events = agent
            .reply_codepro_with_intent_for_test(
                session.clone(),
                Message::user()
                    .with_id("routing-user")
                    .with_text("不要调用任何工具，只解释方案。"),
                SessionConfig {
                    id: session.id.clone(),
                    schedule_id: None,
                    max_turns: Some(2),
                    retry_config: None,
                },
                None,
                CodeProIntentDecision {
                    intent: CodeProIntent::Conversation,
                    clarification: None,
                    public_summary: None,
                    warning,
                },
                CodeProRunContext {
                    active_run_id: Some("routing-run".to_string()),
                    classification_source: source,
                    ..Default::default()
                },
            )
            .await?
            .try_collect::<Vec<_>>()
            .await?;
        let messages = events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Message(message) => Some(message.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let completed = messages
            .iter()
            .filter_map(completed_activity)
            .collect::<Vec<_>>();
        assert_eq!(completed.len(), 1);
        let event = &completed[0];
        assert_eq!(event.run_id, "routing-run");
        assert_eq!(event.session_id, session.id);
        assert_eq!(event.event_id, "intent-classification-routing-user");
        assert!(!event.include_in_model_context);
        let evidence = event
            .routing_evidence
            .as_ref()
            .expect("host routing evidence");
        let build = evidence
            .build_provenance
            .as_ref()
            .expect("current runs include build provenance");
        assert_eq!(build.schema_version, 1);
        assert!(!build.package_version.is_empty());
        assert_eq!(evidence.classification_source, source);
        assert_eq!(evidence.classified_intent, CodeProIntent::Conversation);
        assert_eq!(evidence.semantic_warning, warning);
        assert_eq!(evidence.effective_intent, CodeProIntent::Conversation);
        assert_eq!(
            evidence.effective_intent_reason,
            CodeProEffectiveIntentReason::ClassifiedIntent
        );
        assert_eq!(
            evidence.simple_change_check,
            CodeProSimpleChangeCheck::NotApplicable
        );
        assert_eq!(
            evidence.execution_route,
            CodeProExecutionRoute::UnifiedExecutor
        );
        assert_eq!(evidence.goal_source, CodeProGoalSource::ExecutionMessage);
        assert!(event
            .technical_details
            .as_ref()
            .unwrap()
            .contains("classified_intent"));
        assert!(Conversation::new_unvalidated(messages)
            .agent_visible_messages()
            .iter()
            .all(|message| completed_activity(message).is_none()));
        let reloaded = manager.get_session(&session.id, true).await?;
        let persisted = reloaded
            .conversation
            .unwrap()
            .messages()
            .iter()
            .filter_map(completed_activity)
            .collect::<Vec<_>>();
        assert_eq!(persisted, completed);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read_to_string(project.path().join("app.js"))?,
            "original\n"
        );
    }
    Ok(())
}
