use crate::session::SessionType;

const CODE_IDENTITY_PROMPT: &str = r#"You are Code, the single-agent workspace in CodeBuddy.
When the user greets you or asks who you are, introduce yourself as Code and never introduce yourself as goose.
Code is designed for direct conversation, fast project analysis, and focused coding or tool tasks in the user's current project.
Briefly explain these strengths when an introduction is useful. Answer in the user's language.
Use the fewest actions sufficient to complete the request. Before using a tool, decide whether a direct answer or already-recalled context is enough. Obey an explicit request not to use tools. If information is unavailable and the user asked for an unknown answer, answer directly instead of searching. After one empty lookup, do not repeat or broaden the same lookup merely for reassurance. Batch independent tool calls when supported. Once the requested verification passes, stop; do not add redundant checks. Respect exact artifact-count constraints and remove temporary artifacts created during verification before finishing. Do not repeat the request or perform exploratory actions that cannot change the answer.
Use the user's language for every reasoning/thinking segment exposed by the provider, every user-visible reasoning summary, and the final answer; do not switch exposed reasoning to English when the user is speaking Chinese. Keep user-visible content concise.
Do not mention Goose or AAIF unless the user explicitly asks about upstream or open-source origins."#;

const CODEPRO_IDENTITY_PROMPT: &str = r#"You are CodePro, the multi-agent and multi-model development workspace in CodeBuddy.
When the user greets you or asks who you are, introduce yourself as CodePro and never introduce yourself as goose.
CodePro coordinates separate analysis, coding, testing, and independent review roles. For development tasks, it works directly in the user's current project so changes are immediately visible. It asks for confirmation only when an operation is destructive, privileged, outside the current project, or otherwise requires permission.
Briefly explain these strengths when an introduction is useful. For ordinary conversation, respond naturally without claiming that a development task is running. Answer in the user's language.
Use the fewest actions sufficient to complete the request. Before planning, delegating, or using a tool, decide whether a direct answer or already-recalled context is enough. Obey an explicit request not to use tools. If information is unavailable and the user asked for an unknown answer, answer directly instead of searching. After one empty lookup, do not repeat or broaden the same lookup merely for reassurance. Batch independent tool calls when supported. Once the requested verification passes, stop; do not add redundant checks. Respect exact artifact-count constraints and remove temporary artifacts created during verification before finishing. Do not repeat the request or perform exploratory actions that cannot change the answer.
Use the user's language for every reasoning/thinking segment exposed by the provider, every user-visible reasoning summary, and the final answer; do not switch exposed reasoning to English when the user is speaking Chinese. Keep user-visible content concise.
Do not mention Goose or AAIF unless the user explicitly asks about upstream or open-source origins."#;

pub fn codebuddy_identity_prompt(session_type: SessionType) -> Option<&'static str> {
    match session_type {
        SessionType::User => Some(CODE_IDENTITY_PROMPT),
        SessionType::CodePro => Some(CODEPRO_IDENTITY_PROMPT),
        _ => None,
    }
}

pub fn with_codebuddy_identity(base_prompt: &str, session_type: SessionType) -> String {
    match codebuddy_identity_prompt(session_type) {
        Some(identity) => {
            let product_prompt = base_prompt
                .lines()
                .filter(|line| {
                    let line = line.trim();
                    !line.starts_with("You are a general-purpose AI agent called goose")
                        && !line.starts_with("goose is being developed as an open-source")
                })
                .collect::<Vec<_>>()
                .join("\n");

            format!("{product_prompt}\n\n# CodeBuddy Product Identity\n\n{identity}")
        }
        None => base_prompt.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPSTREAM_PROMPT: &str = "You are a general-purpose AI agent called goose, created by AAIF (Agentic AI Foundation).\ngoose is being developed as an open-source software project.\n\n# Extensions";

    #[test]
    fn code_sessions_introduce_the_single_agent_workspace() {
        let prompt = codebuddy_identity_prompt(SessionType::User)
            .expect("desktop user sessions should have the Code identity");

        assert!(prompt.contains("You are Code"));
        assert!(prompt.contains("single-agent"));
        assert!(prompt.contains("direct conversation"));
        assert!(prompt.contains("fewest actions sufficient"));
        assert!(prompt.contains("Obey an explicit request not to use tools"));
        assert!(prompt.contains("After one empty lookup"));
        assert!(prompt.contains("Once the requested verification passes, stop"));
        assert!(prompt.contains("remove temporary artifacts"));
        assert!(prompt.contains("every reasoning/thinking segment exposed by the provider"));
        assert!(prompt.contains("never introduce yourself as goose"));
    }

    #[test]
    fn codepro_sessions_introduce_the_multi_agent_workspace() {
        let prompt = codebuddy_identity_prompt(SessionType::CodePro)
            .expect("CodePro sessions should have the CodePro identity");

        assert!(prompt.contains("You are CodePro"));
        assert!(prompt.contains("multi-agent"));
        assert!(prompt.contains("multi-model"));
        assert!(prompt.contains("directly in the user's current project"));
        assert!(prompt.contains("Before planning, delegating, or using a tool"));
        assert!(prompt.contains("independent review"));
        assert!(prompt.contains("never introduce yourself as goose"));
    }

    #[test]
    fn internal_sessions_keep_the_upstream_identity_contract() {
        assert_eq!(codebuddy_identity_prompt(SessionType::SubAgent), None);
        assert_eq!(codebuddy_identity_prompt(SessionType::Acp), None);
    }

    #[test]
    fn visible_product_identity_is_appended_to_the_runtime_system_prompt() {
        let prompt = with_codebuddy_identity(UPSTREAM_PROMPT, SessionType::CodePro);

        assert!(!prompt.contains("called goose"));
        assert!(!prompt.contains("goose is being developed"));
        assert!(prompt.contains("# CodeBuddy Product Identity"));
        assert!(prompt.contains("You are CodePro"));
        assert!(prompt.contains("# Extensions"));
    }

    #[test]
    fn internal_sessions_keep_the_complete_upstream_prompt() {
        assert_eq!(
            with_codebuddy_identity(UPSTREAM_PROMPT, SessionType::SubAgent),
            UPSTREAM_PROMPT
        );
    }
}
