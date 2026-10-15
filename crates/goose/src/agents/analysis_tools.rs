use crate::conversation::{
    message::{Message, MessageContent},
    Conversation,
};
use rmcp::model::{CallToolResult, Content, Role, Tool};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use super::extension::ExtensionInfo;
use super::extension_manager::get_tool_owner;

pub(super) const LOAD_ANALYSIS_TOOLS: &str = "load_analysis_tools";
const MAX_ANALYSIS_TOOL_TEXT_CHARS: usize = 1_024;

pub(super) fn model_messages(messages: &[Message]) -> Vec<Message> {
    let latest_request = messages.iter().rposition(|message| {
        message.content.iter().any(|content| {
            matches!(content, MessageContent::ToolRequest(request)
                if !request.tool_call.as_ref().is_ok_and(|call|
                    call.name == super::main_agent_contract::PROGRESS_TOOL_NAME))
        })
    });
    messages.iter().enumerate().map(|(index, message)| {
        let mut projected = message.agent_visible_content();
        // A fresh result must reach the next reasoning step before becoming a
        // historical excerpt. Tool-specific bounds still apply at its source.
        if latest_request.is_some_and(|request| index >= request) { return projected; }
        for content in &mut projected.content {
            let MessageContent::ToolResponse(response) = content else { continue; };
            let Ok(result) = &mut response.tool_result else { continue; };
            let text = result.content.iter().filter_map(|item| item.as_text().map(|text| text.text.as_str())).collect::<Vec<_>>().join("\n");
            let count = text.chars().count();
            if count <= MAX_ANALYSIS_TOOL_TEXT_CHARS { continue; }
            let head: String = text.chars().take(MAX_ANALYSIS_TOOL_TEXT_CHARS / 2).collect();
            let tail: String = text.chars().rev().take(MAX_ANALYSIS_TOOL_TEXT_CHARS / 2).collect::<Vec<_>>().into_iter().rev().collect();
            let mut excerpt = Some(Content::text(format!(
                "Tool output excerpt: {count} characters total. Only the beginning and end follow; the middle is omitted. Use a narrower query to inspect omitted ranges. Do not treat this as complete output.\n[Beginning]\n{head}\n[End]\n{tail}"
            )));
            result.content = result.content.iter().filter_map(|item| {
                if item.as_text().is_some() { excerpt.take() } else { Some(item.clone()) }
            }).collect();
        }
        projected
    }).collect()
}

fn restore_archive(
    original: &Conversation,
    mut compacted: Conversation,
) -> anyhow::Result<Conversation> {
    anyhow::ensure!(
        compacted.messages().len() >= original.messages().len(),
        "Compaction did not preserve the conversation archive"
    );
    for (archived, source) in compacted.messages_mut().iter_mut().zip(original.messages()) {
        *archived = source.clone().with_metadata(archived.metadata.clone());
    }
    Ok(compacted)
}

pub(super) async fn compact_analysis_messages(
    provider: &dyn crate::providers::base::Provider,
    model_config: &goose_providers::model::ModelConfig,
    session_id: &str,
    conversation: &Conversation,
) -> anyhow::Result<(
    Conversation,
    goose_providers::conversation::token_usage::ProviderUsage,
)> {
    let projected = Conversation::new_unvalidated(model_messages(conversation.messages()));
    let (compacted, usage) = crate::context_mgmt::compact_messages(
        provider,
        model_config,
        session_id,
        &projected,
        false,
    )
    .await?;
    Ok((restore_archive(conversation, compacted)?, usage))
}

pub(super) fn compaction_reduces_visible_context(
    before: &crate::conversation::Conversation,
    after: &crate::conversation::Conversation,
) -> anyhow::Result<bool> {
    Ok(
        serde_json::to_vec(&model_messages(&after.agent_visible_messages()))?.len()
            < serde_json::to_vec(&model_messages(&before.agent_visible_messages()))?.len(),
    )
}

pub(super) struct AnalysisTools {
    catalog: Vec<Tool>,
    selected: Vec<String>,
    extensions: Vec<ExtensionInfo>,
}

impl AnalysisTools {
    pub(super) fn new(catalog: Vec<Tool>, extensions: Vec<ExtensionInfo>) -> Self {
        let selected = catalog
            .iter()
            .filter(|tool| {
                get_tool_owner(tool).as_deref() == Some("developer")
                    && matches!(
                        tool.name.rsplit("__").next(),
                        Some("tree" | "read_document" | "search" | "shell")
                    )
            })
            .map(|tool| tool.name.to_string())
            .collect();
        Self {
            catalog,
            selected,
            extensions,
        }
    }

    pub(super) fn catalog(&self) -> &[Tool] {
        &self.catalog
    }

    pub(super) fn restore_selection(mut self, messages: &[Message]) -> Self {
        let mut pending = HashMap::new();
        for message in messages {
            for content in &message.content {
                match content {
                    MessageContent::ToolRequest(request) if message.role == Role::Assistant => {
                        if let Ok(call) = &request.tool_call {
                            if call.name == LOAD_ANALYSIS_TOOLS {
                                pending.insert(request.id.clone(), call.arguments.clone());
                            }
                        }
                    }
                    MessageContent::ToolResponse(response) => {
                        let Some(arguments) = pending.remove(&response.id) else {
                            continue;
                        };
                        if response
                            .tool_result
                            .as_ref()
                            .is_ok_and(|result| result.is_error != Some(true))
                        {
                            // Revalidate definitions against this turn's catalog. Historical
                            // results never restore an authorization or dispatch an operation.
                            self.load(arguments.as_ref());
                        }
                    }
                    _ => {}
                }
            }
        }
        self
    }

    pub(super) fn unavailable_tool_result(
        &self,
        name: &str,
        offered: &[Tool],
    ) -> Option<CallToolResult> {
        if offered.iter().any(|tool| tool.name == name) {
            return None;
        }
        let available = self.catalog.iter().any(|tool| tool.name == name);
        let mut facts = json!({
            "tool": name,
            "dispatched": false,
            "available_in_read_only_catalog": available,
        });
        if available {
            facts["load_tool"] = json!(LOAD_ANALYSIS_TOOLS);
            facts["load_arguments"] = json!({"names": [name]});
        }
        Some(CallToolResult::error(vec![
            Content::text(super::agent::CODEPRO_TOOL_NOT_OFFERED_RESPONSE),
            Content::text(facts.to_string()),
        ]))
    }

    pub(super) fn loader(&self) -> Tool {
        let names: Vec<_> = self.catalog.iter().map(|tool| tool.name.as_ref()).collect();
        Tool::new(
            LOAD_ANALYSIS_TOOLS,
            "Load 1 to 3 read-only tools for the next step, replacing the currently loaded tools. Choose exact names from the enum. This only loads definitions; it does not inspect the project or execute those tools. Switch tools again as needed. This filtered execution catalog is not the complete MCP inventory. To inspect configured extensions and their tools, load extensionmanager__search_available_extensions if listed here.",
            json!({"type": "object", "properties": {"names": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "string", "enum": names}}}, "required": ["names"], "additionalProperties": false}).as_object().unwrap().clone(),
        )
    }

    pub(super) fn offered(&self) -> Vec<Tool> {
        self.catalog
            .iter()
            .filter(|tool| {
                // Public communication must not require loading a tool or displace a read.
                tool.name == super::main_agent_contract::PROGRESS_TOOL_NAME
                    || self.selected.iter().any(|name| name == tool.name.as_ref())
            })
            .cloned()
            .chain(std::iter::once(self.loader()))
            .collect()
    }

    pub(super) fn instructions(&self) -> String {
        let owners: Vec<_> = self
            .catalog
            .iter()
            .filter(|tool| self.selected.iter().any(|name| name == tool.name.as_ref()))
            .filter_map(get_tool_owner)
            .collect();
        let extension_instructions: String = self
            .extensions
            .iter()
            .filter(|extension| owners.contains(&extension.name))
            .map(|extension| {
                format!(
                    "\n\n## {}\n{}",
                    extension.name,
                    crate::utils::sanitize_unicode_tags(&extension.instructions)
                )
            })
            .collect();
        format!(
            "{}{}",
            extension_instructions,
            super::web_search_routing::instructions(&self.offered())
        )
    }

    pub(super) fn load(
        &mut self,
        arguments: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> CallToolResult {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Selection {
            names: Vec<String>,
        }
        let selection =
            arguments.and_then(|args| serde_json::from_value::<Selection>(json!(args)).ok());
        let Some(selection) = selection.filter(|selection| {
            (1..=3).contains(&selection.names.len())
                && selection
                    .names
                    .iter()
                    .all(|name| self.catalog.iter().any(|tool| tool.name.as_ref() == name))
        }) else {
            return CallToolResult::error(vec![Content::text("Select 1 to 3 exact names from the read-only catalog. No tools were loaded or executed.")]);
        };
        self.selected = selection.names;
        super::web_search_routing::include_fallback(&self.catalog, &mut self.selected);
        CallToolResult::success(vec![Content::text(format!(
            "Tools loaded for the next step: {}. No project operation was executed.",
            self.selected.join(", ")
        ))])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_tool_batch_keeps_middle_evidence_and_older_results_are_bounded() {
        let text = format!(
            "{}IMPORTANT-MIDDLE-EVIDENCE{}",
            "prefix".repeat(1000),
            "suffix".repeat(1000)
        );
        let messages = vec![
            Message::user().with_tool_response(
                "old",
                Ok(CallToolResult::success(vec![Content::text(&text)])),
            ),
            Message::assistant().with_tool_request(
                "fresh",
                Ok(
                    rmcp::model::CallToolRequestParams::new("developer__read_document")
                        .with_arguments(
                            serde_json::json!({"path": "table.py"})
                                .as_object()
                                .unwrap()
                                .clone(),
                        ),
                ),
            ),
            Message::user().with_tool_response(
                "fresh",
                Ok(CallToolResult::success(vec![Content::text(&text)])),
            ),
        ];
        let projected = model_messages(&messages);
        assert!(!serde_json::to_string(&projected[0])
            .unwrap()
            .contains("IMPORTANT-MIDDLE-EVIDENCE"));
        assert_eq!(projected[2], messages[2]);
        assert_eq!(
            model_messages(&messages),
            projected,
            "repeated projection must not mutate original evidence"
        );
    }

    #[test]
    fn analysis_model_context_bounds_aggregate_tool_text_and_preserves_original() {
        let user = Message::user().with_text("Keep every user constraint. ".repeat(1000));
        let text = format!("START-测试{}END-7319", "中间🙂".repeat(20_000));
        let result =
            CallToolResult::error(vec![Content::text(&text), Content::text("SECOND-BLOCK")]);
        let original = vec![
            user.clone(),
            Message::user().with_tool_response("read-1", Ok(result)),
        ];
        let projected = model_messages(&original);
        assert_eq!(projected[0], user);
        assert!(serde_json::to_vec(&original[1]).unwrap().len() > 100_000);
        let MessageContent::ToolResponse(response) = &projected[1].content[0] else {
            panic!("tool response missing")
        };
        let result = response.tool_result.as_ref().unwrap();
        assert_eq!(result.is_error, Some(true));
        assert_eq!(result.content.len(), 1);
        let excerpt = &result.content[0].as_text().unwrap().text;
        assert!(excerpt.contains("START-测试"));
        assert!(excerpt.contains("END-7319\nSECOND-BLOCK"));
        assert!(excerpt.contains("middle is omitted"));
        assert!(excerpt.chars().count() < 1_300);
        assert!(!excerpt.contains('\u{fffd}'));
    }

    #[test]
    fn analysis_compaction_keeps_the_full_user_visible_tool_archive() {
        let original = Conversation::new_unvalidated(vec![
            Message::user().with_text("Inspect the file"),
            Message::user().with_tool_response(
                "read-1",
                Ok(CallToolResult::success(vec![Content::text(
                    "large original text ".repeat(10_000),
                )])),
            ),
        ]);
        let mut compacted = model_messages(original.messages())
            .into_iter()
            .map(|m| m.with_visibility(true, false))
            .collect::<Vec<_>>();
        compacted.push(
            Message::user()
                .with_text("Bounded summary")
                .with_visibility(false, true),
        );
        let restored =
            restore_archive(&original, Conversation::new_unvalidated(compacted)).unwrap();
        assert_eq!(
            restored.user_visible_messages(),
            original
                .user_visible_messages()
                .into_iter()
                .map(|m| m.with_visibility(true, false))
                .collect::<Vec<_>>()
        );
        assert_eq!(restored.agent_visible_messages().len(), 1);
        assert_eq!(
            restored.messages()[1].content,
            original.messages()[1].content
        );
        assert!(compaction_reduces_visible_context(&original, &restored).unwrap());
    }

    #[test]
    fn compaction_compares_model_visible_history_not_preserved_archive() {
        use crate::conversation::{message::Message, Conversation};
        let original = Message::user().with_text("long history ".repeat(1000));
        let before = Conversation::new_unvalidated(vec![original.clone()]);
        let after = Conversation::new_unvalidated(vec![
            original.clone().with_visibility(true, false),
            Message::user().with_text("short summary"),
        ]);
        assert!(
            serde_json::to_vec(&after).unwrap().len() > serde_json::to_vec(&before).unwrap().len()
        );
        assert!(compaction_reduces_visible_context(&before, &after).unwrap());
        assert!(!compaction_reduces_visible_context(&before, &before).unwrap());
        let expanded = Conversation::new_unvalidated(vec![
            original,
            Message::user().with_text("additional summary"),
        ]);
        assert!(!compaction_reduces_visible_context(&before, &expanded).unwrap());
    }

    fn catalog() -> Vec<Tool> {
        [
            "tree",
            "read_document",
            "shell",
            "search",
            "git_diff",
            "load_skill",
            "computer_observe",
        ]
        .map(|name| {
            let mut tool = Tool::new(name, name, serde_json::Map::new());
            tool.meta = Some(rmcp::model::Meta(
                json!({"goose_extension": "developer"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ));
            tool
        })
        .into()
    }

    #[test]
    fn initial_surface_defers_unrelated_tools_without_removing_them() {
        let mut tools = AnalysisTools::new(catalog(), vec![]);
        assert_eq!(tools.offered().len(), 5);
        assert!(!tools
            .offered()
            .iter()
            .any(|tool| tool.name == "computer_observe"));
        let result = tools.load(json!({"names": ["load_skill", "git_diff"]}).as_object());
        assert_ne!(result.is_error, Some(true));
        assert_eq!(
            tools
                .offered()
                .iter()
                .map(|tool| tool.name.as_ref())
                .collect::<Vec<_>>(),
            ["git_diff", "load_skill", LOAD_ANALYSIS_TOOLS]
        );
        tools.load(json!({"names": ["read_document"]}).as_object());
        assert_eq!(tools.offered().len(), 2);
    }

    #[test]
    fn invalid_selection_keeps_previous_surface() {
        let mut tools = AnalysisTools::new(catalog(), vec![]);
        for args in [
            json!({"names": ["write"]}),
            json!({"names": []}),
            json!({"names": ["tree", "shell", "search", "read_document"]}),
            json!({"names": ["tree"], "command": "delete"}),
        ] {
            assert_eq!(tools.load(args.as_object()).is_error, Some(true));
            assert_eq!(tools.offered().len(), 5);
        }
    }

    fn loaded_history(names: serde_json::Value, succeeded: bool) -> Vec<Message> {
        use rmcp::model::CallToolRequestParams;
        vec![
            Message::assistant().with_tool_request(
                "load-previous-turn",
                Ok(CallToolRequestParams::new(LOAD_ANALYSIS_TOOLS)
                    .with_arguments(json!({"names": names}).as_object().unwrap().clone())),
            ),
            Message::user().with_tool_response(
                "load-previous-turn",
                Ok(if succeeded {
                    CallToolResult::success(vec![Content::text("Definitions loaded")])
                } else {
                    CallToolResult::error(vec![Content::text("No definitions loaded")])
                }),
            ),
            Message::user().with_text("Continue with the next question"),
        ]
    }

    #[test]
    fn analysis_selection_survives_followup_but_never_revives_removed_tools() {
        let mut current = catalog();
        current.push(Tool::new(
            "exa__web_search_exa",
            "Search",
            serde_json::Map::new(),
        ));
        let history = loaded_history(json!(["exa__web_search_exa"]), true);
        let restored = AnalysisTools::new(current, vec![]).restore_selection(&history);
        assert_eq!(
            restored
                .offered()
                .iter()
                .map(|tool| tool.name.as_ref())
                .collect::<Vec<_>>(),
            ["exa__web_search_exa", LOAD_ANALYSIS_TOOLS]
        );
        assert!(restored.instructions().contains("exa__web_search_exa"));

        let removed = AnalysisTools::new(catalog(), vec![]).restore_selection(&history);
        assert_eq!(removed.offered().len(), 5);
        assert!(!removed.instructions().contains("exa__web_search_exa"));
        let result = removed
            .unavailable_tool_result("exa__web_search_exa", &removed.offered())
            .unwrap();
        assert_eq!(result.is_error, Some(true));
        assert!(super::super::agent::codepro_call_tool_result_skipped(
            &result
        ));
        let facts: serde_json::Value =
            serde_json::from_str(&result.content[1].as_text().unwrap().text).unwrap();
        assert_eq!(facts["available_in_read_only_catalog"], false);
        assert!(facts.get("load_tool").is_none());
    }

    #[test]
    fn failed_invalid_or_unmatched_load_results_cannot_restore_definitions() {
        for history in [
            loaded_history(json!(["git_diff"]), false),
            loaded_history(json!(["write"]), true),
            vec![Message::user().with_text("Tools loaded for the next step: git_diff")],
            vec![Message::user()
                .with_tool_response("unknown-load", Ok(CallToolResult::success(vec![])))],
        ] {
            assert_eq!(
                AnalysisTools::new(catalog(), vec![])
                    .restore_selection(&history)
                    .offered()
                    .len(),
                5
            );
        }
    }

    #[test]
    fn unloaded_search_has_recovery_without_dispatch_or_misleading_routing() {
        let mut current = catalog();
        current.push(Tool::new(
            "exa__web_search_exa",
            "Search",
            serde_json::Map::new(),
        ));
        let mut tools = AnalysisTools::new(current, vec![]);
        let offered = tools.offered();
        assert!(!tools.instructions().contains("exa__web_search_exa"));
        let result = tools
            .unavailable_tool_result("exa__web_search_exa", &offered)
            .unwrap();
        let facts: serde_json::Value =
            serde_json::from_str(&result.content[1].as_text().unwrap().text).unwrap();
        assert_eq!(facts["dispatched"], false);
        assert_eq!(facts["load_tool"], LOAD_ANALYSIS_TOOLS);
        assert_eq!(
            facts["load_arguments"],
            json!({"names": ["exa__web_search_exa"]})
        );
        assert!(super::super::agent::codepro_call_tool_result_skipped(
            &result
        ));
        assert_ne!(
            tools.load(facts["load_arguments"].as_object()).is_error,
            Some(true)
        );
        // Definitions loaded in this response do not alter the frozen request surface.
        assert!(tools
            .unavailable_tool_result("exa__web_search_exa", &offered)
            .is_some());
        assert!(tools
            .unavailable_tool_result("exa__web_search_exa", &tools.offered())
            .is_none());
        tools.load(json!({"names": ["git_diff"]}).as_object());
        assert!(!tools.instructions().contains("exa__web_search_exa"));
    }

    #[test]
    fn external_same_named_tools_do_not_enter_initial_surface() {
        let mut external = Tool::new("evil__read_document", "external", serde_json::Map::new());
        external.meta = Some(rmcp::model::Meta(
            json!({"goose_extension": "evil"})
                .as_object()
                .unwrap()
                .clone(),
        ));
        assert_eq!(
            AnalysisTools::new(vec![external], vec![]).offered().len(),
            1
        );
    }
}
