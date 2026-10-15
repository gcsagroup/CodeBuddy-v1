#[cfg(windows)]
#[derive(
    Debug, Clone, serde::Serialize, serde::Deserialize, agent_client_protocol::JsonRpcRequest,
)]
#[request(method = "_goose/unstable/workspace/lease/acquire", response = ContinuationLeaseResponse)]
#[serde(rename_all = "camelCase")]
struct ContinuationLeaseRequest {
    requested_path: String,
    expected_state: String,
    expected_identity: String,
}

#[cfg(windows)]
#[derive(
    Debug, Clone, serde::Serialize, serde::Deserialize, agent_client_protocol::JsonRpcResponse,
)]
#[serde(rename_all = "camelCase")]
struct ContinuationLeaseResponse {
    lease_id: String,
}

#[test]
fn clarification_continuity_acp_plain_continue_keeps_interrupted_run_identity() {
    run_test_isolated_storage(async {
        use agent_client_protocol::schema::v1::{
            ContentBlock, LoadSessionRequest, PromptRequest, TextContent,
        };
        use base64::Engine;
        use goose::agents::agent_role::{CodeProRiskAssessment, CodeProTaskKind};
        use goose::agents::codepro_intent::CodeProWorkflow;
        use goose::agents::control_plane::{CodeProRuntime, RuntimeModePolicy};
        use goose::agents::protocol::{ControlCommand, RunId};
        use goose::agents::task_dag::{HostVerificationContractV1, HostVerificationMatchModeV1};
        use goose::agents::{
            AgentRole, CodeProRunState, CodeProRunStatus, CodeProStateStore,
            CodeProWorkspaceDescriptor, ModelRouterConfig, TaskDAG, TaskNode, TaskStatus,
        };
        use sha2::{Digest, Sha256};

        let data_root = tempfile::tempdir().unwrap();
        for durable_state in ["cancelled", "paused"] {
            let cwd = tempfile::tempdir().unwrap();
            std::fs::write(cwd.path().join("channel.txt"), b"sms").unwrap();
            std::fs::write(
                cwd.path().join("package.json"),
                r#"{"name":"continuation-fixture","private":true,"scripts":{"test":"node --test"}}"#,
            ).unwrap();
            let conn = new_connection(data_root.path()).await;
            #[cfg(windows)]
            let meta = {
                let requested = cwd.path().to_string_lossy().into_owned();
                let lease = conn
                    .cx()
                    .send_request(ContinuationLeaseRequest {
                        expected_identity: requested.replace('/', "\\").to_lowercase(),
                        requested_path: requested,
                        expected_state: "non-empty-directory".into(),
                    })
                    .block_task()
                    .await
                    .unwrap();
                serde_json::json!({"workspaceMode":"codepro","workspaceBinding":"writable_project","workspaceLeaseId":lease.lease_id})
            };
            #[cfg(not(windows))]
            let meta = serde_json::json!({"workspaceMode":"codepro"});
            let session = conn
                .cx()
                .send_request(
                    NewSessionRequest::new(cwd.path().to_path_buf())
                        .meta(meta.as_object().unwrap().clone()),
                )
                .block_task()
                .await
                .unwrap();
            let session_id = session.session_id.0.to_string();
            let manager = SessionManager::new(data_root.path().to_path_buf());
            let source = Message::user()
                .with_id("original-source")
                .with_text("只读验证通知渠道内容，先问我是短信还是邮箱");
            let question = Message::assistant()
                .with_id("original-question")
                .with_text("短信还是邮箱？");
            let answer = Message::user().with_id("original-answer").with_text("短信");
            for message in [&source, &question, &answer] {
                manager.add_message(&session_id, message).await.unwrap();
            }
            let goal = format!(
                "原始用户目标：\n{}\n\n需要澄清的问题：\n{}\n\n用户对该问题的回答：\n{}",
                source.as_concat_text(),
                question.as_concat_text(),
                answer.as_concat_text()
            );
            let run_id = RunId::new(format!("run-original-{durable_state}")).unwrap();
            let digest = |bytes: &[u8]| {
                Sha256::digest(bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            };
            let link = |message: &Message| serde_json::json!({"id":message.id, "content_sha256":digest(&serde_json::to_vec(&message.content).unwrap())});
            let mut persisted = manager.get_session(&session_id, false).await.unwrap();
            persisted.extension_data.extension_states.insert("codepro_clarification.v1".into(), serde_json::json!({
                "session_id":session_id, "workspace":cwd.path().canonicalize().unwrap(),
                "source":link(&source), "question":link(&question), "previous_answers":[],
                "last_input":null, "execution_run_id":run_id.as_str(), "status":{"started":{"answer":link(&answer)}}
            }));
            manager
                .update(&session_id)
                .extension_data(persisted.extension_data)
                .apply()
                .await
                .unwrap();
            let mut dag = TaskDAG::new(
                &goal,
                vec![TaskNode {
                    id: "verify-original".into(),
                    name: "验证原通知渠道".into(),
                    description: "运行测试，使用宿主精确字节契约只读核对 channel.txt 的已授权字节"
                        .into(),
                    role: AgentRole::Tester,
                    depends_on: vec![],
                    acceptance_criteria: "宿主验证内容精确等于 sms".into(),
                    status: TaskStatus::Pending,
                    output: None,
                    retry_count: 0,
                }],
            );
            let contract = dag.contracts.get_mut("verify-original").unwrap();
            contract.write_scope.clear();
            contract.read_scope = vec!["channel.txt".into()];
            contract.host_verification = Some(HostVerificationContractV1 {
                schema_version: 1,
                match_mode: HostVerificationMatchModeV1::ExactBytes,
                artifact_relative_path: "channel.txt".into(),
                expected_bytes_base64: base64::prelude::BASE64_STANDARD.encode(b"sms"),
                expected_sha256: digest(b"sms"),
            });
            dag.configure_action_budget(CodeProTaskKind::ProjectTest)
                .unwrap();
            dag.risk_assessment = Some(CodeProRiskAssessment::conservative_for_task_kind(
                CodeProTaskKind::ProjectTest,
            ));
            dag.action_budget_states
                .get_mut("verify-original")
                .unwrap()
                .turns_consumed = 2;
            dag.validate().unwrap();
            let now = chrono::Utc::now();
            let state = CodeProRunState {
                run_id: session_id.clone(),
                goal: goal.clone(),
                source_repo: cwd.path().to_path_buf(),
                worktree_path: cwd.path().to_path_buf(),
                workspace: Some(CodeProWorkspaceDescriptor::direct(cwd.path().to_path_buf())),
                status: CodeProRunStatus::Running,
                pause_reason: None,
                workflow: Some(CodeProWorkflow::Test),
                last_active_run_id: Some(run_id.to_string()),
                dag,
                router_config: ModelRouterConfig::default(),
                reviewer_action_budget: None,
                review_result: None,
                final_report: None,
                created_at: now,
                updated_at: now,
            };
            let store = CodeProStateStore::try_default().unwrap();
            store.save(&state).await.unwrap();
            let control_root = data_root.path().join("runs/control-plane");
            let runtime = CodeProRuntime::initialize_production(
                &control_root,
                RuntimeModePolicy::parse(Some("durable")),
            )
            .await
            .unwrap();
            runtime
                .create_or_verify_run(&session_id, run_id.clone(), &goal)
                .await
                .unwrap();
            std::fs::write(control_root.join(run_id.as_str()).join("binding.v1.json"), serde_json::to_vec(&serde_json::json!({
                "schemaVersion":1,"sessionId":session_id,"runId":run_id.as_str(),
                "coordinator":{"requestedMode":"shadow","effectiveMode":"shadow","qualification":"not_required","reason":"isolated historical ACP binding"}
            })).unwrap()).unwrap();
            let command = if durable_state == "cancelled" {
                ControlCommand::EmergencyStop {
                    run_id: run_id.clone(),
                    reason: "historical interrupted host validation".into(),
                }
            } else {
                ControlCommand::PauseRun {
                    run_id: run_id.clone(),
                    reason: "historical paused host validation".into(),
                }
            };
            runtime.control(&session_id, command, None).await.unwrap();
            drop(conn);
            let conn = new_connection(data_root.path()).await;
            conn.cx()
                .send_request(LoadSessionRequest::new(
                    session.session_id.clone(),
                    cwd.path(),
                ))
                .block_task()
                .await
                .unwrap();
            let result = tokio::time::timeout(std::time::Duration::from_secs(30), conn.cx().send_request(
                PromptRequest::new(session.session_id.clone(),vec![ContentBlock::Text(TextContent::new("继续"))]).meta(
                    serde_json::json!({"codebuddy/source-message-id":"different-continue-id"}).as_object().unwrap().clone()
                )
            ).block_task()).await.expect("actual ACP continuation must terminate");
            let current = store.load(&session_id).await.unwrap();
            assert_eq!(
                current.last_active_run_id.as_deref(),
                Some(run_id.as_str()),
                "actual ACP continuation replaced the original run; response: {result:?}"
            );
            assert_eq!(current.goal, goal);
            let projection = runtime
                .snapshot(&session_id, &run_id)
                .await
                .unwrap()
                .projection;
            assert_eq!(projection.goal, goal);
            assert_eq!(
                std::fs::read_dir(&control_root)
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter_map(|e| std::fs::read(e.path().join("binding.v1.json")).ok())
                    .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                    .filter(|binding| binding["sessionId"] == session_id)
                    .count(),
                1,
                "continuation must not register a new goal"
            );
            assert_eq!(
                current.dag.action_budget_states["verify-original"].turns_consumed,
                2
            );
            assert_eq!(
                std::fs::read(cwd.path().join("channel.txt")).unwrap(),
                b"sms"
            );
            result.expect("verified continuation must execute through ACP");
            assert_eq!(
                current.status,
                CodeProRunStatus::Completed,
                "tasks: {:?}; report: {:?}; durable: {:?}",
                current.dag.tasks,
                current.final_report,
                projection
            );
            assert_eq!(current.dag.tasks[0].status, TaskStatus::Done);
            let completed_sequence = projection.last_sequence;
            let completed_state = serde_json::to_value(&current).unwrap();
            conn.cx().send_request(PromptRequest::new(session.session_id.clone(), vec![ContentBlock::Text(TextContent::new("继续"))]).meta(
                serde_json::json!({"codebuddy/source-message-id":"continue-after-completion"}).as_object().unwrap().clone()
            )).block_task().await.expect("completed continuation must explain its state");
            assert_eq!(
                runtime
                    .snapshot(&session_id, &run_id)
                    .await
                    .unwrap()
                    .projection
                    .last_sequence,
                completed_sequence,
                "completed continuation must not dispatch or revise the run"
            );
            assert_eq!(
                serde_json::to_value(store.load(&session_id).await.unwrap()).unwrap(),
                completed_state
            );
            let history = manager.get_session(&session_id, true).await.unwrap();
            let messages = history.conversation.as_ref().unwrap().messages();
            for id in [
                "original-source",
                "original-question",
                "original-answer",
                "different-continue-id",
                "continue-after-completion",
            ] {
                assert_eq!(
                    messages
                        .iter()
                        .filter(|message| message.id.as_deref() == Some(id))
                        .count(),
                    1
                );
            }
            assert!(messages.iter().any(|message| message
                .as_concat_text()
                .contains("原任务已经完成，没有待继续的步骤")));
            assert_eq!(
                history.extension_data.extension_states["codepro_clarification.v1"]
                    ["execution_run_id"],
                run_id.as_str()
            );

            let other_workspace = tempfile::tempdir().unwrap();
            let mut foreign = current.clone();
            foreign.source_repo = other_workspace.path().to_path_buf();
            foreign.worktree_path = other_workspace.path().to_path_buf();
            foreign.workspace = Some(CodeProWorkspaceDescriptor::direct(
                other_workspace.path().to_path_buf(),
            ));
            store.save(&foreign).await.unwrap();
            assert!(
                conn.cx()
                    .send_request(PromptRequest::new(
                        session.session_id.clone(),
                        vec![ContentBlock::Text(TextContent::new("继续"))]
                    ))
                    .block_task()
                    .await
                    .is_err(),
                "foreign workspace must not resume"
            );
            let foreign_id = RunId::new(format!("run-foreign-{durable_state}")).unwrap();
            runtime
                .create_or_verify_run("another-session", foreign_id.clone(), &goal)
                .await
                .unwrap();
            foreign = current.clone();
            foreign.last_active_run_id = Some(foreign_id.to_string());
            store.save(&foreign).await.unwrap();
            assert!(
                conn.cx()
                    .send_request(PromptRequest::new(
                        session.session_id.clone(),
                        vec![ContentBlock::Text(TextContent::new("继续"))]
                    ))
                    .block_task()
                    .await
                    .is_err(),
                "foreign session binding must not resume"
            );
            assert_eq!(
                runtime
                    .snapshot(&session_id, &run_id)
                    .await
                    .unwrap()
                    .projection
                    .last_sequence,
                completed_sequence
            );
            assert_eq!(
                serde_json::to_value(store.load(&session_id).await.unwrap()).unwrap(),
                serde_json::to_value(foreign).unwrap()
            );
            store.save(&current).await.unwrap();
        }
    });
}
