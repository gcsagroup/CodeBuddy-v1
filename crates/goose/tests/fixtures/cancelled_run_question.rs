// Included in agent::tests: a related run is context, not execution authority.
struct CancelledQuestionProvider {
    seen: std::sync::Mutex<Vec<Message>>,
}

#[async_trait::async_trait]
impl crate::providers::base::Provider for CancelledQuestionProvider {
    fn get_name(&self) -> &str {
        "cancelled-question-fixture"
    }

    async fn stream(
        &self,
        _model: &goose_providers::model::ModelConfig,
        _system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        assert!(!tools.iter().any(|tool| matches!(tool.name.as_ref(),
            "write" | "edit" | "codepro__task_contract")),
            "status answer must not regain task mutation tools");
        *self.seen.lock().unwrap() = messages.to_vec();
        Ok(stream_from_single_message(
            Message::assistant().with_text("任务已停止；没有新增执行。"),
            ProviderUsage::new("fixture".into(), Usage::default()),
        ))
    }
}


#[tokio::test]
async fn cancelled_run_question_consumes_original_facts_without_mutating_run() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let manager = Arc::new(SessionManager::new(temp.path().join("sessions")));
    let session = manager.create_session(
        temp.path().to_path_buf(), "stopped delegation".into(),
        SessionType::CodePro, GooseMode::Auto,
    ).await?;
    let runtime = CodeProRuntime::initialize_production(
        temp.path().join("runtime"),
        crate::agents::control_plane::RuntimeModePolicy::parse(Some("durable")),
    ).await?;
    let run_id = RunId::new("cancelled-question")?;
    runtime.create_or_verify_run(&session.id, run_id.clone(), "review the fixture").await?;
    runtime.control(&session.id, ControlCommand::CancelRun {
        run_id: run_id.clone(), reason: "user stopped".into(),
    }, None).await?;
    let before = runtime.snapshot(&session.id, &run_id).await?;
    manager.add_message(&session.id,
        &Message::assistant().with_text("旧的模型自述：所有子任务都成功了。")
    ).await?;
    let agent = Agent::with_config(AgentConfig::new(
        manager.clone(),
        Arc::new(PermissionManager::new(temp.path().join("permissions"))),
        None, GooseMode::Auto, true, GoosePlatform::GooseCli,
    ).with_codepro_runtime(runtime.clone()));
    let provider = Arc::new(CancelledQuestionProvider { seen: Default::default() });
    agent.update_provider(provider.clone(),
        goose_providers::model::ModelConfig::new("fixture"), &session.id).await?;
    let prompt = "先停在这里，不要再改了。告诉我刚刚哪些子任务真的执行过、哪些文件已经改了、有没有仍在后台做事的，以及哪些还没验证。只报告现状。";
    let stream = agent.reply_codepro_question(
        Message::user().with_text(prompt),
        SessionConfig { id: session.id.clone(), schedule_id: None, max_turns: Some(2), retry_config: None },
        None, Some(run_id.as_str()),
    ).await?;
    futures::pin_mut!(stream);
    while let Some(event) = stream.next().await { event?; }
    let seen = provider.seen.lock().unwrap();
    // Provider formatting merges adjacent user messages; the original input
    // must survive as a content block, not necessarily a standalone message.
    assert!(seen.iter().any(|message| message.content.iter().any(|part| {
        matches!(part, MessageContent::Text(text) if text.text == prompt)
    })), "original user input missing from provider request: {seen:?}");
    let facts = seen.iter().find(|message| {
        message.as_concat_text().starts_with("Recorded host facts for the related run")
    }).expect("the original owner snapshot must reach the model");
    assert!(!facts.metadata.user_visible);
    assert!(facts.as_concat_text().contains("\"state\":\"cancelled\""));
    assert!(facts.as_concat_text().contains(run_id.as_str()));
    drop(seen);
    let after = runtime.snapshot(&session.id, &run_id).await?;
    assert_eq!(after.projection, before.projection);
    assert_eq!(after.events, before.events);
    let saved = manager.get_session(&session.id, true).await?.conversation.unwrap();
    assert!(saved.iter().any(|message| message.metadata.user_visible
        && message.as_concat_text() == prompt));
    assert!(!saved.iter().any(|message|
        message.as_concat_text().contains("Recorded host facts for the related run")));
    Ok(())
}
