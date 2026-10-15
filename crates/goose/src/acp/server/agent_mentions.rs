use super::*;
use crate::session::Session;
use goose_sdk_types::custom_requests::{AgentMention, SourceEntry, SourceType};
use std::collections::HashSet;

fn add_session_subrecipes(
    session: &Session,
    sources: &mut Vec<SourceEntry>,
    seen: &mut HashSet<String>,
) {
    let Some(sub_recipes) = session
        .recipe
        .as_ref()
        .and_then(|recipe| recipe.sub_recipes.as_ref())
    else {
        return;
    };

    for sub_recipe in sub_recipes {
        if !seen.insert(sub_recipe.name.clone()) {
            continue;
        }

        sources.push(SourceEntry {
            source_type: SourceType::Subrecipe,
            name: sub_recipe.name.clone(),
            description: sub_recipe.description.clone().unwrap_or_default(),
            content: String::new(),
            path: sub_recipe.path.clone(),
            global: false,
            writable: true,
            supporting_files: Vec::new(),
            properties: std::collections::HashMap::new(),
        });
    }
}

impl GooseAcpAgent {
    pub(super) async fn on_list_agent_mentions(
        &self,
        req: ListAgentMentionsRequest,
    ) -> Result<ListAgentMentionsResponse, agent_client_protocol::Error> {
        let session_id = req
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
            .ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data("sessionId is required before scanning workspace mentions")
            })?;
        let _workspace_access = self
            .acquire_session_dispatch_access(session_id, true)
            .await?;
        let session = self
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {}", session_id))
            })?;

        if let Some(requested) = req
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            if std::path::Path::new(requested) != session.working_dir {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("cwd cannot override the persisted session workspace"));
            }
        }
        let cwd = session.working_dir.clone();

        let filesystem_sources =
            crate::agents::platform_extensions::summon::discover_filesystem_sources(&cwd);
        let mut sources = Vec::new();
        let mut seen = HashSet::new();

        add_session_subrecipes(&session, &mut sources, &mut seen);

        for source in filesystem_sources {
            if seen.insert(source.name.clone()) {
                sources.push(source);
            }
        }

        let agents = sources
            .into_iter()
            .filter(|source| {
                matches!(
                    source.source_type,
                    SourceType::Agent | SourceType::Recipe | SourceType::Subrecipe
                ) && (matches!(
                    source.source_type,
                    SourceType::Recipe | SourceType::Subrecipe
                ) || !source.content.is_empty())
            })
            .map(|source| {
                let mention = format!("@{}", source.name);
                AgentMention {
                    name: source.name,
                    description: source.description,
                    source_type: source.source_type,
                    source_path: (!source.path.is_empty()).then_some(source.path),
                    mention,
                }
            })
            .collect();

        Ok(ListAgentMentionsResponse { agents })
    }
}
