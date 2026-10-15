use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Planner,
    Coder,
    Tester,
    Reviewer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProTaskKind {
    Conversation,
    ReadOnly,
    ToolAction,
    FocusedTest,
    ProjectTest,
    SimpleChange,
    BugFix,
    ComplexChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProRiskTier {
    L0ReadOnly,
    L1ReversibleChange,
    L2Feature,
    L3HighRiskRelease,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProRiskReason {
    ReadOnly,
    FocusedLocalValidation,
    SingleWorkspaceFile,
    MultiFileOrUnknownWriteScope,
    PermissionBoundary,
    CredentialMaterial,
    DestructiveChange,
    OutsideWorkspace,
    RemoteSideEffect,
    InstallUpdateOrRelease,
    UserRequestedStricterReview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProRiskAssessment {
    pub tier: CodeProRiskTier,
    pub reasons: Vec<CodeProRiskReason>,
}

impl CodeProRiskAssessment {
    pub fn conservative_for_task_kind(task_kind: CodeProTaskKind) -> Self {
        let (tier, reason) = match task_kind {
            CodeProTaskKind::Conversation | CodeProTaskKind::ReadOnly => {
                (CodeProRiskTier::L0ReadOnly, CodeProRiskReason::ReadOnly)
            }
            CodeProTaskKind::ToolAction => (
                CodeProRiskTier::L1ReversibleChange,
                CodeProRiskReason::PermissionBoundary,
            ),
            CodeProTaskKind::SimpleChange => (
                CodeProRiskTier::L1ReversibleChange,
                CodeProRiskReason::SingleWorkspaceFile,
            ),
            CodeProTaskKind::FocusedTest | CodeProTaskKind::ProjectTest => (
                CodeProRiskTier::L0ReadOnly,
                CodeProRiskReason::FocusedLocalValidation,
            ),
            CodeProTaskKind::BugFix | CodeProTaskKind::ComplexChange => (
                CodeProRiskTier::L2Feature,
                CodeProRiskReason::MultiFileOrUnknownWriteScope,
            ),
        };
        Self {
            tier,
            reasons: vec![reason],
        }
    }

    pub fn escalate(&mut self, observed: Self) {
        self.tier = self.tier.max(observed.tier);
        for reason in observed.reasons {
            if !self.reasons.contains(&reason) {
                self.reasons.push(reason);
            }
        }
    }

    pub const fn review_required(&self) -> bool {
        matches!(self.tier, CodeProRiskTier::L3HighRiskRelease)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProRolePlan {
    pub task_kind: CodeProTaskKind,
    pub risk_tier: CodeProRiskTier,
    pub risk_reasons: Vec<CodeProRiskReason>,
    pub review_required: bool,
    pub roles: Vec<AgentRole>,
    pub strategy_zh: String,
}

impl CodeProRolePlan {
    pub fn risk_assessment(&self) -> CodeProRiskAssessment {
        CodeProRiskAssessment {
            tier: self.risk_tier,
            reasons: self.risk_reasons.clone(),
        }
    }
}

pub fn codepro_role_plan(task_kind: CodeProTaskKind) -> CodeProRolePlan {
    codepro_role_plan_for_risk(
        task_kind,
        &CodeProRiskAssessment::conservative_for_task_kind(task_kind),
    )
}

pub fn codepro_role_plan_for_risk(
    task_kind: CodeProTaskKind,
    assessment: &CodeProRiskAssessment,
) -> CodeProRolePlan {
    let (roles, strategy_zh) = match task_kind {
        CodeProTaskKind::Conversation => (vec![], "直接回答，不启动协作 Agent。"),
        CodeProTaskKind::ReadOnly => (vec![], "只读分析项目，不修改文件。"),
        CodeProTaskKind::ToolAction => (
            vec![],
            "由主 Agent 调用已启用的共享工具完成操作，并保留权限与审计证据。",
        ),
        CodeProTaskKind::FocusedTest => (
            vec![AgentRole::Tester],
            "由 Tester 运行指定测试并记录宿主证据。",
        ),
        CodeProTaskKind::ProjectTest => (
            vec![AgentRole::Planner, AgentRole::Tester],
            "先由 Planner 拆分测试范围，再由 Tester 独立执行。",
        ),
        CodeProTaskKind::SimpleChange if assessment.tier <= CodeProRiskTier::L1ReversibleChange => {
            (
                vec![],
                "直接修改唯一目标文件并运行一次宿主验证，不启动额外角色。",
            )
        }
        CodeProTaskKind::SimpleChange
        | CodeProTaskKind::BugFix
        | CodeProTaskKind::ComplexChange => (
            vec![AgentRole::Planner, AgentRole::Coder, AgentRole::Tester],
            "由 Planner 拆分任务，Coder 修改，Tester 独立验证。",
        ),
    };
    let mut roles = roles;
    if assessment.review_required()
        && !matches!(
            task_kind,
            CodeProTaskKind::Conversation | CodeProTaskKind::ReadOnly | CodeProTaskKind::ToolAction
        )
        && !roles.contains(&AgentRole::Reviewer)
    {
        roles.push(AgentRole::Reviewer);
    }
    let strategy_zh = if assessment.review_required() && !roles.is_empty() {
        format!("{strategy_zh} 完成前必须由 Reviewer 独立审查。")
    } else {
        strategy_zh.to_string()
    };

    CodeProRolePlan {
        task_kind,
        risk_tier: assessment.tier,
        risk_reasons: assessment.reasons.clone(),
        review_required: assessment.review_required(),
        roles,
        strategy_zh,
    }
}

impl AgentRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentRole::Planner => "planner",
            AgentRole::Coder => "coder",
            AgentRole::Tester => "tester",
            AgentRole::Reviewer => "reviewer",
        }
    }

    pub const fn max_turns(self) -> usize {
        match self {
            AgentRole::Planner => 50,
            AgentRole::Coder => 100,
            AgentRole::Tester => 120,
            AgentRole::Reviewer => 80,
        }
    }

    pub const fn display_name_zh(self) -> &'static str {
        match self {
            AgentRole::Planner => "分析 Agent",
            AgentRole::Coder => "编码 Agent",
            AgentRole::Tester => "测试 Agent",
            AgentRole::Reviewer => "审查 Agent",
        }
    }
}

impl std::fmt::Display for AgentRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        codepro_role_plan, codepro_role_plan_for_risk, AgentRole, CodeProRiskAssessment,
        CodeProRiskReason, CodeProRiskTier, CodeProTaskKind,
    };

    fn assessment(tier: CodeProRiskTier, reason: CodeProRiskReason) -> CodeProRiskAssessment {
        CodeProRiskAssessment {
            tier,
            reasons: vec![reason],
        }
    }

    #[test]
    fn tester_role_uses_stable_snake_case_contract() {
        let serialized = serde_json::to_string(&AgentRole::Tester).unwrap();
        assert_eq!(serialized, "\"tester\"");
        assert_eq!(
            serde_json::from_str::<AgentRole>(&serialized).unwrap(),
            AgentRole::Tester
        );
    }

    #[test]
    fn codepro_roles_have_separate_turn_budgets() {
        assert_eq!(AgentRole::Planner.max_turns(), 50);
        assert_eq!(AgentRole::Coder.max_turns(), 100);
        assert_eq!(AgentRole::Tester.max_turns(), 120);
        assert_eq!(AgentRole::Reviewer.max_turns(), 80);
    }

    #[test]
    fn codepro_role_plan_selects_the_minimum_roles_for_each_task_kind() {
        let cases = [
            (CodeProTaskKind::Conversation, vec![]),
            (CodeProTaskKind::ReadOnly, vec![]),
            (CodeProTaskKind::ToolAction, vec![]),
            (CodeProTaskKind::FocusedTest, vec![AgentRole::Tester]),
            (
                CodeProTaskKind::ProjectTest,
                vec![AgentRole::Planner, AgentRole::Tester],
            ),
            (CodeProTaskKind::SimpleChange, vec![]),
            (
                CodeProTaskKind::BugFix,
                vec![AgentRole::Planner, AgentRole::Coder, AgentRole::Tester],
            ),
            (
                CodeProTaskKind::ComplexChange,
                vec![AgentRole::Planner, AgentRole::Coder, AgentRole::Tester],
            ),
        ];

        for (task_kind, expected_roles) in cases {
            let plan = codepro_role_plan(task_kind);
            assert_eq!(plan.task_kind, task_kind);
            assert_eq!(plan.roles, expected_roles, "{task_kind:?}");
            assert!(!plan.strategy_zh.trim().is_empty(), "{task_kind:?}");
        }
    }

    #[test]
    fn codepro_role_plan_never_selects_the_same_role_twice() {
        for task_kind in [
            CodeProTaskKind::Conversation,
            CodeProTaskKind::ReadOnly,
            CodeProTaskKind::ToolAction,
            CodeProTaskKind::FocusedTest,
            CodeProTaskKind::ProjectTest,
            CodeProTaskKind::SimpleChange,
            CodeProTaskKind::BugFix,
            CodeProTaskKind::ComplexChange,
        ] {
            let plan = codepro_role_plan(task_kind);
            let mut roles = plan.roles.clone();
            roles.sort_by_key(AgentRole::as_str);
            roles.dedup();
            assert_eq!(roles.len(), plan.roles.len(), "{task_kind:?}");
        }
    }

    #[test]
    fn codepro_risk_tier_uses_a_stable_snake_case_contract() {
        assert_eq!(
            serde_json::to_string(&CodeProRiskTier::L3HighRiskRelease).unwrap(),
            "\"l3_high_risk_release\""
        );
    }

    #[test]
    fn codepro_risk_escalation_is_monotonic_and_preserves_reasons() {
        let mut current = assessment(
            CodeProRiskTier::L2Feature,
            CodeProRiskReason::MultiFileOrUnknownWriteScope,
        );
        current.escalate(assessment(
            CodeProRiskTier::L3HighRiskRelease,
            CodeProRiskReason::RemoteSideEffect,
        ));
        current.escalate(assessment(
            CodeProRiskTier::L1ReversibleChange,
            CodeProRiskReason::SingleWorkspaceFile,
        ));

        assert_eq!(current.tier, CodeProRiskTier::L3HighRiskRelease);
        assert_eq!(
            current.reasons,
            vec![
                CodeProRiskReason::MultiFileOrUnknownWriteScope,
                CodeProRiskReason::RemoteSideEffect,
                CodeProRiskReason::SingleWorkspaceFile,
            ]
        );
        assert!(current.review_required());
    }

    #[test]
    fn risk_qualified_role_plan_uses_only_the_required_roles() {
        let l1 = assessment(
            CodeProRiskTier::L1ReversibleChange,
            CodeProRiskReason::SingleWorkspaceFile,
        );
        let l2 = assessment(
            CodeProRiskTier::L2Feature,
            CodeProRiskReason::MultiFileOrUnknownWriteScope,
        );
        let l3 = assessment(
            CodeProRiskTier::L3HighRiskRelease,
            CodeProRiskReason::PermissionBoundary,
        );

        let simple = codepro_role_plan_for_risk(CodeProTaskKind::SimpleChange, &l1);
        assert!(simple.roles.is_empty());
        assert!(!simple.review_required);

        let feature = codepro_role_plan_for_risk(CodeProTaskKind::ComplexChange, &l2);
        assert_eq!(
            feature.roles,
            vec![AgentRole::Planner, AgentRole::Coder, AgentRole::Tester]
        );
        assert!(!feature.review_required);

        let release = codepro_role_plan_for_risk(CodeProTaskKind::ComplexChange, &l3);
        assert_eq!(
            release.roles,
            vec![
                AgentRole::Planner,
                AgentRole::Coder,
                AgentRole::Tester,
                AgentRole::Reviewer,
            ]
        );
        assert!(release.review_required);
        assert_eq!(release.risk_tier, CodeProRiskTier::L3HighRiskRelease);
    }

    #[test]
    fn risk_qualified_test_plans_do_not_add_a_reviewer_below_l3() {
        let l1 = assessment(
            CodeProRiskTier::L1ReversibleChange,
            CodeProRiskReason::FocusedLocalValidation,
        );
        let l2 = assessment(
            CodeProRiskTier::L2Feature,
            CodeProRiskReason::MultiFileOrUnknownWriteScope,
        );

        assert_eq!(
            codepro_role_plan_for_risk(CodeProTaskKind::FocusedTest, &l1).roles,
            vec![AgentRole::Tester]
        );
        assert_eq!(
            codepro_role_plan_for_risk(CodeProTaskKind::ProjectTest, &l2).roles,
            vec![AgentRole::Planner, AgentRole::Tester]
        );
    }
}
