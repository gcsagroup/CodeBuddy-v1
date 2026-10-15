use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProFailureKind {
    PolicyDenied,
    UserDenied,
    OutsideWorkspace,
    Forbidden,
    Cancelled,
    EnvironmentFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CodeProFailureUserAction {
    ReviewPolicy,
    RequestAuthorization,
    ChooseWorkspacePath,
    ChooseSaferAction,
    RestartTask,
    CheckEnvironment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CodeProFailureContract {
    pub(crate) status_code: &'static str,
    pub(crate) retryable: bool,
    pub(crate) user_action: CodeProFailureUserAction,
    pub(crate) display_zh_cn: &'static str,
}

impl CodeProFailureUserAction {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::ReviewPolicy => "review_policy",
            Self::RequestAuthorization => "request_authorization",
            Self::ChooseWorkspacePath => "choose_workspace_path",
            Self::ChooseSaferAction => "choose_safer_action",
            Self::RestartTask => "restart_task",
            Self::CheckEnvironment => "check_environment",
        }
    }
}

impl CodeProFailureContract {
    pub(crate) const fn user_action_code(self) -> &'static str {
        self.user_action.code()
    }
}

impl CodeProFailureKind {
    pub(crate) const fn contract(self) -> CodeProFailureContract {
        match self {
            Self::PolicyDenied => CodeProFailureContract {
                status_code: "policy_denied",
                retryable: false,
                user_action: CodeProFailureUserAction::ReviewPolicy,
                display_zh_cn: "需要调整操作",
            },
            Self::UserDenied => CodeProFailureContract {
                status_code: "user_denied",
                retryable: false,
                user_action: CodeProFailureUserAction::RequestAuthorization,
                display_zh_cn: "用户未授权",
            },
            Self::OutsideWorkspace => CodeProFailureContract {
                status_code: "outside_workspace",
                retryable: true,
                user_action: CodeProFailureUserAction::ChooseWorkspacePath,
                display_zh_cn: "等待用户授权范围",
            },
            Self::Forbidden => CodeProFailureContract {
                status_code: "forbidden",
                retryable: false,
                user_action: CodeProFailureUserAction::ChooseSaferAction,
                display_zh_cn: "操作被禁止",
            },
            Self::Cancelled => CodeProFailureContract {
                status_code: "cancelled",
                retryable: true,
                user_action: CodeProFailureUserAction::RestartTask,
                display_zh_cn: "任务已取消",
            },
            Self::EnvironmentFailure => CodeProFailureContract {
                status_code: "environment_failure",
                retryable: true,
                user_action: CodeProFailureUserAction::CheckEnvironment,
                display_zh_cn: "环境不可用",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CodeProFailureKind, CodeProFailureUserAction};
    use std::collections::HashSet;

    #[test]
    fn every_host_failure_has_one_fixed_user_contract() {
        let cases = [
            (
                CodeProFailureKind::PolicyDenied,
                "policy_denied",
                false,
                CodeProFailureUserAction::ReviewPolicy,
                "需要调整操作",
            ),
            (
                CodeProFailureKind::UserDenied,
                "user_denied",
                false,
                CodeProFailureUserAction::RequestAuthorization,
                "用户未授权",
            ),
            (
                CodeProFailureKind::OutsideWorkspace,
                "outside_workspace",
                true,
                CodeProFailureUserAction::ChooseWorkspacePath,
                "等待用户授权范围",
            ),
            (
                CodeProFailureKind::Forbidden,
                "forbidden",
                false,
                CodeProFailureUserAction::ChooseSaferAction,
                "操作被禁止",
            ),
            (
                CodeProFailureKind::Cancelled,
                "cancelled",
                true,
                CodeProFailureUserAction::RestartTask,
                "任务已取消",
            ),
            (
                CodeProFailureKind::EnvironmentFailure,
                "environment_failure",
                true,
                CodeProFailureUserAction::CheckEnvironment,
                "环境不可用",
            ),
        ];

        let mut status_codes = HashSet::new();
        for (failure, status_code, retryable, user_action, display_zh_cn) in cases {
            let contract = failure.contract();
            assert_eq!(contract.status_code, status_code);
            assert_eq!(contract.retryable, retryable);
            assert_eq!(contract.user_action, user_action);
            assert_eq!(contract.display_zh_cn, display_zh_cn);
            assert!(status_codes.insert(contract.status_code));
            assert_eq!(serde_json::to_value(failure).unwrap(), status_code);
            assert_eq!(
                serde_json::to_value(user_action).unwrap(),
                contract.user_action_code()
            );
        }
    }
}
