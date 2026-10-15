use std::collections::HashMap;

use tokio::sync::{oneshot, Mutex};
use tracing::warn;

use crate::permission::PermissionConfirmation;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ToolConfirmationOutcome {
    Selected(PermissionConfirmation),
    /// ACP's actual allow_always option for a displayed task workspace scope.
    TaskWorkspaceGrant {
        confirmation: PermissionConfirmation,
        option_id: String,
    },
    Cancelled,
    PolicyDenied,
    Forbidden,
    EnvironmentFailure,
}

impl From<PermissionConfirmation> for ToolConfirmationOutcome {
    fn from(confirmation: PermissionConfirmation) -> Self {
        Self::Selected(confirmation)
    }
}

pub(crate) struct RegisteredToolConfirmation {
    pub confirmation_id: String,
    pub receiver: oneshot::Receiver<ToolConfirmationOutcome>,
}

pub struct ToolConfirmationRouter {
    pending: Mutex<HashMap<String, oneshot::Sender<ToolConfirmationOutcome>>>,
}

impl ToolConfirmationRouter {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn register(&self, _local_request_id: String) -> RegisteredToolConfirmation {
        let (tx, rx) = oneshot::channel();
        let confirmation_id = format!("confirmation-{}", uuid::Uuid::new_v4());
        let mut pending = self.pending.lock().await;
        pending.retain(|_, sender| !sender.is_closed());
        pending.insert(confirmation_id.clone(), tx);
        RegisteredToolConfirmation {
            confirmation_id,
            receiver: rx,
        }
    }

    pub(crate) async fn deliver(
        &self,
        request_id: String,
        outcome: impl Into<ToolConfirmationOutcome>,
    ) -> bool {
        if let Some(tx) = self.pending.lock().await.remove(&request_id) {
            if tx.send(outcome.into()).is_err() {
                warn!(
                    request_id = %request_id,
                    "Confirmation receiver was dropped (task cancelled)"
                );
                false
            } else {
                true
            }
        } else {
            warn!(
                request_id = %request_id,
                "No task waiting for confirmation"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::permission_confirmation::PrincipalType;
    use crate::permission::Permission;

    fn test_confirmation() -> PermissionConfirmation {
        PermissionConfirmation {
            principal_type: PrincipalType::Tool,
            permission: Permission::AllowOnce,
        }
    }

    #[tokio::test]
    async fn test_register_then_deliver() {
        let router = ToolConfirmationRouter::new();
        let registered = router.register("req_1".to_string()).await;
        assert!(
            router
                .deliver(registered.confirmation_id, test_confirmation())
                .await
        );
        let confirmation = registered.receiver.await.unwrap();
        assert_eq!(
            confirmation,
            ToolConfirmationOutcome::Selected(test_confirmation())
        );
    }

    #[tokio::test]
    async fn test_deliver_unknown_request() {
        let router = ToolConfirmationRouter::new();
        assert!(
            !router
                .deliver("unknown".to_string(), test_confirmation())
                .await
        );
    }

    #[tokio::test]
    async fn test_cancelled_receiver() {
        let router = ToolConfirmationRouter::new();
        let registered = router.register("req_1".to_string()).await;
        let confirmation_id = registered.confirmation_id;
        drop(registered.receiver); // simulate task cancellation
        assert!(!router.deliver(confirmation_id, test_confirmation()).await);
    }

    #[tokio::test]
    async fn test_stale_entries_pruned_on_register() {
        let router = ToolConfirmationRouter::new();
        let registered = router.register("req_1".to_string()).await;
        let stale_id = registered.confirmation_id;
        drop(registered.receiver); // simulate task cancellation; entry is now stale

        assert_eq!(router.pending.lock().await.len(), 1);

        let registered2 = router.register("req_2".to_string()).await;
        assert_eq!(router.pending.lock().await.len(), 1); // only req_2 remains
        assert!(!router.pending.lock().await.contains_key(&stale_id));
        assert!(router
            .pending
            .lock()
            .await
            .contains_key(&registered2.confirmation_id));
    }

    #[tokio::test]
    async fn test_concurrent_requests_out_of_order() {
        use std::sync::Arc;

        let router = Arc::new(ToolConfirmationRouter::new());

        // Register two requests
        let registered1 = router.register("req_1".to_string()).await;
        let registered2 = router.register("req_2".to_string()).await;

        // Deliver in reverse order
        assert!(
            router
                .deliver(
                    registered2.confirmation_id,
                    PermissionConfirmation {
                        principal_type: PrincipalType::Tool,
                        permission: Permission::DenyOnce,
                    }
                )
                .await
        );
        assert_eq!(router.pending.lock().await.len(), 1);
        assert!(
            router
                .deliver(registered1.confirmation_id, test_confirmation())
                .await
        );
        assert_eq!(router.pending.lock().await.len(), 0);

        let c1 = registered1.receiver.await.unwrap();
        assert_eq!(c1, ToolConfirmationOutcome::Selected(test_confirmation()));
        let c2 = registered2.receiver.await.unwrap();
        assert_eq!(
            c2,
            ToolConfirmationOutcome::Selected(PermissionConfirmation {
                principal_type: PrincipalType::Tool,
                permission: Permission::DenyOnce,
            })
        );
    }

    #[tokio::test]
    async fn identical_local_request_ids_receive_distinct_confirmation_ids() {
        let router = ToolConfirmationRouter::new();

        let parent = router.register("shared-local-id".to_string()).await;
        let child = router.register("shared-local-id".to_string()).await;

        assert_ne!(parent.confirmation_id, child.confirmation_id);
        assert!(
            router
                .deliver(
                    child.confirmation_id.clone(),
                    PermissionConfirmation {
                        principal_type: PrincipalType::Tool,
                        permission: Permission::DenyOnce,
                    },
                )
                .await
        );
        assert!(
            router
                .deliver(parent.confirmation_id.clone(), test_confirmation())
                .await
        );

        assert_eq!(
            parent.receiver.await.unwrap(),
            ToolConfirmationOutcome::Selected(test_confirmation())
        );
        assert_eq!(
            child.receiver.await.unwrap(),
            ToolConfirmationOutcome::Selected(PermissionConfirmation {
                principal_type: PrincipalType::Tool,
                permission: Permission::DenyOnce,
            })
        );
    }
}
