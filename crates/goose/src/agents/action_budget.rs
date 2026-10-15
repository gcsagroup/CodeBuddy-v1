use crate::agents::agent_role::CodeProTaskKind;
use crate::agents::extension_manager::trusted_workspace_versions_from_result;
use crate::conversation::message::{ToolRequest, ToolResponse};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const UNCHANGED_EFFECTS_BEFORE_COMPLETION_CHECKPOINT: u8 = 2;

pub(crate) type SharedActionBudgetReport = Arc<Mutex<Option<ActionBudgetReport>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeProActionBudgetPolicy {
    initial_turns: usize,
    extension_turns: usize,
    hard_limit_turns: usize,
    finalization_reserve_turns: usize,
    timeout_seconds: u64,
}

pub const ACTION_BUDGET_FINALIZATION_INSTRUCTION: &str = "# CodePro action-budget finalization\n\nThe host has reserved the remaining turns for finalization. Do not call, request, discover, or recommend any tool. Produce a non-empty user-visible final answer now; a reasoning-only response is invalid. Report only: completed work, concrete evidence, incomplete work, and the exact way to continue.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionBudgetDecision {
    Execute,
    Finalize,
    Exhausted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SuccessfulToolEffect {
    Material([u8; 32]),
    Neutral,
    Unknown,
}

pub(crate) fn classify_successful_tool_effect(
    request: &ToolRequest,
    response: &ToolResponse,
) -> SuccessfulToolEffect {
    let Ok(tool_call) = request.tool_call.as_ref() else {
        return SuccessfulToolEffect::Unknown;
    };
    let Ok(tool_result) = response.tool_result.as_ref() else {
        return SuccessfulToolEffect::Unknown;
    };
    let tool_kind = tool_call
        .name
        .rsplit_once("__")
        .map_or(tool_call.name.as_ref(), |(_, tool_name)| tool_name);
    if matches!(tool_kind, "poll" | "wait" | "status") {
        return SuccessfulToolEffect::Neutral;
    }
    // A result's shape (or a file's size) cannot identify its contents. Consume
    // the versions captured by the execution boundary, never model/tool prose.
    let Some(versions) =
        trusted_workspace_versions_from_result(tool_result).filter(|versions| !versions.is_empty())
    else {
        return SuccessfulToolEffect::Unknown;
    };
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"codeagentpro:workspace-versions:v3\0");
    if serde_json::to_writer(&mut hasher, &versions).is_err() {
        return SuccessfulToolEffect::Unknown;
    }
    SuccessfulToolEffect::Material(*hasher.finalize().as_bytes())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionBudgetConfig {
    pub current_limit_turns: usize,
    pub extension_turns: usize,
    pub hard_limit_turns: usize,
    pub finalization_reserve_turns: usize,
    pub extension_used: bool,
    pub successful_action_seen: bool,
    pub last_successful_effect_fingerprint: Option<[u8; 32]>,
    pub consecutive_unchanged_effects: u8,
    pub completion_checkpoint_requested: bool,
    pub completion_checkpoint_used: bool,
    pub turns_consumed: usize,
}

impl ActionBudgetConfig {
    pub const fn from_policy(policy: CodeProActionBudgetPolicy) -> Self {
        Self {
            current_limit_turns: policy.initial_turns(),
            extension_turns: policy.extension_turns(),
            hard_limit_turns: policy.hard_limit_turns(),
            finalization_reserve_turns: policy.finalization_reserve_turns(),
            extension_used: false,
            successful_action_seen: false,
            last_successful_effect_fingerprint: None,
            consecutive_unchanged_effects: 0,
            completion_checkpoint_requested: false,
            completion_checkpoint_used: false,
            turns_consumed: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionBudgetReport {
    pub current_limit_turns: usize,
    pub turns_taken: usize,
    pub extension_used: bool,
    pub successful_action_seen: bool,
    pub last_successful_effect_fingerprint: Option<[u8; 32]>,
    pub consecutive_unchanged_effects: u8,
    pub completion_checkpoint_requested: bool,
    pub completion_checkpoint_used: bool,
    pub finalization_started: bool,
    pub exhausted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionBudgetTracker {
    turns_consumed_before_attempt: usize,
    approved_turns_this_attempt: usize,
    current_limit_turns: usize,
    extension_turns: usize,
    hard_limit_turns: usize,
    finalization_reserve_turns: usize,
    extension_used: bool,
    successful_action_seen: bool,
    last_successful_effect: Option<[u8; 32]>,
    consecutive_unchanged_effects: u8,
    completion_checkpoint_requested: bool,
    finalization_started: bool,
    finalization_retry_used: bool,
    exhausted: bool,
}

impl ActionBudgetTracker {
    pub fn from_policy(policy: CodeProActionBudgetPolicy, configured_cap: usize) -> Self {
        Self::from_config(ActionBudgetConfig::from_policy(policy), configured_cap)
    }

    pub fn from_config(config: ActionBudgetConfig, configured_cap: usize) -> Self {
        let configured_cap = configured_cap.max(1);
        let current_limit_turns = config.current_limit_turns.min(configured_cap);
        let hard_limit_turns = config.hard_limit_turns.min(configured_cap);
        Self {
            turns_consumed_before_attempt: config.turns_consumed,
            approved_turns_this_attempt: 0,
            current_limit_turns,
            extension_turns: config
                .extension_turns
                .min(hard_limit_turns.saturating_sub(current_limit_turns)),
            hard_limit_turns,
            finalization_reserve_turns: config.finalization_reserve_turns.min(current_limit_turns),
            extension_used: config.extension_used,
            successful_action_seen: config.successful_action_seen,
            last_successful_effect: config.last_successful_effect_fingerprint,
            consecutive_unchanged_effects: config.consecutive_unchanged_effects,
            completion_checkpoint_requested: config.completion_checkpoint_requested,
            finalization_started: config.completion_checkpoint_used,
            finalization_retry_used: false,
            exhausted: false,
        }
    }

    pub fn prepare_turn(&mut self, turn: usize) -> ActionBudgetDecision {
        let attempt_turn = turn;
        let turn = self
            .turns_consumed_before_attempt
            .saturating_add(attempt_turn);
        if self.finalization_started {
            self.exhausted = true;
            return ActionBudgetDecision::Exhausted;
        }

        if turn > self.current_limit_turns {
            self.exhausted = true;
            return ActionBudgetDecision::Exhausted;
        }

        if self.completion_checkpoint_requested {
            self.finalization_started = true;
            self.approved_turns_this_attempt = self.approved_turns_this_attempt.max(attempt_turn);
            return ActionBudgetDecision::Finalize;
        }

        let enters_finalization = turn
            > self
                .current_limit_turns
                .saturating_sub(self.finalization_reserve_turns);
        if enters_finalization
            && !self.extension_used
            && self.successful_action_seen
            && self.extension_turns > 0
        {
            self.current_limit_turns = self
                .current_limit_turns
                .saturating_add(self.extension_turns)
                .min(self.hard_limit_turns);
            self.extension_used = true;
        }

        if turn
            > self
                .current_limit_turns
                .saturating_sub(self.finalization_reserve_turns)
        {
            self.finalization_started = true;
            self.approved_turns_this_attempt = self.approved_turns_this_attempt.max(attempt_turn);
            ActionBudgetDecision::Finalize
        } else {
            self.approved_turns_this_attempt = self.approved_turns_this_attempt.max(attempt_turn);
            ActionBudgetDecision::Execute
        }
    }

    pub fn observe_successful_tool_result(&mut self) {
        self.successful_action_seen = true;
        self.last_successful_effect = None;
        self.consecutive_unchanged_effects = 0;
    }

    // A rejected call in the summary turn did not execute. Spend at most one
    // remaining reserved turn correcting the response, without reopening tools
    // or extending the approved limit. A resumed checkpoint gets no new retry.
    pub(crate) fn prepare_finalization_retry(&mut self, turn: usize) -> ActionBudgetDecision {
        if !self.finalization_started
            || self.finalization_retry_used
            || self.exhausted
            || self.approved_turns_this_attempt == 0
            || turn <= self.approved_turns_this_attempt
            || self.turns_consumed_before_attempt.saturating_add(turn) > self.current_limit_turns
        {
            self.exhausted = true;
            return ActionBudgetDecision::Exhausted;
        }
        self.finalization_retry_used = true;
        self.approved_turns_this_attempt = turn;
        ActionBudgetDecision::Finalize
    }

    pub(crate) fn observe_successful_tool_effect(&mut self, effect: SuccessfulToolEffect) {
        match effect {
            SuccessfulToolEffect::Material(fingerprint) => {
                self.observe_material_tool_effect(fingerprint)
            }
            SuccessfulToolEffect::Neutral => {}
            SuccessfulToolEffect::Unknown => self.observe_successful_tool_result(),
        }
    }

    fn observe_material_tool_effect(&mut self, fingerprint: [u8; 32]) {
        self.successful_action_seen = true;
        if self.last_successful_effect == Some(fingerprint) {
            self.consecutive_unchanged_effects =
                self.consecutive_unchanged_effects.saturating_add(1);
            if self.consecutive_unchanged_effects >= UNCHANGED_EFFECTS_BEFORE_COMPLETION_CHECKPOINT
            {
                self.completion_checkpoint_requested = true;
            }
        } else {
            self.last_successful_effect = Some(fingerprint);
            self.consecutive_unchanged_effects = 0;
        }
    }

    pub fn observe_no_effect(&mut self) {
        self.consecutive_unchanged_effects = 0;
        // A failed tool action is not proof that the worker is looping. In particular, a
        // worker may try several distinct verification strategies before reaching one that
        // fits the active workspace/permission boundary. Repeated identical failed actions
        // are stopped by the scheduler's fingerprinted no-progress guard; the action budget
        // must leave room for different fallbacks instead of forcing an early checkpoint.
        // Failure is not another successful observation of an unchanged version.
    }

    pub const fn current_limit_turns(&self) -> usize {
        self.current_limit_turns
    }

    pub(crate) fn extend_main_tool_task(&mut self, configured_cap: usize) -> bool {
        if self.completion_checkpoint_requested {
            return false;
        }
        let next = self
            .current_limit_turns
            .saturating_add(30)
            .min(configured_cap.min(180));
        if next <= self.current_limit_turns {
            return false;
        }
        self.current_limit_turns = next;
        self.hard_limit_turns = next;
        self.finalization_started = false;
        self.exhausted = false;
        self.extension_used = true;
        true
    }

    pub const fn extension_used(&self) -> bool {
        self.extension_used
    }

    pub const fn successful_action_seen(&self) -> bool {
        self.successful_action_seen
    }

    pub const fn report(&self, _turns_taken: usize) -> ActionBudgetReport {
        ActionBudgetReport {
            current_limit_turns: self.current_limit_turns,
            turns_taken: self
                .turns_consumed_before_attempt
                .saturating_add(self.approved_turns_this_attempt),
            extension_used: self.extension_used,
            successful_action_seen: self.successful_action_seen,
            last_successful_effect_fingerprint: self.last_successful_effect,
            consecutive_unchanged_effects: self.consecutive_unchanged_effects,
            completion_checkpoint_requested: self.completion_checkpoint_requested,
            completion_checkpoint_used: self.finalization_started,
            finalization_started: self.finalization_started,
            exhausted: self.exhausted,
        }
    }
}

impl CodeProActionBudgetPolicy {
    pub const fn for_task_kind(task_kind: CodeProTaskKind) -> Self {
        match task_kind {
            // Four query rounds, then an answer. The second reserved round is
            // only available to correct a rejected tool call during finalization.
            CodeProTaskKind::Conversation => Self::new(6, 0, 6, 2, 60),
            CodeProTaskKind::ReadOnly => Self::new(20, 10, 30, 5, 180),
            CodeProTaskKind::ToolAction => Self::new(30, 15, 45, 5, 300),
            CodeProTaskKind::FocusedTest => Self::new(20, 0, 20, 5, 300),
            CodeProTaskKind::ProjectTest => Self::new(40, 20, 60, 5, 1_800),
            CodeProTaskKind::SimpleChange => Self::new(30, 15, 45, 5, 240),
            CodeProTaskKind::BugFix => Self::new(60, 30, 90, 5, 420),
            CodeProTaskKind::ComplexChange => Self::new(80, 0, 80, 5, 600),
        }
    }

    const fn new(
        initial_turns: usize,
        extension_turns: usize,
        hard_limit_turns: usize,
        finalization_reserve_turns: usize,
        timeout_seconds: u64,
    ) -> Self {
        Self {
            initial_turns,
            extension_turns,
            hard_limit_turns,
            finalization_reserve_turns,
            timeout_seconds,
        }
    }

    pub const fn initial_turns(self) -> usize {
        self.initial_turns
    }

    pub const fn extension_turns(self) -> usize {
        self.extension_turns
    }

    pub const fn hard_limit_turns(self) -> usize {
        self.hard_limit_turns
    }

    pub const fn finalization_reserve_turns(self) -> usize {
        self.finalization_reserve_turns
    }

    pub const fn timeout(self) -> Duration {
        Duration::from_secs(self.timeout_seconds)
    }

    pub const fn allows_automatic_extension(self) -> bool {
        self.extension_turns > 0
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_successful_tool_effect, ActionBudgetDecision, ActionBudgetTracker,
        CodeProActionBudgetPolicy, SuccessfulToolEffect,
    };
    use crate::agents::agent_role::CodeProTaskKind;
    use crate::conversation::message::{ToolRequest, ToolResponse};
    use rmcp::model::{CallToolRequestParams, CallToolResult, Content};
    use serde_json::json;
    use std::time::Duration;

    fn successful_effect(id: &str, path: &str, version: usize) -> (ToolRequest, ToolResponse) {
        (
            ToolRequest {
                id: id.to_string(),
                tool_call: Ok(CallToolRequestParams::new("developer__read_file")
                    .with_arguments(json!({"path": path}).as_object().unwrap().clone())),
                metadata: None,
                tool_meta: None,
            },
            ToolResponse {
                id: id.to_string(),
                tool_result: Ok({
                    let mut result = CallToolResult::success(vec![Content::text("redacted")]);
                    result.structured_content =
                        Some(json!({"file_change": {"added":1,"removed":1}}));
                    result.meta = Some(rmcp::model::Meta(
                        json!({
                            "__goose_tool_update_meta": {"workspaceDelta": {
                                "resourceVersions": {(path): format!("blake3:{version}")}
                            }}
                        })
                        .as_object()
                        .unwrap()
                        .clone(),
                    ));
                    result
                }),
                metadata: None,
            },
        )
    }

    #[test]
    fn main_tool_extension_is_bounded_and_respects_explicit_cap() {
        let policy = CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ToolAction);
        let mut tracker = ActionBudgetTracker::from_policy(policy, 1000);
        assert!(tracker.extend_main_tool_task(1000));
        while tracker.extend_main_tool_task(1000) {}
        assert_eq!(tracker.current_limit_turns(), 180);
        let mut limited = ActionBudgetTracker::from_policy(policy, 10);
        assert!(!limited.extend_main_tool_task(10));
        assert_eq!(limited.current_limit_turns(), 10);
    }

    #[test]
    fn repeated_effect_checkpoint_cannot_be_overridden_by_autonomy() {
        let mut tracker = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ToolAction),
            1000,
        );
        for _ in 0..3 {
            tracker.observe_material_tool_effect([1; 32]);
        }
        assert!(!tracker.extend_main_tool_task(1000));
    }

    #[test]
    fn task_kinds_receive_the_exact_host_action_budget_policy() {
        let cases = [
            (CodeProTaskKind::Conversation, 6, 0, 6, 2, 60),
            (CodeProTaskKind::ReadOnly, 20, 10, 30, 5, 180),
            (CodeProTaskKind::ToolAction, 30, 15, 45, 5, 300),
            (CodeProTaskKind::FocusedTest, 20, 0, 20, 5, 300),
            (CodeProTaskKind::ProjectTest, 40, 20, 60, 5, 1_800),
            (CodeProTaskKind::SimpleChange, 30, 15, 45, 5, 240),
            (CodeProTaskKind::BugFix, 60, 30, 90, 5, 420),
            (CodeProTaskKind::ComplexChange, 80, 0, 80, 5, 600),
        ];

        for (task_kind, initial, extension, hard, reserve, timeout_seconds) in cases {
            let policy = CodeProActionBudgetPolicy::for_task_kind(task_kind);
            assert_eq!(policy.initial_turns(), initial, "{task_kind:?}");
            assert_eq!(policy.extension_turns(), extension, "{task_kind:?}");
            assert_eq!(policy.hard_limit_turns(), hard, "{task_kind:?}");
            assert_eq!(
                policy.finalization_reserve_turns(),
                reserve,
                "{task_kind:?}"
            );
            assert_eq!(
                policy.timeout(),
                Duration::from_secs(timeout_seconds),
                "{task_kind:?}"
            );
        }
    }

    #[test]
    fn only_policies_with_an_extension_can_extend_automatically() {
        for task_kind in [
            CodeProTaskKind::Conversation,
            CodeProTaskKind::FocusedTest,
            CodeProTaskKind::ComplexChange,
        ] {
            assert!(
                !CodeProActionBudgetPolicy::for_task_kind(task_kind).allows_automatic_extension(),
                "{task_kind:?}"
            );
        }

        for task_kind in [
            CodeProTaskKind::ReadOnly,
            CodeProTaskKind::ToolAction,
            CodeProTaskKind::ProjectTest,
            CodeProTaskKind::SimpleChange,
            CodeProTaskKind::BugFix,
        ] {
            assert!(
                CodeProActionBudgetPolicy::for_task_kind(task_kind).allows_automatic_extension(),
                "{task_kind:?}"
            );
        }
    }

    #[test]
    fn progress_extends_read_only_once_before_the_finalization_reserve() {
        let mut tracker = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ReadOnly),
            100,
        );
        tracker.observe_successful_tool_result();

        assert_eq!(tracker.prepare_turn(15), ActionBudgetDecision::Execute);
        assert_eq!(tracker.prepare_turn(16), ActionBudgetDecision::Execute);
        assert_eq!(tracker.current_limit_turns(), 30);
        assert!(tracker.extension_used());
        assert_eq!(tracker.prepare_turn(25), ActionBudgetDecision::Execute);
        assert_eq!(tracker.prepare_turn(26), ActionBudgetDecision::Finalize);
        assert_eq!(tracker.current_limit_turns(), 30);
        assert_eq!(
            tracker.report(26),
            super::ActionBudgetReport {
                current_limit_turns: 30,
                turns_taken: 26,
                extension_used: true,
                successful_action_seen: true,
                last_successful_effect_fingerprint: None,
                consecutive_unchanged_effects: 0,
                completion_checkpoint_requested: false,
                completion_checkpoint_used: true,
                finalization_started: true,
                exhausted: false,
            }
        );
    }

    #[test]
    fn no_progress_and_complex_features_enter_finalization_without_extension() {
        let mut read_only = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ReadOnly),
            100,
        );
        assert_eq!(read_only.prepare_turn(16), ActionBudgetDecision::Finalize);
        assert!(!read_only.extension_used());

        let mut complex = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
            100,
        );
        complex.observe_successful_tool_result();
        assert_eq!(complex.prepare_turn(76), ActionBudgetDecision::Finalize);
        assert!(!complex.extension_used());
    }

    #[test]
    fn configured_cap_is_host_enforced_and_conversation_reserves_an_answer() {
        let mut read_only = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ReadOnly),
            18,
        );
        read_only.observe_successful_tool_result();
        assert_eq!(read_only.prepare_turn(14), ActionBudgetDecision::Finalize);
        assert_eq!(read_only.current_limit_turns(), 18);
        assert!(!read_only.extension_used());

        let mut conversation = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::Conversation),
            100,
        );
        assert_eq!(conversation.prepare_turn(4), ActionBudgetDecision::Execute);
        assert_eq!(conversation.prepare_turn(5), ActionBudgetDecision::Finalize);
        assert_eq!(
            conversation.prepare_finalization_retry(6),
            ActionBudgetDecision::Finalize
        );
        assert_eq!(
            conversation.prepare_finalization_retry(7),
            ActionBudgetDecision::Exhausted
        );
        assert!(!conversation.extension_used());

        let mut capped = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::Conversation),
            3,
        );
        assert_eq!(capped.prepare_turn(1), ActionBudgetDecision::Execute);
        assert_eq!(capped.prepare_turn(2), ActionBudgetDecision::Finalize);
        assert_eq!(
            capped.prepare_finalization_retry(3),
            ActionBudgetDecision::Finalize
        );
        assert_eq!(capped.prepare_turn(4), ActionBudgetDecision::Exhausted);
    }

    #[test]
    fn finalization_checkpoint_is_single_shot() {
        let mut tracker = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
            10,
        );

        assert_eq!(tracker.prepare_turn(6), ActionBudgetDecision::Finalize);
        assert_eq!(tracker.prepare_turn(7), ActionBudgetDecision::Exhausted);
    }

    #[test]
    fn two_unchanged_successful_effects_request_early_completion() {
        let mut tracker = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
            10,
        );

        let fingerprint = *blake3::hash(b"stable-effect").as_bytes();
        tracker.observe_successful_tool_effect(SuccessfulToolEffect::Material(fingerprint));
        tracker.observe_successful_tool_effect(SuccessfulToolEffect::Material(fingerprint));
        tracker.observe_successful_tool_effect(SuccessfulToolEffect::Material(fingerprint));

        assert_eq!(tracker.prepare_turn(4), ActionBudgetDecision::Finalize);
        assert_eq!(tracker.prepare_turn(5), ActionBudgetDecision::Exhausted);
    }

    #[test]
    fn effect_fingerprint_ignores_call_ids_but_keeps_material_results() {
        let (first_request, first_response) = successful_effect("call-1", "artifact", 16);
        let (same_request, same_response) = successful_effect("call-2", "artifact", 16);
        let (changed_request, changed_response) = successful_effect("call-3", "artifact", 17);

        let first = classify_successful_tool_effect(&first_request, &first_response);
        assert_eq!(
            first,
            classify_successful_tool_effect(&same_request, &same_response)
        );
        assert_ne!(
            first,
            classify_successful_tool_effect(&changed_request, &changed_response)
        );
        let (other_request, other_response) = successful_effect("call-4", "other", 16);
        assert_ne!(
            first,
            classify_successful_tool_effect(&other_request, &other_response)
        );
    }

    #[test]
    fn resumed_tracker_spends_only_the_remaining_turns() {
        let mut config = super::ActionBudgetConfig::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
        );
        config.current_limit_turns = 10;
        config.hard_limit_turns = 10;
        config.turns_consumed = 4;
        let mut tracker = ActionBudgetTracker::from_config(config, 10);

        assert_eq!(tracker.prepare_turn(1), ActionBudgetDecision::Execute);
        assert_eq!(tracker.prepare_turn(2), ActionBudgetDecision::Finalize);
        assert_eq!(tracker.report(2).turns_taken, 6);
        assert_eq!(tracker.prepare_turn(3), ActionBudgetDecision::Exhausted);
        assert_eq!(tracker.report(3).turns_taken, 6);
    }

    #[test]
    fn rejected_turn_probe_does_not_consume_persisted_budget() {
        let mut config = super::ActionBudgetConfig::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
        );
        config.current_limit_turns = 10;
        config.hard_limit_turns = 10;
        config.turns_consumed = 10;
        let mut tracker = ActionBudgetTracker::from_config(config, 10);

        assert_eq!(tracker.prepare_turn(1), ActionBudgetDecision::Exhausted);
        assert_eq!(tracker.report(1).turns_taken, 10);
    }

    #[test]
    fn failed_tool_actions_do_not_force_an_early_completion_checkpoint() {
        let mut tracker = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
            10,
        );
        tracker.observe_no_effect();
        tracker.observe_no_effect();
        assert_eq!(tracker.prepare_turn(3), ActionBudgetDecision::Execute);

        let (poll_request, poll_response) = successful_effect("poll-1", "artifact", 16);
        let mut polling_only = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
            10,
        );
        let mut poll_request = poll_request;
        poll_request.tool_call.as_mut().unwrap().name = "developer__poll".into();
        let poll_effect = classify_successful_tool_effect(&poll_request, &poll_response);
        assert_eq!(poll_effect, SuccessfulToolEffect::Neutral);
        polling_only.observe_successful_tool_effect(poll_effect);
        polling_only.observe_successful_tool_effect(poll_effect);
        assert_eq!(polling_only.prepare_turn(3), ActionBudgetDecision::Execute);

        let mut interleaved = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
            10,
        );
        interleaved.observe_no_effect();
        interleaved.observe_successful_tool_effect(poll_effect);
        interleaved.observe_no_effect();
        assert_eq!(interleaved.prepare_turn(4), ActionBudgetDecision::Execute);
    }

    #[test]
    fn unstructured_success_is_unknown_instead_of_hashing_text_content() {
        let (request, mut first_response) = successful_effect("read-1", "artifact", 16);
        first_response
            .tool_result
            .as_mut()
            .unwrap()
            .structured_content = None;
        first_response.tool_result.as_mut().unwrap().meta = None;
        let mut second_response = first_response.clone();
        second_response.tool_result.as_mut().unwrap().content =
            vec![Content::text("different untrusted tool output")];

        assert_eq!(
            classify_successful_tool_effect(&request, &first_response),
            SuccessfulToolEffect::Unknown
        );
        assert_eq!(
            classify_successful_tool_effect(&request, &second_response),
            SuccessfulToolEffect::Unknown
        );
    }

    #[test]
    fn successful_unknown_tool_resets_failure_streak() {
        let mut tracker = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
            10,
        );
        tracker.observe_no_effect();
        tracker.observe_successful_tool_effect(SuccessfulToolEffect::Unknown);
        tracker.observe_no_effect();

        assert_eq!(tracker.prepare_turn(4), ActionBudgetDecision::Execute);
    }

    #[test]
    fn repaired_script_can_run_again_without_interleaved_bookkeeping() {
        // 20261007_4 / jdul4b5d: fail, real edit, fail, different real edit.
        // Both edits add/remove one line and have the same result shape.
        let mut tracker = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ToolAction),
            30,
        );
        let (request1, response1) = successful_effect("edit1", "probe.py", 1);
        let (request2, response2) = successful_effect("edit2", "probe.py", 2);
        tracker.observe_no_effect();
        tracker
            .observe_successful_tool_effect(classify_successful_tool_effect(&request1, &response1));
        tracker.observe_no_effect();
        tracker
            .observe_successful_tool_effect(classify_successful_tool_effect(&request2, &response2));
        assert_eq!(
            tracker.prepare_turn(5),
            ActionBudgetDecision::Execute,
            "the repaired script must still have a verification opportunity"
        );
        assert!(!tracker.report(5).completion_checkpoint_requested);
    }

    #[test]
    fn failure_is_not_a_second_observation_of_an_unchanged_version() {
        let mut tracker = ActionBudgetTracker::from_policy(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ToolAction),
            30,
        );
        let (request, response) = successful_effect("edit", "probe.py", 1);
        let effect = classify_successful_tool_effect(&request, &response);
        tracker.observe_successful_tool_effect(effect);
        tracker.observe_no_effect();
        tracker.observe_successful_tool_effect(effect);
        assert_eq!(tracker.prepare_turn(4), ActionBudgetDecision::Execute);
        tracker.observe_successful_tool_effect(effect);
        assert_eq!(
            tracker.prepare_turn(5),
            ActionBudgetDecision::Finalize,
            "confirmed repeated versions must retain the bounded checkpoint"
        );
    }

    #[test]
    fn lossy_result_shapes_cannot_prove_unchanged_effects() {
        let (request, mut response) = successful_effect("edit", "probe.py", 1);
        let result = response.tool_result.as_mut().unwrap();
        result.meta = None;
        for body in [
            json!({"file_change":{"added":1,"removed":1}}),
            json!({"size":12,"status":"success"}),
            json!({}),
        ] {
            response.tool_result.as_mut().unwrap().structured_content = Some(body);
            assert_eq!(
                classify_successful_tool_effect(&request, &response),
                SuccessfulToolEffect::Unknown
            );
        }
    }
}
