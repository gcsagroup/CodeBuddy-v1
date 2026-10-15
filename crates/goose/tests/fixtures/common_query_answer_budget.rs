// Replay the reported shape: three failed queries, successful fourth query,
// then a user-facing answer. Use the real local clock tool so this regression
// exercises dispatch and persistence without depending on weather networking.
struct CommonQueryBudgetProvider {
    calls: AtomicUsize,
    reject_first_answer: bool,
}

#[async_trait::async_trait]
impl crate::providers::base::Provider for CommonQueryBudgetProvider {
    async fn stream(
        &self,
        _config: &goose_providers::model::ModelConfig,
        prompt: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let usage = ProviderUsage::new("mock-model".into(), Usage::default());
        if call < 4 {
            assert!(tools.iter().any(|t| t.name == "time_now"));
            let args = json!({"timezone": if call < 3 { "Invalid/Zone" } else { "UTC" }});
            let message = Message::assistant().with_tool_request(
                format!("query-{call}"),
                Ok(CallToolRequestParams::new("time_now")
                    .with_arguments(args.as_object().unwrap().clone())),
            );
            return Ok(stream_from_single_message(message, usage));
        }
        assert!(
            tools.is_empty(),
            "answer phase must withdraw execution tools"
        );
        assert!(prompt.contains("# Common-query answer"));
        let receipts: Vec<_> = messages
            .iter()
            .flat_map(|m| &m.content)
            .filter_map(|c| {
                if let MessageContent::ToolResponse(r) = c {
                    Some(r)
                } else {
                    None
                }
            })
            .collect();
        assert!(
            receipts.len() >= 4,
            "all query evidence must reach final answer"
        );
        assert!(receipts[..3]
            .iter()
            .all(|r| r.tool_result.as_ref().unwrap().is_error == Some(true)));
        let result = receipts[3].tool_result.as_ref().unwrap();
        assert_ne!(result.is_error, Some(true));
        assert!(serde_json::to_string(result)
            .unwrap()
            .contains("local_time"));
        if call == 4 && self.reject_first_answer {
            return Ok(stream_from_single_message(
                Message::assistant().with_tool_request(
                    "forbidden-answer-query",
                    Ok(CallToolRequestParams::new("time_now")),
                ),
                usage,
            ));
        }
        if self.reject_first_answer {
            assert_eq!(call, 5, "only one answer correction is available");
            assert!(
                receipts
                    .last()
                    .unwrap()
                    .tool_result
                    .as_ref()
                    .unwrap()
                    .is_error
                    == Some(true)
            );
        } else {
            assert_eq!(call, 4);
        }
        Ok(stream_from_single_message(
            Message::assistant()
                .with_text("已取得 UTC 当前时间；前三次时区查询失败不影响最后一次有效结果。"),
            usage,
        ))
    }

    fn get_name(&self) -> &str {
        "common-query-budget-fixture"
    }
}

#[tokio::test]
async fn common_query_answer_budget_preserves_success_after_three_errors_and_blocks_answer_tools(
) -> Result<()> {
    // Native calls and a model requesting another tool during finalization.
    for reject_first_answer in [false, true] {
        let data = tempfile::tempdir()?;
        let project = tempfile::tempdir()?;
        let manager = Arc::new(SessionManager::new(data.path().join("sessions")));
        let agent = Agent::with_config(with_test_http_attempt_gate(AgentConfig::new(
            manager.clone(),
            Arc::new(PermissionManager::new(data.path().join("permissions"))),
            None,
            GooseMode::Auto,
            true,
            GoosePlatform::GooseCli,
        )));
        let session = manager
            .create_session(
                project.path().to_path_buf(),
                "query answer budget".into(),
                SessionType::CodePro,
                GooseMode::Auto,
            )
            .await?;
        let extension = get_enabled_extensions()
            .into_iter()
            .find(|e| e.name() == "commonqueries")
            .expect("common queries enabled");
        agent.add_extension(extension, &session.id).await?;
        let provider = Arc::new(CommonQueryBudgetProvider {
            calls: AtomicUsize::new(0),
            reject_first_answer,
        });
        agent
            .update_provider(
                provider.clone(),
                goose_providers::model::ModelConfig::new("mock-model"),
                &session.id,
            )
            .await?;
        let input = Message::user().with_text("查询现在的 UTC 时间。");
        manager.add_message(&session.id, &input).await?;
        let mut events = agent
            .reply_codepro_unified(
                &session,
                input,
                SessionConfig {
                    id: session.id.clone(),
                    schedule_id: None,
                    max_turns: Some(100),
                    retry_config: None,
                },
                None,
                UnifiedExecutorOptions::codepro_conversation(),
            )
            .await?;
        let mut visible = String::new();
        while let Some(event) =
            tokio::time::timeout(std::time::Duration::from_secs(15), events.next()).await?
        {
            if let AgentEvent::Message(message) = event? {
                visible.push_str(&agent_visible_message_text(&message));
            }
        }
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            if reject_first_answer { 6 } else { 5 }
        );
        assert!(visible.contains("已取得 UTC 当前时间"), "{visible}");
        let saved = manager
            .get_session(&session.id, true)
            .await?
            .conversation
            .unwrap();
        let serialized = serde_json::to_string(&saved)?;
        assert!(
            !serialized.contains("codepro.execution_limit_reached"),
            "a successful query answer is not exhaustion"
        );
        assert!(serialized.contains("已取得 UTC 当前时间"));
    }
    Ok(())
}
