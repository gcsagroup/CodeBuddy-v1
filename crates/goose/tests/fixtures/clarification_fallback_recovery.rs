#[test]
fn clarification_continuity_change_fallback_passes_resume_contract_validation() -> Result<()> {
    let mut dag = codepro_bounded_workspace_fallback_dag(
        "为当前项目实现用户已确认的通知渠道，并验证行为",
        CodeProWorkflow::Change,
    );
    dag.ensure_action_budget(CodeProTaskKind::ComplexChange)
        .map_err(anyhow::Error::msg)?;
    dag.validate().map_err(anyhow::Error::msg)?;
    LegacyReadyAdapter::validate(&dag)?;
    assert_eq!(dag.tasks[0].role, AgentRole::Coder);
    assert_eq!(dag.tasks[1].role, AgentRole::Tester);
    assert_eq!(dag.tasks[1].depends_on, vec![dag.tasks[0].id.clone()]);
    Ok(())
}

#[test]
fn clarification_continuity_test_fallback_retains_isolated_artifact_scope() -> Result<()> {
    let mut dag =
        codepro_bounded_workspace_fallback_dag("运行项目测试并报告结果", CodeProWorkflow::Test);
    dag.ensure_action_budget(CodeProTaskKind::ProjectTest)
        .map_err(anyhow::Error::msg)?;
    dag.validate().map_err(anyhow::Error::msg)?;
    assert_eq!(dag.tasks.len(), 1);
    assert_eq!(dag.tasks[0].role, AgentRole::Tester);
    assert_eq!(
        dag.contracts[&dag.tasks[0].id].write_scope,
        vec![
            "test/.tmp/**",
            "tests/.tmp/**",
            "test/tmp/**",
            "tests/tmp/**"
        ]
    );
    Ok(())
}

#[test]
fn clarification_continuity_change_fallback_allows_validation_but_denies_source_edits() -> Result<()>
{
    use crate::agents::tool_execution::CodeProWorkspaceWriteGuard;
    let workspace = tempfile::tempdir()?;
    std::fs::write(workspace.path().join("source.js"), "original source")?;
    std::fs::write(workspace.path().join("tests.js"), "const fs=require('node:fs');fs.mkdirSync('test/.tmp',{recursive:true});fs.writeFileSync('test/.tmp/result.json',JSON.stringify({passed:true}));")?;
    let dag = codepro_bounded_workspace_fallback_dag(
        "实现已确认的通知渠道并运行测试",
        CodeProWorkflow::Change,
    );
    let contract = &dag.contracts["host-fallback-verify"];
    let scope = CodeProTaskScope::new_bound(
        "fallback-scope-run",
        "host-fallback-verify",
        workspace.path(),
        contract.read_scope.clone(),
        contract.write_scope.clone(),
    )
    .map_err(anyhow::Error::msg)?;
    let arguments = serde_json::json!({"command":"node tests.js"});
    let guard = CodeProWorkspaceWriteGuard::prepare(
        Some(&scope),
        Some(workspace.path()),
        false,
        "developer",
        "shell",
        arguments.as_object(),
    )
    .map_err(|error| anyhow::anyhow!("{}", error.message()))?
    .unwrap();
    let before = guard
        .before_execution()
        .map_err(|error| anyhow::anyhow!("{}", error.message()))?;
    let status = std::process::Command::new("node")
        .arg("tests.js")
        .current_dir(workspace.path())
        .status()?;
    assert!(status.success());
    guard
        .after_execution(before)
        .map_err(|error| anyhow::anyhow!("{}", error.message()))?;
    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(
        workspace.path().join("test/.tmp/result.json"),
    )?)?;
    assert_eq!(result["passed"], true);
    let edit = serde_json::json!({"path":"source.js"});
    assert!(CodeProWorkspaceWriteGuard::prepare(
        Some(&scope),
        Some(workspace.path()),
        false,
        "developer",
        "edit",
        edit.as_object()
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("source.js"))?,
        "original source"
    );
    Ok(())
}
