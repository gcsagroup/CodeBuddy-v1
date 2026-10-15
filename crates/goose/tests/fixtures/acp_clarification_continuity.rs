#[tokio::test]
async fn clarification_continuity_acp_registration_reuses_verified_goal_and_run(
) -> anyhow::Result<()> {
    use crate::agents::codepro_clarification::{
        ClarificationState, ClarificationStatus, MessageLink,
    };
    use crate::agents::GoosePlatform;
    struct PreparedChoiceProvider;
    #[async_trait::async_trait]
    impl crate::providers::base::Provider for PreparedChoiceProvider {
        fn get_name(&self) -> &str { "clarification-fixture" }
        async fn validate_credentials(&self) -> Result<(), goose_providers::errors::ProviderError> { Ok(()) }
        async fn fetch_supported_models(&self) -> Result<Vec<String>, goose_providers::errors::ProviderError> {
            Ok(vec!["fixture-model".into()])
        }
        async fn stream(
            &self,
            _config: &goose_providers::model::ModelConfig,
            system: &str,
            _messages: &[Message],
            _tools: &[rmcp::model::Tool],
        ) -> Result<crate::providers::base::MessageStream, goose_providers::errors::ProviderError> {
            assert!(system.contains("Classify the relationship of the current user input"));
            Ok(crate::providers::base::stream_from_single_message(
                Message::assistant().with_text(r#"{"kind":"proceed"}"#),
                crate::conversation::token_usage::ProviderUsage::new("fixture-model".into(), crate::conversation::token_usage::Usage::default()),
            ))
        }
    }
    let temp = tempfile::tempdir()?;
    let home = temp.path().to_string_lossy().to_string();
    let _env = env_lock::lock_env([
        ("CODEBUDDY_HOME", Some(home.as_str())),
        ("CODEPRO_RUNTIME_MODE", Some("durable")),
        ("GOOSE_PROVIDER", Some("clarification-fixture")),
        ("GOOSE_MODEL", Some("fixture-model")),
        ("GOOSE_CODEPRO_MODEL_ROUTING", Some(r#"{"version":1,"advancedRoutingEnabled":false,"routes":[],"maxParallelCoders":1}"#)),
    ]);
    let sessions = Arc::new(SessionManager::new(temp.path().join("sessions")));
    let session = sessions
        .create_session(
            temp.path().to_path_buf(),
            "ACP clarification".into(),
            SessionType::CodePro,
            GooseMode::Auto,
        )
        .await?;
    let source = Message::user()
        .with_id("source")
        .with_text("为登录加入验证码");
    let question = Message::assistant()
        .with_id("question")
        .with_text("短信还是邮箱？");
    let answer = Message::user().with_id("answer").with_text("邮箱");
    for message in [&source, &question, &answer] {
        sessions.add_message(&session.id, message).await?;
    }
    let prepared = ClarificationState {
        session_id: session.id.clone(),
        workspace: temp.path().canonicalize()?,
        source: MessageLink::new(&source)?,
        question: MessageLink::new(&question)?,
        previous_answers: Vec::new(),
        last_input: None,
        execution_run_id: None,
        status: ClarificationStatus::Prepared {
            answer: MessageLink::new(&answer)?,
        },
    };
    sessions
        .save_clarification_transition(&session.id, None, &prepared, None)
        .await?;
    let provider: Arc<dyn crate::providers::base::Provider> = Arc::new(PreparedChoiceProvider);
    let factory_provider = provider.clone();
    let config = AgentConfig::new(
        sessions.clone(),
        Arc::new(PermissionManager::new(temp.path().join("permissions"))),
        None,
        GooseMode::Auto,
        true,
        GoosePlatform::GooseDesktop,
    )
    .with_model_router_provider_factory(Arc::new(move |_, _, _| {
        let provider = factory_provider.clone();
        Box::pin(async move { Ok(provider) })
    }))
    .with_codepro_http_attempt_gate(Arc::new(
        crate::agents::external_http_attempt_budget::ExternalHttpAttemptBudget::issue_for_new_logical_run(
            temp.path().join("http-budget.json"),
            "clarification-fixture".into(),
            Default::default(),
        )?
    ));
    let agent = Agent::with_config(config.clone());
    agent.update_provider(provider.clone(), goose_providers::model::ModelConfig::new("fixture-model"), &session.id).await?;
    let input = Message::user().with_id("continue-1").with_text("继续");
    agent
        .prepare_codepro_clarification_input(&session.id, &input, None)
        .await?;
    let goal = agent
        .codepro_clarification_goal(&session.id, &input)
        .await?
        .unwrap();
    assert!(goal.contains("为登录加入验证码") && goal.contains("邮箱"));
    let identity = codepro_prompt_run_identity(None);
    agent
        .bind_codepro_clarification_run(&session.id, &input, &identity.run_id)
        .await?;
    let control = codepro_control::CodeProControlService::new(
        temp.path().join("control"),
        temp.path().join("audit"),
    )
    .await?;
    let first = control
        .register_prompt_run(&session.id, &identity.run_id, &goal)
        .await?;
    assert_eq!(first.goal, goal);

    let restored = Agent::with_config(config);
    restored.update_provider(provider, goose_providers::model::ModelConfig::new("fixture-model"), &session.id).await?;
    let retry = Message::user().with_id("continue-2").with_text("继续");
    restored
        .prepare_codepro_clarification_input(&session.id, &retry, None)
        .await?;
    let recovered_goal = restored
        .codepro_clarification_goal(&session.id, &retry)
        .await?
        .unwrap();
    let recovered_run = restored
        .codepro_clarification_run_id(&session.id, &retry)
        .await?
        .unwrap();
    assert_eq!(recovered_goal, goal);
    assert_eq!(recovered_run, identity.run_id);
    restored
        .bind_codepro_clarification_run(&session.id, &retry, &recovered_run)
        .await?;
    let replayed = control
        .register_prompt_run(&session.id, &recovered_run, &recovered_goal)
        .await?;
    assert_eq!(replayed.last_sequence, first.last_sequence);
    assert_eq!(replayed.goal, goal);
    assert!(control
        .register_prompt_run(&session.id, &recovered_run, "邮箱")
        .await
        .is_err());
    let stored = sessions.get_session(&session.id, true).await?;
    for expected in [&source, &answer, &input, &retry] {
        let messages = stored
            .conversation
            .as_ref()
            .unwrap()
            .messages()
            .iter()
            .filter(|message| message.id == expected.id)
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].as_concat_text(), expected.as_concat_text());
    }
    Ok(())
}
