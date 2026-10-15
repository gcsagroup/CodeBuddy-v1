// Exercise the real executor and persistence path with controlled provider output.
// This tests Host behavior, not whether a live model's advice is correct.
struct ReadOnlyAnswerProvider {
    calls: AtomicUsize,
    read_path: Option<&'static str>,
    read_failed: bool,
    answer: &'static str,
    tail_polled: Arc<AtomicBool>,
    structured: Option<Arc<Mutex<Option<FinalOutputTool>>>>,
}

#[async_trait::async_trait]
impl crate::providers::base::Provider for ReadOnlyAnswerProvider {
    async fn stream(
        &self,
        _config: &goose_providers::model::ModelConfig,
        _prompt: &str,
        messages: &[Message],
        _tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let usage = ProviderUsage::new("mock-model".into(), Usage::default());
        if let Some(path) = self.read_path {
            if call == 0 {
                return Ok(stream_from_single_message(
                    Message::assistant().with_tool_request(
                        "read-only-answer-source",
                        Ok(CallToolRequestParams::new("read_document")
                            .with_arguments(json!({"path": path}).as_object().unwrap().clone())),
                    ),
                    usage,
                ));
            }
            let receipt = messages
                .iter()
                .flat_map(|m| &m.content)
                .find_map(|c| match c {
                    MessageContent::ToolResponse(r) if r.id == "read-only-answer-source" => Some(r),
                    _ => None,
                })
                .expect("the model must receive the actual read receipt");
            assert_eq!(
                receipt.tool_result.as_ref().unwrap().is_error == Some(true),
                self.read_failed
            );
        }
        if let Some(tool) = &self.structured {
            // Model the existing recipe collector's validated output, then exercise
            // the executor's pending-final-output branch without a new protocol.
            let result = tool
                .lock()
                .await
                .as_mut()
                .unwrap()
                .execute_tool_call(
                    CallToolRequestParams::new(FINAL_OUTPUT_TOOL_NAME).with_arguments(
                        json!({"answer": self.answer}).as_object().unwrap().clone(),
                    ),
                )
                .await;
            drop(result);
            return Ok(stream_from_single_message(
                Message::assistant().with_text(""),
                usage,
            ));
        }
        let answer = self.answer;
        let split = answer
            .char_indices()
            .nth(3)
            .map(|(i, _)| i)
            .unwrap_or(answer.len());
        let tail_polled = self.tail_polled.clone();
        Ok(Box::pin(async_stream::stream! {
            yield Ok((Some(Message::assistant().with_text(&answer[..split])), None));
            tail_polled.store(true, Ordering::SeqCst);
            yield Ok((Some(Message::assistant().with_text(&answer[split..])), Some(usage)));
        }))
    }

    fn get_name(&self) -> &str {
        "read-only-answer-fixture"
    }
}

#[tokio::test]
async fn read_only_answers_do_not_require_tool_activity_or_host_report_rewriting() -> Result<()> {
    let cases = [
        ("advice", "我想给店里做个预约小工具，店里电脑要能用，最好手机也能看。你给我几个方案，说说各自的优缺点，推荐一个让我选。先不写代码。",
            "可以比较本机、局域网和云端三种方案；手机是否需要在店外访问，会影响推荐。", None, false),
        ("provided-material", "这段内容帮我摘成一行：门店周一休息。",
            "门店周一休息。", None, false),
        ("honest-gap", "分析当前项目。",
            "## 一句话结论\n我还没有读到项目资料，无法判断当前实现。\n## 风险和建议\n需要项目入口或相关文件。", None, false),
        ("missing-file", "看看 missing.txt 写了什么，不修改。",
            "没有读到 missing.txt，无法确认内容。请确认文件位置。", Some("missing.txt"), true),
        ("unrelated-read", "查完资料后比较方案，先不改。",
            "读到的文件与方案无关，下面只能给一般建议，不能当作查证结论。", Some("notes.txt"), false),
        ("finalizing", "读取 notes.txt，说明还缺什么。",
            "## 一句话结论\n文件已读到，但没有运行验证。\n## 风险和建议\n仍需实际验证。", Some("notes.txt"), false),
        ("structured", "按既定 JSON 格式回答方案。",
            "尚未查实时价格，可以先讨论部署方式。", None, false),
    ];
    for (case, input, answer, read_path, read_failed) in cases {
        let project = tempfile::tempdir()?;
        tokio::fs::write(
            project.path().join("notes.txt"),
            "unrelated fixture material",
        )
        .await?;
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
        let mut session = manager
            .create_session(
                project.path().to_path_buf(),
                case.into(),
                SessionType::CodePro,
                GooseMode::Auto,
            )
            .await?;
        bind_test_workspace(&manager, &mut session).await?;
        if read_path.is_some() {
            let developer = get_enabled_extensions()
                .into_iter()
                .find(|e| e.name() == "developer")
                .expect("developer enabled");
            agent.add_extension(developer, &session.id).await?;
        }
        let structured = case == "structured";
        if structured {
            agent
                .add_final_output_tool(crate::recipe::Response {
                    json_schema: Some(json!({
                        "type": "object", "properties": {"answer": {"type": "string"}},
                        "required": ["answer"], "additionalProperties": false
                    })),
                })
                .await;
        }
        let provider = Arc::new(ReadOnlyAnswerProvider {
            calls: AtomicUsize::new(0),
            read_path,
            read_failed,
            answer,
            tail_polled: Arc::new(AtomicBool::new(false)),
            structured: structured.then(|| agent.final_output_tool.clone()),
        });
        agent
            .update_provider(
                provider.clone(),
                goose_providers::model::ModelConfig::new("mock-model"),
                &session.id,
            )
            .await?;
        let mut options = UnifiedExecutorOptions::codepro_analysis();
        if case == "finalizing" {
            options.action_budget_config = None;
        }
        let user_message = Message::user().with_text(input);
        // The public entry point persists input before calling this executor.
        manager.add_message(&session.id, &user_message).await?;
        let session_config = SessionConfig {
            id: session.id.clone(),
            schedule_id: None,
            max_turns: Some(if case == "finalizing" { 2 } else { 10 }),
            retry_config: None,
        };
        let mut events = if case == "finalizing" {
            agent
                .reply_codepro_unified(&session, user_message, session_config, None, options)
                .await?
        } else {
            // Keep the original failing ReadOnly classification. Moving this
            // request to Conversation would conceal the faulty answer boundary.
            agent
                .reply_codepro_with_intent_for_test(
                    session.clone(),
                    user_message,
                    session_config,
                    None,
                    CodeProIntentDecision {
                        intent: CodeProIntent::ReadOnly,
                        clarification: None,
                        public_summary: None,
                        warning: None,
                    },
                    CodeProRunContext::default(),
                )
                .await?
        };
        let mut visible = String::new();
        while let Some(event) =
            tokio::time::timeout(std::time::Duration::from_secs(10), events.next())
                .await
                .with_context(|| format!("answer boundary stalled: {case}"))?
        {
            if let AgentEvent::Message(message) = event? {
                if message.role == Role::Assistant && message.metadata.user_visible {
                    let text = message.user_visible_content().as_concat_text();
                    if !structured && visible.is_empty() && !text.is_empty() {
                        assert!(
                            !provider.tail_polled.load(Ordering::SeqCst),
                            "first delta was held until completion: {case}"
                        );
                    }
                    visible.push_str(&text);
                }
            }
        }
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            if read_path.is_some() { 2 } else { 1 },
            "the Host added an unsolicited evidence retry: {case}"
        );
        if structured {
            assert_eq!(
                serde_json::from_str::<Value>(&visible)?,
                json!({"answer": answer})
            );
        } else {
            assert_eq!(
                visible, answer,
                "answer was replaced, duplicated or certified: {case}"
            );
        }
        let saved = manager.get_session(&session.id, true).await?;
        let history = saved.conversation.as_ref().unwrap().messages();
        let saved_text: String = history
            .iter()
            .filter(|m| m.role == Role::Assistant && m.metadata.user_visible)
            .map(|m| m.user_visible_content().as_concat_text())
            .collect();
        assert_eq!(
            saved_text, visible,
            "history must match the delivered answer: {case}"
        );
        let user_text: Vec<_> = history
            .iter()
            .filter(|m| m.role == Role::User)
            .map(|m| m.as_concat_text())
            .filter(|text| !text.is_empty())
            .collect();
        assert_eq!(
            user_text,
            [input],
            "Host must not impersonate a new user request: {case}"
        );
        let state = saved
            .extension_data
            .get_extension_state("codepro_unified_turn", "v1")
            .unwrap();
        assert_eq!(state["status"], "finished", "{case}");
        assert!(state["pause_reason"].is_null(), "{case}");
        assert_eq!(
            tokio::fs::read_to_string(project.path().join("notes.txt")).await?,
            "unrelated fixture material"
        );
        assert!(!project.path().join("missing.txt").exists());
    }
    Ok(())
}
