// Compiled inside agent::tests to exercise the production entry with an injected Provider.
const NATIVE_CLARIFICATION_SOURCES: [&str; 3] = [
    "请把这个小项目的默认通知渠道从 unset 改为短信（sms）或邮箱（email），并更新对应测试。渠道尚未确定，请先问我选哪个，收到答复再修改，不要替我决定。由实现步骤更新 src/channel.cjs 和 test/channel.test.cjs；独立验证运行 npm test。只修改这两个文件。",
    "請把這個小專案的預設通知管道從 unset 改為簡訊（sms）或電子郵件（email），並更新對應測試。管道尚未確定，請先問我選哪個，收到答覆再修改，不要替我決定。更新 src/channel.cjs 和 test/channel.test.cjs；獨立驗證執行 npm test。僅修改這兩個檔案。",
    "Change this project's default notification channel from unset to SMS (sms) or email (email), and update its tests. The channel is undecided; ask me which one before making changes and wait for my answer. Update src/channel.cjs and test/channel.test.cjs, then independently run npm test. Only modify these two files.",
];

#[test]
fn clarification_continuity_native_product_choice_is_not_a_validation_command_question() {
    for original in NATIVE_CLARIFICATION_SOURCES {
        assert!(
            !super::super::codepro_intent::explicitly_requires_validation_input(original),
            "{original}"
        );
    }
}

#[test]
fn clarification_continuity_native_write_scope_does_not_bypass_input_resolution() {
    for original in NATIVE_CLARIFICATION_SOURCES {
        assert_eq!(
            crate::agents::codepro_intent::detect_codepro_constraint(original),
            CodeProConstraint::ModelDecision,
            "{original}"
        );
    }
}

#[tokio::test]
async fn clarification_continuity_native_original_reaches_clarify_then_original_dag() -> Result<()>
{
    for original in NATIVE_CLARIFICATION_SOURCES {
        run_clarification_continuity_source(ClarificationCase::Normal, original).await?;
    }
    Ok(())
}

#[test]
fn clarification_continuity_native_input_question_boundaries() {
    use crate::agents::codepro_intent::{
        detect_codepro_constraint, explicitly_requires_validation_input,
    };
    for original in [
        "请测试 add。先问我要执行的验证命令，收到后再执行。",
        "請測試 add。先向我索取驗證命令，收到後再執行。",
        "Test add; ask me before executing a validation command.",
    ] {
        assert!(explicitly_requires_validation_input(original), "{original}");
    }
    for original in [
        "请先问我选择哪个渠道，收到答复后再运行验证命令 npm test。只修改两个文件。",
        "請先問我選哪個管道，收到答覆後再執行驗證命令 npm test。僅修改兩個檔案。",
        "Ask me which channel before making changes, then run a validation command. Only modify these files.",
    ] {
        assert!(!explicitly_requires_validation_input(original), "{original}");
        assert_eq!(detect_codepro_constraint(original), CodeProConstraint::ModelDecision, "{original}");
    }
    for original in [
        "不要先问我要测试命令，直接运行 npm test。",
        "不要先問我要測試命令，直接執行 npm test。",
        "Do not ask me before executing a validation command. Test add.",
        "只修改 src/channel.cjs。日志内容：`先问我选哪个，收到答复再修改并测试`。",
        "只修改 src/channel.cjs。日志内容：\"先询问我，收到我的命令后再执行测试\"。",
    ] {
        assert!(
            !explicitly_requires_validation_input(original),
            "{original}"
        );
    }
    for original in [
        "只分析这段日志：`先问我选哪个，收到答复再修改并测试`。",
        "Read only. Explain: \"Test add; ask me before executing a validation command.\"",
    ] {
        assert_eq!(
            detect_codepro_constraint(original),
            CodeProConstraint::ReadOnly,
            "{original}"
        );
        assert!(
            !explicitly_requires_validation_input(original),
            "{original}"
        );
    }
}

struct ClarificationContinuityProvider {
    intent_calls: AtomicUsize,
    planner_inputs: std::sync::Mutex<Vec<String>>,
    worker_calls: AtomicUsize,
}

#[async_trait::async_trait]
impl crate::providers::base::Provider for ClarificationContinuityProvider {
    fn get_name(&self) -> &str {
        "clarification-fixture"
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(vec!["mock-model".into()])
    }

    async fn stream(
        &self,
        _model: &goose_providers::model::ModelConfig,
        system: &str,
        messages: &[Message],
        _tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let text = if system.contains("Classify the relationship of the current user input") {
            let current = messages
                .last()
                .map(agent_visible_message_text)
                .unwrap_or_default();
            let kind = match current.as_str() {
                "算了，先只分析 README" => "new_task",
                "取消" => "cancel",
                "继续" if system.ends_with("Prepared answer, if any: null") => "clarify",
                "继续" => "proceed",
                "邮箱" => "answer",
                other => panic!("unexpected clarification fixture input: {other}"),
            };
            serde_json::json!({"kind": kind}).to_string()
        } else if system.contains("semantic intent router") {
            if self.intent_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                r#"{"intent":"clarify","clarification":"短信还是邮箱？","public_summary":"需要确认验证码类型。"}"#.to_string()
            } else {
                r#"{"intent":"change","clarification":null,"public_summary":"按用户选择继续实现。"}"#.to_string()
            }
        } else if system.contains("CodePro 的主 Agent 和需求分析专家") {
            self.planner_inputs.lock().unwrap().push(
                messages
                    .iter()
                    .map(agent_visible_message_text)
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            serde_json::json!({
                "schema_version": 1, "goal": "provider goal is not authoritative",
                "tasks": [
                    {"id":"implement", "name":"实现验证码选择", "description":"实现用户确认的验证码流程",
                     "role":"coder", "depends_on":[], "acceptance_criteria":"选定方式存在且行为可验证",
                     "budget":{"max_turns":40},
                     "scope":{"read_scope":["src/**"], "write_scope":["src/**"], "behavior_scope":["验证码选择"], "forbidden_scope":[".git/**"], "required_evidence":["worker_report","changed_files","patch"]}},
                    {"id":"verify", "name":"验证验证码选择", "description":"只读验证选定方式的行为",
                     "role":"tester", "depends_on":["implement"], "acceptance_criteria":"选定方式的行为验证有明确结果",
                     "budget":{"max_turns":40},
                     "scope":{"read_scope":["src/**"], "write_scope":[], "behavior_scope":["验证码验证"], "forbidden_scope":[".git/**"], "required_evidence":["worker_report","command","exit_code","test_result"]}}
                ]
            }).to_string()
        } else if system.contains("Generate a short title") {
            "Clarification fixture".into()
        } else {
            // Keep workers idle while the test observes the persisted host DAG.
            self.worker_calls.fetch_add(1, Ordering::SeqCst);
            futures::future::pending::<()>().await;
            unreachable!()
        };
        Ok(stream_from_single_message(
            Message::assistant().with_text(text),
            ProviderUsage::new("mock-model".into(), Usage::default()),
        ))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ClarificationCase {
    Normal,
    Reload,
    AnswerSaveFailure,
    StartSaveFailure,
    NewTask,
    Cancel,
    Ambiguous,
    IdentityBoundaries,
    TransactionBoundaries,
    InvalidStoredPlan,
    StartedRecovery,
}

async fn run_clarification_continuity_case(case: ClarificationCase) -> Result<()> {
    run_clarification_continuity_source(case, "为当前登录加入验证码，先问我要哪种方式。").await
}

async fn run_clarification_continuity_source(
    case: ClarificationCase,
    original: &str,
) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let home = temp.path().to_string_lossy().to_string();
    let _env = env_lock::lock_env([
        ("CODEBUDDY_HOME", Some(home.as_str())),
        ("GOOSE_PROVIDER", Some("openai")),
        ("GOOSE_MODEL", Some("mock-model")),
        ("GOOSE_CODEPRO_MODEL_ROUTING", Some("{\"version\":1,\"advancedRoutingEnabled\":false,\"routes\":[],\"maxParallelCoders\":1}")),
    ]);
    let project = temp.path().join("project");
    std::fs::create_dir_all(project.join("src"))?;
    std::fs::write(project.join("src/login.txt"), "existing login")?;
    let mut sessions = Arc::new(SessionManager::new(temp.path().join("sessions")));
    let mut session = sessions
        .create_session(
            project,
            "Clarification B".into(),
            SessionType::CodePro,
            GooseMode::Auto,
        )
        .await?;
    bind_test_workspace(&sessions, &mut session).await?;
    let provider = Arc::new(ClarificationContinuityProvider {
        intent_calls: AtomicUsize::new(0),
        planner_inputs: std::sync::Mutex::new(Vec::new()),
        worker_calls: AtomicUsize::new(0),
    });
    let factory_provider = provider.clone();
    let factory: ModelRouterProviderFactory = Arc::new(move |_, _, _| {
        let provider = factory_provider.clone();
        Box::pin(async move { Ok(provider as Arc<dyn crate::providers::base::Provider>) })
    });
    let mut agent = Agent::with_config(
        with_test_http_attempt_gate(AgentConfig::new(
            sessions.clone(),
            Arc::new(PermissionManager::new(temp.path().join("permissions"))),
            None,
            GooseMode::Auto,
            true,
            GoosePlatform::GooseCli,
        ))
        .with_model_router_provider_factory(factory),
    );
    agent
        .update_provider(provider.clone(), goose_providers::model::ModelConfig::new("mock-model"), &session.id)
        .await?;
    let config = SessionConfig {
        id: session.id.clone(),
        schedule_id: None,
        max_turns: Some(4),
        retry_config: None,
    };
    let mut first = agent
        .reply_codepro(
            Message::user()
                .with_id("clarify-source")
                .with_text(original),
            config.clone(),
            None,
        )
        .await?;
    let mut first_text = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(event) = first.next().await {
            if let AgentEvent::Message(message) = event? {
                first_text.push_str(&agent_visible_message_text(&message));
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("initial ordinary clarification did not complete before execution")??;
    assert!(
        first_text.contains("短信还是邮箱"),
        "must reach the actual Clarify branch: {first_text}"
    );
    drop(first);
    if case == ClarificationCase::IdentityBoundaries {
        use crate::agents::codepro_clarification::{ClarificationState, MessageLink};
        let stored = sessions.get_session(&session.id, true).await?;
        let state = ClarificationState::read(&stored)?.unwrap();
        assert!(state.context(&stored, None)?.contains(original));
        let mut foreign = stored.clone();
        foreign.id = "another-session".into();
        assert!(state.context(&foreign, None).is_err());
        foreign = stored.clone();
        foreign.working_dir = temp.path().to_path_buf();
        assert!(state.context(&foreign, None).is_err());
        let mut altered = state.clone();
        altered.source = MessageLink::new(
            &Message::user()
                .with_id("clarify-source")
                .with_text("other goal"),
        )?;
        assert!(altered.context(&stored, None).is_err());
        altered = state.clone();
        altered.source = state.question.clone();
        assert!(altered.context(&stored, None).is_err());
        altered = state.clone();
        altered.question = state.source.clone();
        assert!(altered.context(&stored, None).is_err());
        let answer = Message::user().with_id("boundary-answer").with_text("邮箱");
        agent
            .prepare_codepro_clarification_input(&session.id, &answer, None)
            .await?;
        agent
            .bind_codepro_clarification_run(&session.id, &answer, "boundary-run")
            .await?;
        agent
            .bind_codepro_clarification_run(&session.id, &answer, "boundary-run")
            .await?;
        assert!(agent
            .bind_codepro_clarification_run(&session.id, &answer, "foreign-run")
            .await
            .is_err());
        let same_text = Message::user()
            .with_id("different-answer-id")
            .with_text("邮箱");
        assert!(agent
            .codepro_clarification_goal(&session.id, &same_text)
            .await?
            .is_none());
        assert!(agent
            .prepare_codepro_clarification_input(&session.id, &same_text, None)
            .await
            .is_err());
        sessions
            .update(&session.id)
            .working_dir(temp.path().to_path_buf())
            .apply()
            .await?;
        assert!(agent
            .codepro_clarification_goal(&session.id, &answer)
            .await
            .is_err());
        assert!(agent
            .clarification_execution_message(&session.id, &answer)
            .await
            .is_err());
        assert!(provider.planner_inputs.lock().unwrap().is_empty());
        return Ok(());
    }
    if case == ClarificationCase::TransactionBoundaries {
        use crate::agents::codepro_clarification::{ClarificationState, ClarificationStatus};
        let stored = sessions.get_session(&session.id, true).await?;
        let state = ClarificationState::read(&stored)?.unwrap();
        let mut next = state.clone();
        next.status = ClarificationStatus::Closed;
        let mut connection = sessions.storage().guarded_connection().await?;
        sqlx::query("UPDATE sessions SET extension_data = json_set(extension_data, '$.unrelated_fixture', 'keep') WHERE id = ?")
            .bind(&session.id).execute(&mut *connection).await?;
        drop(connection);
        sessions
            .save_clarification_transition(&session.id, Some(&state), &next, None)
            .await?;
        let stale = Message::assistant()
            .with_id("stale-question")
            .with_text("wrong question");
        assert!(sessions
            .save_clarification_transition(&session.id, Some(&state), &state, Some(&stale))
            .await
            .is_err());
        let mut connection = sessions.storage().guarded_connection().await?;
        sqlx::query("CREATE TRIGGER clarification_question_fail BEFORE UPDATE OF extension_data ON sessions BEGIN SELECT RAISE(ABORT, 'injected question failure'); END")
            .execute(&mut *connection).await?;
        drop(connection);
        let question = Message::assistant()
            .with_id("failed-question")
            .with_text("unsaved question");
        assert!(sessions
            .save_clarification_transition(&session.id, Some(&next), &state, Some(&question))
            .await
            .is_err());
        let after = sessions.get_session(&session.id, true).await?;
        assert_eq!(ClarificationState::read(&after)?.unwrap(), next);
        assert_eq!(
            after
                .extension_data
                .extension_states
                .get("unrelated_fixture"),
            Some(&serde_json::json!("keep"))
        );
        assert!(!after
            .conversation
            .unwrap()
            .messages()
            .iter()
            .any(|message| matches!(
                message.id.as_deref(),
                Some("stale-question" | "failed-question")
            )));
        assert!(provider.planner_inputs.lock().unwrap().is_empty());
        return Ok(());
    }
    if matches!(
        case,
        ClarificationCase::NewTask | ClarificationCase::Cancel | ClarificationCase::Ambiguous
    ) {
        let text = match case {
            ClarificationCase::NewTask => "算了，先只分析 README",
            ClarificationCase::Cancel => "取消",
            _ => "继续",
        };
        let user = Message::user()
            .with_id("clarify-alternative")
            .with_text(text);
        let first_resolution = agent
            .prepare_codepro_clarification_input(&session.id, &user, None)
            .await?;
        let second_resolution = agent
            .prepare_codepro_clarification_input(&session.id, &user, None)
            .await?;
        assert!(
            agent
                .codepro_clarification_goal(&session.id, &user)
                .await?
                .is_none(),
            "replacement/cancel/ambiguous input cannot inherit the write goal"
        );
        if case == ClarificationCase::NewTask {
            assert!(matches!(
                first_resolution,
                Some(clarification::ClarificationInput::Proceed)
            ));
            assert!(matches!(
                second_resolution,
                Some(clarification::ClarificationInput::Proceed)
            ));
            agent
                .mark_codepro_clarification_started(&session.id, user.id.as_deref())
                .await?;
            assert!(matches!(
                agent
                    .prepare_codepro_clarification_input(&session.id, &user, None)
                    .await?,
                Some(clarification::ClarificationInput::Notice(_))
            ));
        } else {
            assert!(matches!(
                first_resolution,
                Some(clarification::ClarificationInput::Notice(_))
            ));
            assert!(matches!(
                second_resolution,
                Some(clarification::ClarificationInput::Notice(_))
            ));
            let mut reply = agent.reply_codepro(user, config, None).await?;
            while let Some(event) = reply.next().await {
                event?;
            }
        }
        assert!(provider.planner_inputs.lock().unwrap().is_empty());
        let stored = sessions.get_session(&session.id, true).await?;
        let state =
            crate::agents::codepro_clarification::ClarificationState::read(&stored)?.unwrap();
        assert_eq!(
            state.status,
            if case == ClarificationCase::Ambiguous {
                crate::agents::codepro_clarification::ClarificationStatus::Pending
            } else {
                crate::agents::codepro_clarification::ClarificationStatus::Closed
            }
        );
        assert_eq!(
            stored
                .conversation
                .unwrap()
                .messages()
                .iter()
                .filter(|message| message.id.as_deref() == Some("clarify-alternative"))
                .count(),
            1
        );
        return Ok(());
    }
    if case == ClarificationCase::Reload {
        for _ in 0..8 {
            sessions
                .add_message(
                    &session.id,
                    &Message::assistant()
                        .with_generated_id()
                        .with_text("额外历史记录"),
                )
                .await?;
        }
        sessions = Arc::new(SessionManager::new(temp.path().join("sessions")));
        let mut config = agent.config.clone();
        config.session_manager = sessions.clone();
        agent = Agent::with_config(config);
        agent
            .update_provider(provider.clone(), goose_providers::model::ModelConfig::new("mock-model"), &session.id)
            .await?;
    }
    if matches!(
        case,
        ClarificationCase::AnswerSaveFailure
            | ClarificationCase::StartSaveFailure
            | ClarificationCase::InvalidStoredPlan
    ) {
        let condition = if matches!(
            case,
            ClarificationCase::StartSaveFailure | ClarificationCase::InvalidStoredPlan
        ) {
            " AND json_extract(NEW.extension_data, '$.\"codepro_clarification.v1\".status.started') IS NOT NULL"
        } else {
            ""
        };
        let mut connection = sessions.storage().guarded_connection().await?;
        sqlx::query(&format!("CREATE TRIGGER clarification_fail BEFORE UPDATE OF extension_data ON sessions WHEN NEW.id = '{}'{} BEGIN SELECT RAISE(ABORT, 'injected clarification save failure'); END", session.id, condition))
            .execute(&mut *connection).await?;
    }
    let token = CancellationToken::new();
    let second = agent
        .reply_codepro(
            Message::user().with_id("clarify-answer").with_text("邮箱"),
            config,
            Some(token.clone()),
        )
        .await;
    if case == ClarificationCase::AnswerSaveFailure {
        assert!(
            second.is_err(),
            "failed answer persistence must stop execution"
        );
        assert!(provider.planner_inputs.lock().unwrap().is_empty());
        let persisted = sessions.get_session(&session.id, true).await?;
        assert!(matches!(
            crate::agents::codepro_clarification::ClarificationState::read(&persisted)?
                .unwrap()
                .status,
            crate::agents::codepro_clarification::ClarificationStatus::Pending
        ));
        assert!(!persisted
            .conversation
            .unwrap()
            .messages()
            .iter()
            .any(|message| message.id.as_deref() == Some("clarify-answer")));
        return Ok(());
    }
    let mut second = second?;
    let mut recovery_identity = None;
    if matches!(
        case,
        ClarificationCase::StartSaveFailure | ClarificationCase::InvalidStoredPlan
    ) {
        let failure = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Some(event) = second.next().await {
                if let Err(error) = event {
                    return Ok(error);
                }
            }
            anyhow::bail!("execution should fail when the consumption marker cannot be saved")
        })
        .await??;
        assert!(
            failure
                .to_string()
                .contains("injected clarification save failure"),
            "{failure}"
        );
        drop(second);
        let persisted = sessions.get_session(&session.id, true).await?;
        let prepared =
            crate::agents::codepro_clarification::ClarificationState::read(&persisted)?.unwrap();
        let bound = prepared
            .execution_run_id
            .context("prepared answer requires durable run identity")?;
        let before_recovery = CodeProStateStore::try_default()?.load(&session.id).await?;
        assert_eq!(
            before_recovery.dag.tasks[0].id, "implement",
            "must use the accepted Planner plan, not a host fallback"
        );
        assert!(before_recovery.dag.validate().is_ok());
        if case == ClarificationCase::InvalidStoredPlan {
            let mut invalid = before_recovery.clone();
            invalid
                .dag
                .contracts
                .get_mut("implement")
                .unwrap()
                .write_scope = vec!["./**".into()];
            invalid.dag.contracts.get_mut("verify").unwrap().write_scope =
                vec!["test/.tmp/**".into()];
            assert!(invalid.dag.validate().unwrap_err().contains("重叠"));
            CodeProStateStore::try_default()?.save(&invalid).await?;
        }
        assert_eq!(
            before_recovery.last_active_run_id.as_deref(),
            Some(bound.as_str())
        );
        recovery_identity = Some((
            bound,
            before_recovery.goal,
            provider.planner_inputs.lock().unwrap().len(),
        ));
        assert!(matches!(
            crate::agents::codepro_clarification::ClarificationState::read(&persisted)?
                .unwrap()
                .status,
            crate::agents::codepro_clarification::ClarificationStatus::Prepared { .. }
        ));
        let mut connection = sessions.storage().guarded_connection().await?;
        sqlx::query("DROP TRIGGER clarification_fail")
            .execute(&mut *connection)
            .await?;
        drop(connection);
        second = agent
            .reply_codepro(
                Message::user().with_id("clarify-recover").with_text("继续"),
                SessionConfig {
                    id: session.id.clone(),
                    schedule_id: None,
                    max_turns: Some(4),
                    retry_config: None,
                },
                Some(token.clone()),
            )
            .await?;
    }
    if case == ClarificationCase::InvalidStoredPlan {
        let mut text = String::new();
        let mut terminal = None;
        while let Some(event) = second.next().await {
            if let AgentEvent::Message(message) = event? {
                text.push_str(&message.as_concat_text());
                terminal = message
                    .content
                    .iter()
                    .filter_map(|content| match content {
                        MessageContent::SystemNotification(notification) => {
                            notification.data.as_ref()
                        }
                        _ => None,
                    })
                    .find(|data| data.get("status").is_some())
                    .cloned()
                    .or(terminal);
            }
        }
        assert!(
            text.contains("保留") && text.contains("重叠"),
            "must report the actual recovery blocker: {text}"
        );
        assert!(!text.contains("没有可继续"));
        let terminal =
            terminal.context("blocked recovery requires a structured terminal status")?;
        assert_eq!(terminal["status"], "interrupted");
        assert_eq!(terminal["report"]["outcome"], "paused");
        assert_eq!(terminal["report"]["recovery_action"], "manual_review");
        let (run, goal, count) = recovery_identity.unwrap();
        let after = CodeProStateStore::try_default()?.load(&session.id).await?;
        assert_eq!(after.last_active_run_id.as_deref(), Some(run.as_str()));
        assert_eq!(after.goal, goal);
        assert!(
            after.dag.validate().is_err(),
            "do not silently rewrite an existing plan"
        );
        assert_eq!(provider.planner_inputs.lock().unwrap().len(), count);
        let stored = sessions.get_session(&session.id, true).await?;
        assert!(matches!(
            crate::agents::codepro_clarification::ClarificationState::read(&stored)?
                .unwrap()
                .status,
            crate::agents::codepro_clarification::ClarificationStatus::Prepared { .. }
        ));
        return Ok(());
    }
    let store = CodeProStateStore::try_default()?;
    let observed = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            tokio::select! {
                event = second.next() => {
                    if let Some(event) = event {
                        if let AgentEvent::Message(message) = event? {
                            if !message.as_concat_text().is_empty() { eprintln!("clarification execution event: {}", message.as_concat_text()); }
                        }
                    } else { anyhow::bail!("reply ended before persisting a planned DAG"); }
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {
                    if let Ok(state) = store.load(&session.id).await {
                        let session_state = sessions.get_session(&session.id, true).await?;
                        let started = crate::agents::codepro_clarification::ClarificationState::read(&session_state)?
                            .is_some_and(|state| matches!(state.status, crate::agents::codepro_clarification::ClarificationStatus::Started { .. }));
                        if !state.dag.tasks.is_empty() && started { return Ok(state); }
                    }
                }
            }
        }
    }).await.context("production entry did not reach Planner/DAG")??;
    token.cancel();
    drop(second);
    if case == ClarificationCase::StartedRecovery {
        let before_workers = provider.worker_calls.load(Ordering::SeqCst);
        let before_planner = provider.planner_inputs.lock().unwrap().len();
        let restored = Agent::with_config(agent.config.clone());
        restored
            .update_provider(provider.clone(), goose_providers::model::ModelConfig::new("mock-model"), &session.id)
            .await?;
        let resumed_token = CancellationToken::new();
        let mut resumed = restored
            .reply_codepro(
                Message::user()
                    .with_id("after-start-recover")
                    .with_text("继续"),
                SessionConfig {
                    id: session.id.clone(),
                    schedule_id: None,
                    max_turns: Some(4),
                    retry_config: None,
                },
                Some(resumed_token.clone()),
            )
            .await?;
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                tokio::select! {
                    event = resumed.next() => {
                        if let Some(event) = event { event?; } else { anyhow::bail!("started recovery ended before worker dispatch"); }
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {
                        if provider.worker_calls.load(Ordering::SeqCst) > before_workers { return Ok::<_, anyhow::Error>(()); }
                    }
                }
            }
        }).await??;
        resumed_token.cancel();
        drop(resumed);
        let after = store.load(&session.id).await?;
        assert_eq!(after.last_active_run_id, observed.last_active_run_id);
        assert_eq!(after.goal, observed.goal);
        assert_eq!(
            provider.planner_inputs.lock().unwrap().len(),
            before_planner
        );
    }
    if let Some((run_id, goal, planner_count)) = recovery_identity {
        assert_eq!(
            observed.last_active_run_id.as_deref(),
            Some(run_id.as_str())
        );
        assert_eq!(
            observed.goal, goal,
            "continue must preserve the exact prepared goal"
        );
        assert_eq!(
            provider.planner_inputs.lock().unwrap().len(),
            planner_count,
            "recover the prepared DAG without planning a second run"
        );
    }
    if case == ClarificationCase::Normal {
        let before = provider.planner_inputs.lock().unwrap().len();
        let mut duplicate = agent
            .reply_codepro(
                Message::user().with_id("clarify-answer").with_text("邮箱"),
                SessionConfig {
                    id: session.id.clone(),
                    schedule_id: None,
                    max_turns: Some(4),
                    retry_config: None,
                },
                None,
            )
            .await?;
        let mut text = String::new();
        while let Some(event) = duplicate.next().await {
            if let AgentEvent::Message(message) = event? {
                text.push_str(&message.as_concat_text());
            }
        }
        assert!(text.contains("未重复执行"));
        assert_eq!(provider.planner_inputs.lock().unwrap().len(), before);
        assert!(
            agent
                .prepare_codepro_clarification_input(
                    &session.id,
                    &Message::user().with_id("clarify-answer").with_text("短信"),
                    None
                )
                .await
                .is_err(),
            "same ID with changed content is not a valid replay"
        );
    }
    let planner_inputs = provider.planner_inputs.lock().unwrap().clone();
    assert!(!planner_inputs.is_empty(), "must call the real Planner");
    assert!(planner_inputs.iter().all(|input| input.contains(original))
        && observed.goal.contains(original) && observed.dag.overall_goal.contains(original),
        "original goal absent from production execution: planner={planner_inputs:?}; state={}; dag={}",
        observed.goal, observed.dag.overall_goal);
    assert!(observed.goal.contains("邮箱"));
    assert!(observed.dag.overall_goal.contains("邮箱"));
    assert!(planner_inputs.iter().all(|input| input.contains("邮箱")));
    let history = sessions
        .get_session(&session.id, true)
        .await?
        .conversation
        .unwrap();
    for (id, text) in [("clarify-source", original), ("clarify-answer", "邮箱")] {
        let entries = history
            .messages()
            .iter()
            .filter(|message| message.id.as_deref() == Some(id))
            .collect::<Vec<_>>();
        assert_eq!(
            entries.len(),
            1,
            "real user message must remain separate and unique"
        );
        assert_eq!(entries[0].as_concat_text(), text);
    }
    Ok(())
}

#[tokio::test]
async fn clarification_continuity_answer_reaches_planner_and_dag() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::Normal).await
}

#[tokio::test]
async fn clarification_continuity_reload_preserves_pending_source() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::Reload).await
}

#[tokio::test]
async fn clarification_continuity_answer_save_failure_prevents_execution() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::AnswerSaveFailure).await
}

#[tokio::test]
async fn clarification_continuity_consumption_failure_retains_answer_for_continue() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::StartSaveFailure).await
}

#[tokio::test]
async fn clarification_continuity_new_task_releases_goal_and_consumes_once() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::NewTask).await
}

#[tokio::test]
async fn clarification_continuity_cancel_never_dispatches_the_old_goal() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::Cancel).await
}

#[tokio::test]
async fn clarification_continuity_ambiguous_continue_does_not_choose_an_answer() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::Ambiguous).await
}

#[tokio::test]
async fn clarification_continuity_rejects_foreign_identity_and_workspace() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::IdentityBoundaries).await
}

#[tokio::test]
async fn clarification_continuity_transactions_preserve_other_keys_and_rollback_questions(
) -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::TransactionBoundaries).await
}

#[tokio::test]
async fn clarification_continuity_invalid_saved_plan_reports_blocker_without_replanning(
) -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::InvalidStoredPlan).await
}

#[tokio::test]
async fn clarification_continuity_consumed_answer_survives_interrupted_startup() -> Result<()> {
    run_clarification_continuity_case(ClarificationCase::StartedRecovery).await
}
