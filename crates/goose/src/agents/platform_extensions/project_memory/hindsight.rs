//! Optional MCP index. Local records remain the only source of recalled content.
use super::*;
use rmcp::{model::CallToolRequestParams, transport::StreamableHttpClientTransport, ServiceExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration as StdDuration;

const CONFIG_KEY: &str = "CODEPRO_HINDSIGHT_URL";
static JOBS: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct Index {
    base: String,
    bank: String,
    root: PathBuf,
    workspace: PathBuf,
}

impl Index {
    fn configured(root: &Path, workspace: &Path) -> Option<Self> {
        let base = crate::config::Config::global()
            .get_param::<String>(CONFIG_KEY)
            .ok()?;
        Self::new(root, workspace, &base).ok()
    }

    fn new(root: &Path, workspace: &Path, base: &str) -> Result<Self> {
        let url = reqwest::Url::parse(base)?;
        // This first integration is explicitly local. Never send project memories to an
        // arbitrary endpoint, redirect, credential-bearing URL, or default shared bank.
        anyhow::ensure!(
            url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url.path() == "/",
            "Expected a loopback Hindsight base URL"
        );
        let identity = project_identity(workspace).map_err(anyhow::Error::msg)?;
        let root_identity = project_identity(root).map_err(anyhow::Error::msg)?;
        let bank = format!(
            "codebuddy-{}",
            blake3::hash(format!("{root_identity}:{identity}").as_bytes()).to_hex()
        );
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            bank,
            root: root.to_owned(),
            workspace: workspace.to_owned(),
        })
    }

    fn key(&self) -> String {
        format!("{}/{}", self.base, self.bank)
    }

    fn entries(&self) -> Result<Vec<ProjectMemoryEntry>> {
        let (_, entries) = ProjectMemoryClient::admin_list(&self.root, &self.workspace, false)
            .map_err(anyhow::Error::msg)?;
        Ok(entries
            .into_iter()
            .filter(|entry| entry.scope == "project" && is_recallable(entry, &self.workspace))
            .collect())
    }

    async fn call(&self, name: &str, args: Value, timeout: StdDuration) -> Result<Value> {
        let uri = if name == "create_bank" {
            format!("{}/mcp/", self.base)
        } else {
            format!("{}/mcp/{}/", self.base, self.bank)
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let transport = StreamableHttpClientTransport::with_client(
            client,
            rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(
                uri,
            ),
        );
        tokio::time::timeout(timeout, async {
            let service = ().serve(transport).await?;
            let result = service
                .call_tool(
                    CallToolRequestParams::new(name.to_owned())
                        .with_arguments(args.as_object().cloned().unwrap_or_default()),
                )
                .await;
            let _ = service.cancel().await;
            let result = result?;
            anyhow::ensure!(
                result.is_error != Some(true),
                "Hindsight tool returned an error"
            );
            let text = result
                .content
                .iter()
                .filter_map(|item| item.as_text())
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            anyhow::ensure!(
                text.len() <= 256 * 1024,
                "Hindsight result exceeds index budget"
            );
            let value = serde_json::from_str::<Value>(&text)?;
            validate_response(name, &value)?;
            Ok::<_, anyhow::Error>(value)
        })
        .await
        .map_err(|_| anyhow::anyhow!("Hindsight request timed out"))?
    }

    async fn sync(&self) -> Result<()> {
        self.call(
            "create_bank",
            json!({"bank_id":self.bank}),
            StdDuration::from_secs(10),
        )
        .await?;
        let entries = self.entries()?;
        let desired = entries
            .iter()
            .map(|entry| (document_id(entry), entry))
            .collect::<HashMap<_, _>>();
        let mut existing = HashSet::new();
        for page in 0..20 {
            let response = self
                .call(
                    "list_documents",
                    json!({"limit":100,"offset":page * 100}),
                    StdDuration::from_secs(10),
                )
                .await?;
            let documents = response
                .get("items")
                .or_else(|| response.get("documents"))
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("Missing document list"))?;
            for document in documents {
                let id = document
                    .get("id")
                    .or_else(|| document.get("document_id"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("Missing document identity"))?;
                anyhow::ensure!(
                    id.starts_with("cb-"),
                    "Unexpected document in managed memory bank"
                );
                existing.insert(id.to_owned());
            }
            if documents.len() < 100 {
                break;
            }
            anyhow::ensure!(page < 19, "Managed index exceeds document budget");
        }
        // Delete obsolete revisions before retaining replacements. Even if this fails,
        // search validates every hit against the fresh local revision and cannot revive it.
        for id in existing.iter().filter(|id| !desired.contains_key(*id)) {
            self.call(
                "delete_document",
                json!({"document_id":id}),
                StdDuration::from_secs(15),
            )
            .await?;
        }
        for (id, entry) in desired.iter().filter(|(id, _)| !existing.contains(*id)) {
            self.call("sync_retain", json!({"document_id":id,"content":entry.content,"context":"User-authorized CodeBuddy project memory","metadata":{"local_id":entry.id},"tags":["codebuddy-project"]}), StdDuration::from_secs(90)).await?;
        }
        Ok(())
    }
}

fn validate_response(name: &str, value: &Value) -> Result<()> {
    anyhow::ensure!(
        value.get("error").is_none()
            && value.get("status").and_then(Value::as_str) != Some("error"),
        "Hindsight operation failed"
    );
    if name == "sync_retain" {
        anyhow::ensure!(
            value.get("status").and_then(Value::as_str) == Some("completed"),
            "Hindsight retention did not complete"
        );
    }
    if name == "recall" {
        anyhow::ensure!(
            value.get("results").and_then(Value::as_array).is_some(),
            "Missing Hindsight recall results"
        );
    }
    Ok(())
}

fn document_id(entry: &ProjectMemoryEntry) -> String {
    let revision = blake3::hash(
        serde_json::to_string(entry)
            .expect("serializable memory")
            .as_bytes(),
    );
    format!("cb-{}-{}", entry.id, revision.to_hex())
}

pub(super) fn schedule(root: &Path, workspace: &Path) {
    if !project_memory_enabled() {
        return;
    }
    let Some(index) = Index::configured(root, workspace) else {
        return;
    };
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let key = index.key();
    {
        let mut jobs = JOBS.lock().expect("index jobs lock");
        if let Some(revision) = jobs.get_mut(&key) {
            *revision += 1;
            return;
        }
        jobs.insert(key.clone(), 0);
    }
    runtime.spawn(async move {
        loop {
            let revision = *JOBS.lock().expect("index jobs lock").get(&key).expect("active job");
            if !project_memory_enabled() || Index::configured(&index.root, &index.workspace).is_none_or(|current| current.key() != key) {
                JOBS.lock().expect("index jobs lock").remove(&key);
                break;
            }
            match index.sync().await {
                Ok(()) => {
                    let mut jobs = JOBS.lock().expect("index jobs lock");
                    if jobs.get(&key) == Some(&revision) { jobs.remove(&key); break; }
                }
                Err(_) => {
                    tracing::warn!("Optional project memory index unavailable; local memory remains authoritative; synchronization will retry");
                    tokio::time::sleep(StdDuration::from_secs(30)).await;
                }
            }
        }
    });
}

fn selected_entries<'a>(
    response: &Value,
    current: &'a [ProjectMemoryEntry],
) -> Vec<&'a ProjectMemoryEntry> {
    let by_document = current
        .iter()
        .map(|entry| (document_id(entry), entry))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    response
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|hit| {
            let id = hit.get("document_id")?.as_str()?;
            let entry = *by_document.get(id)?;
            seen.insert(entry.id.clone()).then_some(entry)
        })
        .collect()
}

pub(super) async fn search(
    client: &ProjectMemoryClient,
    ctx: &ToolCallContext,
    arguments: Option<JsonObject>,
    cancel: CancellationToken,
) -> std::result::Result<CallToolResult, String> {
    let params: SearchParams = parse_arguments(arguments.clone())?;
    let local = client.search(ctx, arguments)?; // Validate the same public contract first.
    let workspace = working_directory(ctx)?;
    let Some(index) = Index::configured(&client.root, &workspace) else {
        return Ok(local);
    };
    schedule(&client.root, &workspace);
    search_indexed(client, ctx, params, local, &index, cancel).await
}

async fn search_indexed(
    client: &ProjectMemoryClient,
    ctx: &ToolCallContext,
    params: SearchParams,
    local: CallToolResult,
    index: &Index,
    cancel: CancellationToken,
) -> std::result::Result<CallToolResult, String> {
    let workspace = working_directory(ctx)?;
    let Some(query) = params
        .query
        .as_deref()
        .filter(|query| !query.trim().is_empty())
    else {
        return Ok(local);
    };
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err("Memory search cancelled".to_owned()),
        response = index.call("recall", json!({"query":query,"budget":"mid","max_tokens":2000,"types":["world","experience"]}), StdDuration::from_millis(1500)) => response,
    };
    let Ok(response) = response else {
        let mut local = client.search(
            ctx,
            Some(
                json!({"query":params.query,"kinds":params.kinds,"limit":params.limit})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )?;
        local.content.push(Content::text("Semantic index unavailable; these are local text matches only. No semantic result was verified."));
        return Ok(local);
    };
    // Re-read after the network wait: deletions, expiry and edits may have happened meanwhile.
    let (_, current) = ProjectMemoryClient::admin_list(&client.root, &workspace, false)?;
    let current = current
        .into_iter()
        .filter(|entry| {
            is_recallable(entry, &workspace)
                && (params.kinds.is_empty() || params.kinds.contains(&entry.kind))
        })
        .collect::<Vec<_>>();
    let query = query.to_lowercase();
    let mut entries = current
        .iter()
        .filter(|entry| memory_entry_matches(entry, &query))
        .cloned()
        .collect::<Vec<_>>();
    let mut ids = entries
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<HashSet<_>>();
    for entry in selected_entries(&response, &current) {
        if entry.scope == "project" && ids.insert(entry.id.clone()) {
            entries.push(entry.clone());
        }
    }
    let matched_count = entries.len();
    entries.truncate(params.limit.unwrap_or(20));
    let mut result = bounded_search_result(SearchResult {
        matched_count,
        returned_count: entries.len(),
        truncated: matched_count > entries.len(),
        entries,
    })?;
    result.content.push(Content::text("Includes local text matches and revision-verified semantic candidates. Similarity is not proof that a candidate answers the question; cite local evidence and say unknown when it does not."));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(
        root: &Path,
        workspace: &Path,
        value: &str,
    ) -> (ProjectMemoryClient, ToolCallContext, ProjectMemoryEntry) {
        let client = ProjectMemoryClient::from_root_with_personalization(root, false);
        let ctx =
            ToolCallContext::new("index-test".to_owned(), Some(workspace.to_path_buf()), None);
        client.remember(&ctx, Some(json!({"kind":"project_rule","subject":"release","content":value,"confidence":"high","reason":"User authorized test"}).as_object().unwrap().clone())).unwrap();
        let entry = ProjectMemoryClient::admin_list(root, workspace, false)
            .unwrap()
            .1
            .remove(0);
        (client, ctx, entry)
    }

    #[test]
    fn hindsight_candidates_cannot_revive_deleted_or_old_revisions_or_replace_local_text() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (_, _, old) = seed(root.path(), workspace.path(), "周三发布");
        let (_, _, current) = seed(root.path(), workspace.path(), "周五发布");
        let result = json!({"results":[
            {"document_id":document_id(&old),"text":"周三发布"},
            {"document_id":document_id(&current),"text":"Injected text"},
            {"document_id":document_id(&current),"text":"duplicate"},
            {"document_id":"another-project","text":"foreign"}
        ]});
        let selected = selected_entries(&result, std::slice::from_ref(&current));
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].content, "周五发布");
        assert!(selected_entries(&result, &[]).is_empty());
    }

    #[tokio::test]
    async fn hindsight_connection_failure_returns_local_matches() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (client, ctx, _) = seed(root.path(), workspace.path(), "周五发布");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let index =
            Index::new(root.path(), workspace.path(), &format!("http://{address}")).unwrap();
        let args = json!({"query":"发布"}).as_object().unwrap().clone();
        let local = client.search(&ctx, Some(args.clone())).unwrap();
        let expected = local.content[0].as_text().unwrap().text.clone();
        let result = search_indexed(
            &client,
            &ctx,
            parse_arguments(Some(args)).unwrap(),
            local,
            &index,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.content[0].as_text().unwrap().text, expected);
        assert!(result.content[1]
            .as_text()
            .unwrap()
            .text
            .contains("unavailable"));
        assert_ne!(result.is_error, Some(true));
    }

    #[tokio::test]
    #[ignore = "Requires the user-authorized local Hindsight evaluation service"]
    async fn hindsight_live_roundtrip_update_delete_and_isolation() {
        let root = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let (client, ctx, _) = seed(root.path(), a.path(), "松果项目每周三下午三点发布。");
        let index = Index::new(root.path(), a.path(), "http://127.0.0.1:18988").unwrap();
        index.sync().await.unwrap();
        let recall = |query: &str| json!({"query":query,"budget":"mid","max_tokens":1000,"types":["world","experience"]});
        let result = index
            .call(
                "recall",
                recall("松果计划哪天上线？"),
                StdDuration::from_secs(10),
            )
            .await
            .unwrap();
        assert_eq!(
            selected_entries(&result, &index.entries().unwrap()).len(),
            1
        );
        let (_, _, current) = seed(root.path(), a.path(), "松果项目每周五上午十点发布。");
        assert!(selected_entries(&result, &index.entries().unwrap()).is_empty());
        index.sync().await.unwrap();
        let result = index
            .call(
                "recall",
                recall("松果计划哪天上线？"),
                StdDuration::from_secs(10),
            )
            .await
            .unwrap();
        assert_eq!(
            selected_entries(&result, &index.entries().unwrap())[0].content,
            current.content
        );
        let other = Index::new(root.path(), b.path(), "http://127.0.0.1:18988").unwrap();
        other.sync().await.unwrap();
        let foreign = other
            .call("recall", recall("松果项目"), StdDuration::from_secs(10))
            .await
            .unwrap();
        assert!(foreign["results"].as_array().unwrap().is_empty());
        client
            .forget(
                &ctx,
                Some(json!({"id":current.id}).as_object().unwrap().clone()),
            )
            .unwrap();
        index.sync().await.unwrap();
        let documents = index
            .call(
                "list_documents",
                json!({"limit":100}),
                StdDuration::from_secs(10),
            )
            .await
            .unwrap();
        assert_eq!(documents["total"].as_u64(), Some(0));
    }

    #[test]
    fn hindsight_embedded_failures_are_not_successful_sync_or_empty_recall() {
        for value in [
            json!({"status":"error","message":"Fact extraction failed"}),
            json!({"error":"Bank unavailable"}),
            json!({"status":"accepted"}),
        ] {
            assert!(validate_response("sync_retain", &value).is_err());
            assert!(validate_response("recall", &value).is_err());
        }
        assert!(validate_response(
            "sync_retain",
            &json!({"status":"completed","memory_ids":["a"]})
        )
        .is_ok());
        assert!(validate_response("recall", &json!({"results":[]})).is_ok());
    }

    #[test]
    fn hindsight_bank_isolated_by_project_and_profile_and_rejects_remote_urls() {
        let root = tempfile::tempdir().unwrap();
        let other_root = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let make = |root: &Path, workspace: &Path| {
            Index::new(root, workspace, "http://127.0.0.1:18988")
                .unwrap()
                .bank
        };
        assert_eq!(make(root.path(), a.path()), make(root.path(), a.path()));
        assert_ne!(make(root.path(), a.path()), make(root.path(), b.path()));
        assert_ne!(
            make(root.path(), a.path()),
            make(other_root.path(), a.path())
        );
        for url in [
            "https://example.com",
            "http://user:pass@127.0.0.1",
            "http://127.0.0.1/mcp/shared/",
            "http://127.0.0.1?token=secret",
        ] {
            assert!(Index::new(root.path(), a.path(), url).is_err());
        }
    }
}
