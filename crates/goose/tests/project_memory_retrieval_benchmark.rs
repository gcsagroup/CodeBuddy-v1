//! Opt-in evaluation of the real memory tool, with isolated storage and external cases.
use goose::agents::extension::PlatformExtensionContext;
use goose::agents::mcp_client::McpClientTrait;
use goose::agents::{ProjectMemoryClient, ToolCallContext};
use goose::session::SessionManager;
use rmcp::model::{CallToolResult, RawContent};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

fn client(root: &Path) -> ProjectMemoryClient {
    ProjectMemoryClient::new_with_root(
        PlatformExtensionContext {
            extension_manager: None,
            session_manager: Arc::new(SessionManager::new(root.join("sessions"))),
            session: None,
            use_login_shell_path: false,
        },
        root.join("memory"),
    )
    .unwrap()
}

fn data(result: CallToolResult) -> Value {
    assert_ne!(
        result.is_error,
        Some(true),
        "memory tool failed: {result:?}"
    );
    match &result.content[0].raw {
        RawContent::Text(text) => serde_json::from_str(&text.text).unwrap(),
        _ => panic!("expected JSON text"),
    }
}

async fn call(
    client: &ProjectMemoryClient,
    ctx: &ToolCallContext,
    name: &str,
    args: Value,
) -> Value {
    data(
        client
            .call_tool(
                ctx,
                name,
                Some(args.as_object().unwrap().clone()),
                CancellationToken::new(),
            )
            .await
            .unwrap(),
    )
}

#[tokio::test]
#[ignore = "requires CODEBUDDY_MEMORY_EVAL_INPUT and CODEBUDDY_MEMORY_EVAL_OUTPUT"]
async fn evaluate_real_memory_retrieval() {
    let input = std::env::var("CODEBUDDY_MEMORY_EVAL_INPUT").unwrap();
    let output = std::env::var("CODEBUDDY_MEMORY_EVAL_OUTPUT").unwrap();
    let fixture: Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("project-a");
    let b = dir.path().join("project-b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let ctx = ToolCallContext::new("memory-eval-a".into(), Some(a.clone()), None);
    let ctx_b = ToolCallContext::new("memory-eval-b".into(), Some(b), None);
    let api = client(dir.path());
    let mut receipts = vec![];
    for entry in fixture["memories"]
        .as_array()
        .unwrap()
        .iter()
        .chain(fixture["updates"].as_array().unwrap())
    {
        let start = Instant::now();
        let receipt = call(&api, &ctx, "project_memory_remember", json!({"kind":"project_rule","subject":entry["subject"],"content":entry["content"],"confidence":"high","reason":"User authorized isolated memory evaluation"})).await;
        receipts.push(json!({"subject":entry["subject"],"id":receipt["entry"]["id"],"created":receipt["created"],"elapsed_ms":start.elapsed().as_secs_f64()*1000.0}));
    }
    let foreign = &fixture["crossProject"];
    call(&api, &ctx_b, "project_memory_remember", json!({"kind":"project_rule","subject":foreign["subject"],"content":foreign["content"],"confidence":"high","reason":"User authorized project isolation evaluation"})).await;
    drop(api);
    let api = client(dir.path()); // A fresh client must read committed storage.
    let mut cases = vec![];
    for case in fixture["cases"].as_array().unwrap() {
        let start = Instant::now();
        let result = call(
            &api,
            &ctx,
            "project_memory_search",
            json!({"query":case["query"],"limit":5}),
        )
        .await;
        let subjects: Vec<_> = result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["subject"].clone())
            .collect();
        cases.push(json!({"id":case["id"],"kind":case["kind"],"query":case["query"],"expected":case["expected"],"subjects":subjects,"result":result,"elapsed_ms":start.elapsed().as_secs_f64()*1000.0}));
    }
    let isolation = call(
        &api,
        &ctx,
        "project_memory_search",
        json!({"query":"ORANGE-4826","limit":5}),
    )
    .await;
    assert_eq!(isolation["returned_count"], 0, "cross-project leak");
    let updated = call(
        &api,
        &ctx,
        "project_memory_search",
        json!({"query":"release_window","limit":5}),
    )
    .await;
    assert_eq!(updated["returned_count"], 1);
    assert!(updated["entries"][0]["content"]
        .as_str()
        .unwrap()
        .contains("周五上午十点"));
    let original = receipts
        .iter()
        .find(|r| r["subject"] == "release_window")
        .unwrap();
    assert_eq!(updated["entries"][0]["id"], original["id"]);
    let report = json!({"system":"CodeBuddy project_memory","cases":cases,"writes":receipts,"controls":{"project_isolation":true,"restart_persistence":true,"stable_subject_update":true},"update_result":updated});
    std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    // Retrieval quality is measured against the external oracle, not asserted to
    // match today's implementation. A missed paraphrase remains a benchmark miss.
}
