use rmcp::model::Tool;

const TAVILY_SEARCH: &str = "tavily_search";
const EXA_SEARCH: &str = "web_search_exa";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WebSearchRoute {
    pub primary: String,
    pub fallback: Option<String>,
}

fn unqualified_name(name: &str) -> &str {
    name.rsplit("__").next().unwrap_or(name)
}

pub(super) fn route(catalog: &[Tool]) -> Option<WebSearchRoute> {
    let find = |expected: &str| {
        catalog
            .iter()
            .find(|tool| unqualified_name(tool.name.as_ref()) == expected)
            .map(|tool| tool.name.to_string())
    };
    let tavily = find(TAVILY_SEARCH);
    let exa = find(EXA_SEARCH);
    match (tavily, exa) {
        (Some(primary), fallback) => Some(WebSearchRoute { primary, fallback }),
        (None, Some(primary)) => Some(WebSearchRoute {
            primary,
            fallback: None,
        }),
        (None, None) => None,
    }
}

pub(super) fn instructions(catalog: &[Tool]) -> String {
    let Some(route) = route(catalog) else {
        return String::new();
    };
    let Some(fallback) = route.fallback else {
        return format!(
            "\n\n# Web search routing\n\nFor live web search, use `{}`. It is the only configured search provider in the current tool catalog.",
            route.primary
        );
    };
    format!(
        "\n\n# Web search routing\n\nFor live web search, call `{primary}` first. Call `{fallback}` at most once with the same query only when `{primary}` is unavailable or returns a missing-configuration, authentication, credit/quota, rate-limit, timeout, transport, service, or empty-result failure. Do not call both providers after a successful result. When fallback occurs, state the provider used and the observable failure category; never expose credentials.",
        primary = route.primary,
        fallback = fallback,
    )
}

pub(super) fn include_fallback(catalog: &[Tool], selected: &mut Vec<String>) {
    let Some(route) = route(catalog) else {
        return;
    };
    let Some(fallback) = route.fallback else {
        return;
    };
    let selected_search = selected
        .iter()
        .any(|name| name == &route.primary || name == &fallback);
    if selected_search {
        selected.retain(|name| name != &route.primary && name != &fallback);
        selected.insert(0, fallback);
        selected.insert(0, route.primary);
        selected.truncate(3);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(name: &str) -> Tool {
        Tool::new(
            name.to_string(),
            "search",
            json!({"type": "object"}).as_object().unwrap().clone(),
        )
    }

    #[test]
    fn tavily_is_primary_and_exa_is_a_single_fallback() {
        let catalog = vec![tool("exa__web_search_exa"), tool("tavily__tavily_search")];
        assert_eq!(
            route(&catalog),
            Some(WebSearchRoute {
                primary: "tavily__tavily_search".to_string(),
                fallback: Some("exa__web_search_exa".to_string()),
            })
        );
        let prompt = instructions(&catalog);
        assert!(prompt.contains("call `tavily__tavily_search` first"));
        assert!(prompt.contains("`exa__web_search_exa` at most once"));
        assert!(prompt.contains("Do not call both providers after a successful result"));
    }

    #[test]
    fn exa_becomes_primary_when_tavily_is_not_configured() {
        let catalog = vec![tool("exa__web_search_exa")];
        assert_eq!(
            route(&catalog),
            Some(WebSearchRoute {
                primary: "exa__web_search_exa".to_string(),
                fallback: None,
            })
        );
        assert!(instructions(&catalog).contains("only configured search provider"));
    }

    #[test]
    fn loading_either_provider_exposes_the_primary_and_fallback_together() {
        let catalog = vec![tool("exa__web_search_exa"), tool("tavily__tavily_search")];
        let mut selected = vec!["exa__web_search_exa".to_string()];
        include_fallback(&catalog, &mut selected);
        assert_eq!(
            selected,
            vec![
                "tavily__tavily_search".to_string(),
                "exa__web_search_exa".to_string()
            ]
        );
    }

    #[test]
    fn provider_pair_keeps_the_three_tool_limit() {
        let catalog = vec![tool("exa__web_search_exa"), tool("tavily__tavily_search")];
        let mut selected = vec![
            "other__read".to_string(),
            "other__extract".to_string(),
            "exa__web_search_exa".to_string(),
        ];
        include_fallback(&catalog, &mut selected);
        assert_eq!(
            selected,
            vec![
                "tavily__tavily_search".to_string(),
                "exa__web_search_exa".to_string(),
                "other__read".to_string(),
            ]
        );
    }
}
