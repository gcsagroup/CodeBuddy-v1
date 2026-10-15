use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, OwnedMutexGuard, RwLock};
use tokio::time::timeout;
use tracing::warn;
use uuid::Uuid;

use crate::conversation::message::{Message, MessageContent};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ElicitationOutcome {
    Accept(Value),
    Decline,
    Cancel,
}

struct PendingRequest {
    session_id: String,
    response_tx: Option<tokio::sync::oneshot::Sender<ElicitationOutcome>>,
}

pub(crate) struct PendingResponseClaim {
    request_id: String,
    pending: OwnedMutexGuard<PendingRequest>,
}

pub(crate) struct ResponseSessionAliasGuard {
    manager: &'static ActionRequiredManager,
    source_session_id: String,
    response_session_id: String,
}

impl Drop for ResponseSessionAliasGuard {
    fn drop(&mut self) {
        let Ok(mut aliases) = self.manager.response_session_aliases.write() else {
            return;
        };
        if aliases.get(&self.source_session_id) == Some(&self.response_session_id) {
            aliases.remove(&self.source_session_id);
        }
    }
}

impl PendingResponseClaim {
    pub(crate) fn submit(mut self, response: ElicitationOutcome) -> Result<()> {
        let tx = self
            .pending
            .response_tx
            .take()
            .ok_or_else(|| anyhow::anyhow!("Request already completed: {}", self.request_id))?;
        drop(self.pending);

        if tx.send(response).is_err() {
            return Err(anyhow::anyhow!("Response channel closed"));
        }

        Ok(())
    }
}

pub(crate) struct ActionRequiredManager {
    pending: Arc<RwLock<HashMap<String, Arc<Mutex<PendingRequest>>>>>,
    action_required_senders: Mutex<HashMap<(String, String), mpsc::Sender<Message>>>,
    response_session_aliases: StdRwLock<HashMap<String, String>>,
}

impl ActionRequiredManager {
    fn new() -> Self {
        Self {
            pending: Arc::new(RwLock::new(HashMap::new())),
            action_required_senders: Mutex::new(HashMap::new()),
            response_session_aliases: StdRwLock::new(HashMap::new()),
        }
    }

    pub(crate) fn global() -> &'static Self {
        static INSTANCE: once_cell::sync::Lazy<ActionRequiredManager> =
            once_cell::sync::Lazy::new(ActionRequiredManager::new);
        &INSTANCE
    }

    pub(crate) fn register_response_session_alias(
        &'static self,
        source_session_id: impl Into<String>,
        response_session_id: impl Into<String>,
    ) -> Result<ResponseSessionAliasGuard> {
        let source_session_id = source_session_id.into();
        let response_session_id = response_session_id.into();
        if source_session_id.is_empty() || response_session_id.is_empty() {
            return Err(anyhow::anyhow!("Session aliases must be non-empty"));
        }
        self.response_session_aliases
            .write()
            .map_err(|_| anyhow::anyhow!("Response session alias lock poisoned"))?
            .insert(source_session_id.clone(), response_session_id.clone());
        Ok(ResponseSessionAliasGuard {
            manager: self,
            source_session_id,
            response_session_id,
        })
    }

    pub(crate) async fn request_and_wait(
        &self,
        session_id: String,
        tool_call_request_id: String,
        message: String,
        schema: Value,
        timeout_duration: Duration,
    ) -> Result<ElicitationOutcome> {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let pending_request = PendingRequest {
            session_id: session_id.clone(),
            response_tx: Some(tx),
        };
        let pending_request = Arc::new(Mutex::new(pending_request));

        self.pending
            .write()
            .await
            .insert(id.clone(), Arc::clone(&pending_request));

        let action_required_message = Message::assistant().with_content(
            MessageContent::action_required_elicitation(id.clone(), message, schema),
        );

        let sender = self
            .action_required_senders
            .lock()
            .await
            .get(&(session_id.clone(), tool_call_request_id.clone()))
            .cloned();

        let Some(sender) = sender else {
            self.pending.write().await.remove(&id);
            return Err(anyhow::anyhow!(
                "Tool call request not found for elicitation: {}",
                tool_call_request_id
            ));
        };

        if sender.send(action_required_message).await.is_err() {
            self.pending.write().await.remove(&id);
            return Err(anyhow::anyhow!(
                "Tool call action-required stream closed: {}",
                tool_call_request_id
            ));
        }

        let result = self
            .wait_for_response(&id, pending_request, rx, timeout_duration)
            .await;

        self.pending.write().await.remove(&id);

        result
    }

    pub(crate) async fn claim_response(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<PendingResponseClaim> {
        let pending_arc = self.pending_request(request_id).await?;
        let mut pending = pending_arc.lock_owned().await;

        let session_matches = pending.session_id == session_id
            || self
                .response_session_aliases
                .read()
                .map(|aliases| {
                    aliases
                        .get(&pending.session_id)
                        .is_some_and(|alias| alias == session_id)
                })
                .unwrap_or(false);
        if !session_matches {
            return Err(anyhow::anyhow!(
                "Request {} belongs to session {}, not {}",
                request_id,
                pending.session_id,
                session_id
            ));
        }

        let tx = pending
            .response_tx
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Request already completed: {}", request_id))?;
        if tx.is_closed() {
            pending.response_tx.take();
            return Err(anyhow::anyhow!("Response channel closed"));
        }

        Ok(PendingResponseClaim {
            request_id: request_id.to_string(),
            pending,
        })
    }

    async fn pending_request(&self, request_id: &str) -> Result<Arc<Mutex<PendingRequest>>> {
        let pending = self.pending.read().await;
        pending
            .get(request_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Request not found: {}", request_id))
    }

    async fn wait_for_response(
        &self,
        request_id: &str,
        pending_request: Arc<Mutex<PendingRequest>>,
        mut rx: tokio::sync::oneshot::Receiver<ElicitationOutcome>,
        timeout_duration: Duration,
    ) -> Result<ElicitationOutcome> {
        match timeout(timeout_duration, &mut rx).await {
            Ok(response) => Self::finish_waiting(request_id, response),
            Err(error) => {
                let mut pending = pending_request.lock().await;
                if pending.response_tx.is_some() {
                    pending.response_tx.take();
                    warn!("Timeout waiting for response: {}", request_id);
                    return Err(
                        anyhow::Error::new(error).context("Timeout waiting for user response")
                    );
                }
                drop(pending);

                Self::finish_waiting(request_id, rx.await)
            }
        }
    }

    fn finish_waiting(
        request_id: &str,
        response: Result<ElicitationOutcome, tokio::sync::oneshot::error::RecvError>,
    ) -> Result<ElicitationOutcome> {
        match response {
            Ok(user_data) => Ok(user_data),
            Err(_) => {
                warn!("Response channel closed for request: {}", request_id);
                Err(anyhow::anyhow!("Response channel closed"))
            }
        }
    }

    pub(crate) async fn register_action_required_stream(
        &self,
        session_id: String,
        tool_call_request_id: String,
    ) -> mpsc::Receiver<Message> {
        let (tx, rx) = mpsc::channel(8);
        self.action_required_senders
            .lock()
            .await
            .insert((session_id, tool_call_request_id), tx);
        rx
    }

    pub(crate) async fn has_action_required_stream(
        &self,
        session_id: &str,
        tool_call_request_id: &str,
    ) -> bool {
        self.action_required_senders
            .lock()
            .await
            .contains_key(&(session_id.to_string(), tool_call_request_id.to_string()))
    }

    /// Relay an existing child request without creating a second pending request.
    pub(crate) async fn forward_child_elicitation(
        &self,
        child_session_id: &str,
        parent_session_id: &str,
        parent_tool_call_id: &str,
        message: Message,
    ) -> Result<()> {
        use crate::conversation::message::ActionRequiredData;
        anyhow::ensure!(
            self.response_session_aliases
                .read()
                .map_err(|_| anyhow::anyhow!("Response session alias lock poisoned"))?
                .get(child_session_id)
                .is_some_and(|parent| parent == parent_session_id),
            "Child input has no registered parent response route"
        );
        anyhow::ensure!(!message.content.is_empty(), "Empty child input request");
        for content in &message.content {
            let MessageContent::ActionRequired(required) = content else {
                anyhow::bail!("Only pending child elicitation can be forwarded");
            };
            let ActionRequiredData::Elicitation { id, .. } = &required.data else {
                anyhow::bail!("Not a pending child elicitation");
            };
            let pending = self.pending_request(id).await?;
            anyhow::ensure!(
                pending.lock().await.session_id == child_session_id,
                "Child input request belongs to a different session"
            );
        }
        let sender = self
            .action_required_senders
            .lock()
            .await
            .get(&(
                parent_session_id.to_string(),
                parent_tool_call_id.to_string(),
            ))
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Parent action-required stream is unavailable"))?;
        sender
            .send(message)
            .await
            .map_err(|_| anyhow::anyhow!("Parent action-required stream closed"))
    }

    pub(crate) async fn unregister_action_required_stream(
        &self,
        session_id: &str,
        tool_call_request_id: &str,
    ) {
        self.action_required_senders
            .lock()
            .await
            .remove(&(session_id.to_string(), tool_call_request_id.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::message::ActionRequiredData;
    use serde_json::json;

    fn elicitation_id(message: &Message) -> String {
        match &message.content[0] {
            MessageContent::ActionRequired(action_required) => match &action_required.data {
                ActionRequiredData::Elicitation { id, .. } => id.clone(),
                _ => panic!("expected elicitation action-required message"),
            },
            _ => panic!("expected action-required message"),
        }
    }

    async fn recv_elicitation_message(rx: &mut mpsc::Receiver<Message>) -> Message {
        tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("timed out waiting for elicitation message")
            .expect("action-required stream closed")
    }

    #[tokio::test]
    async fn wrong_session_does_not_consume_pending_response() {
        let manager = Arc::new(ActionRequiredManager::new());
        let mut action_required_rx = manager
            .register_action_required_stream("session-a".to_string(), "tool-call-a".to_string())
            .await;
        let waiter = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .request_and_wait(
                        "session-a".to_string(),
                        "tool-call-a".to_string(),
                        "Need input".to_string(),
                        json!({ "type": "object" }),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };

        let message = recv_elicitation_message(&mut action_required_rx).await;
        let request_id = elicitation_id(&message);

        let err = match manager.claim_response("session-b", &request_id).await {
            Ok(_) => panic!("wrong session should not claim pending response"),
            Err(error) => error,
        };
        assert!(err.to_string().contains("belongs to session session-a"));

        manager
            .claim_response("session-a", &request_id)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Accept(json!({ "answer": "right" })))
            .unwrap();

        let response = waiter.await.unwrap().unwrap();
        assert_eq!(
            response,
            ElicitationOutcome::Accept(json!({ "answer": "right" }))
        );
    }

    #[tokio::test]
    async fn registered_parent_session_can_answer_child_elicitation_until_guard_drops() {
        let manager: &'static ActionRequiredManager =
            Box::leak(Box::new(ActionRequiredManager::new()));
        let alias_guard = manager
            .register_response_session_alias("child-session", "parent-session")
            .unwrap();
        let mut action_required_rx = manager
            .register_action_required_stream(
                "child-session".to_string(),
                "child-tool-call".to_string(),
            )
            .await;
        let waiter = tokio::spawn(async move {
            manager
                .request_and_wait(
                    "child-session".to_string(),
                    "child-tool-call".to_string(),
                    "Need parent input".to_string(),
                    json!({ "type": "object" }),
                    Duration::from_secs(5),
                )
                .await
        });

        let request_id = elicitation_id(&recv_elicitation_message(&mut action_required_rx).await);
        manager
            .claim_response("parent-session", &request_id)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Accept(json!({ "answer": "continue" })))
            .unwrap();
        assert_eq!(
            waiter.await.unwrap().unwrap(),
            ElicitationOutcome::Accept(json!({ "answer": "continue" }))
        );

        drop(alias_guard);
        assert!(!manager
            .response_session_aliases
            .read()
            .unwrap()
            .contains_key("child-session"));
    }

    #[tokio::test]
    async fn child_input_relay_preserves_identity_and_rejects_cross_session_forwarding() {
        let manager: &'static ActionRequiredManager =
            Box::leak(Box::new(ActionRequiredManager::new()));
        let _alias = manager
            .register_response_session_alias("relay-child", "relay-parent")
            .unwrap();
        let mut child_rx = manager
            .register_action_required_stream("relay-child".into(), "child-call".into())
            .await;
        let mut parent_rx = manager
            .register_action_required_stream("relay-parent".into(), "delegate-call".into())
            .await;
        let waiter = tokio::spawn(async move {
            manager
                .request_and_wait(
                    "relay-child".into(),
                    "child-call".into(),
                    "Choose a format".into(),
                    json!({"type":"object"}),
                    Duration::from_secs(5),
                )
                .await
        });
        let message = recv_elicitation_message(&mut child_rx).await;
        let original_id = elicitation_id(&message);
        assert!(manager
            .forward_child_elicitation(
                "relay-child",
                "another-parent",
                "delegate-call",
                message.clone()
            )
            .await
            .is_err());
        assert!(manager
            .forward_child_elicitation("relay-child", "relay-parent", "wrong-call", message.clone())
            .await
            .is_err());
        manager
            .forward_child_elicitation("relay-child", "relay-parent", "delegate-call", message)
            .await
            .unwrap();
        let shown = recv_elicitation_message(&mut parent_rx).await;
        assert_eq!(elicitation_id(&shown), original_id);
        assert!(manager
            .claim_response("another-parent", &original_id)
            .await
            .is_err());
        manager
            .claim_response("relay-parent", &original_id)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Decline)
            .unwrap();
        assert_eq!(waiter.await.unwrap().unwrap(), ElicitationOutcome::Decline);
        assert!(manager
            .claim_response("relay-parent", &original_id)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn streams_only_requested_tool_call() {
        let manager = Arc::new(ActionRequiredManager::new());
        let mut stream_a = manager
            .register_action_required_stream("session-a".to_string(), "tool-call-a".to_string())
            .await;
        let mut stream_b = manager
            .register_action_required_stream("session-b".to_string(), "tool-call-b".to_string())
            .await;
        let waiter_a = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .request_and_wait(
                        "session-a".to_string(),
                        "tool-call-a".to_string(),
                        "Need input A".to_string(),
                        json!({ "type": "object" }),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };
        let waiter_b = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .request_and_wait(
                        "session-b".to_string(),
                        "tool-call-b".to_string(),
                        "Need input B".to_string(),
                        json!({ "type": "object" }),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };

        let message_a = recv_elicitation_message(&mut stream_a).await;
        let request_id_a = elicitation_id(&message_a);
        assert!(stream_a.try_recv().is_err());

        let message_b = recv_elicitation_message(&mut stream_b).await;
        let request_id_b = elicitation_id(&message_b);

        manager
            .claim_response("session-a", &request_id_a)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Accept(json!({ "answer": "a" })))
            .unwrap();
        manager
            .claim_response("session-b", &request_id_b)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Accept(json!({ "answer": "b" })))
            .unwrap();

        assert_eq!(
            waiter_a.await.unwrap().unwrap(),
            ElicitationOutcome::Accept(json!({ "answer": "a" }))
        );
        assert_eq!(
            waiter_b.await.unwrap().unwrap(),
            ElicitationOutcome::Accept(json!({ "answer": "b" }))
        );
    }

    #[tokio::test]
    async fn streams_are_namespaced_by_session() {
        let manager = Arc::new(ActionRequiredManager::new());
        let mut stream_a = manager
            .register_action_required_stream("session-a".to_string(), "tool-call-a".to_string())
            .await;
        let mut stream_b = manager
            .register_action_required_stream("session-b".to_string(), "tool-call-a".to_string())
            .await;
        let waiter_a = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .request_and_wait(
                        "session-a".to_string(),
                        "tool-call-a".to_string(),
                        "Need input A".to_string(),
                        json!({ "type": "object" }),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };
        let waiter_b = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .request_and_wait(
                        "session-b".to_string(),
                        "tool-call-a".to_string(),
                        "Need input B".to_string(),
                        json!({ "type": "object" }),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };

        let message_a = recv_elicitation_message(&mut stream_a).await;
        let request_id_a = elicitation_id(&message_a);
        let message_b = recv_elicitation_message(&mut stream_b).await;
        let request_id_b = elicitation_id(&message_b);

        manager
            .claim_response("session-a", &request_id_a)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Accept(json!({ "answer": "a" })))
            .unwrap();
        manager
            .claim_response("session-b", &request_id_b)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Accept(json!({ "answer": "b" })))
            .unwrap();

        assert_eq!(
            waiter_a.await.unwrap().unwrap(),
            ElicitationOutcome::Accept(json!({ "answer": "a" }))
        );
        assert_eq!(
            waiter_b.await.unwrap().unwrap(),
            ElicitationOutcome::Accept(json!({ "answer": "b" }))
        );
    }

    #[tokio::test]
    async fn claimed_response_can_complete_after_timeout_deadline() {
        let manager = Arc::new(ActionRequiredManager::new());
        let mut action_required_rx = manager
            .register_action_required_stream("session-a".to_string(), "tool-call-a".to_string())
            .await;
        let waiter = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .request_and_wait(
                        "session-a".to_string(),
                        "tool-call-a".to_string(),
                        "Need input".to_string(),
                        json!({ "type": "object" }),
                        Duration::from_millis(25),
                    )
                    .await
            })
        };

        let message = recv_elicitation_message(&mut action_required_rx).await;
        let request_id = elicitation_id(&message);

        let claim = manager
            .claim_response("session-a", &request_id)
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(50)).await;

        claim
            .submit(ElicitationOutcome::Accept(json!({ "answer": "late" })))
            .unwrap();

        assert_eq!(
            waiter.await.unwrap().unwrap(),
            ElicitationOutcome::Accept(json!({ "answer": "late" }))
        );
    }

    #[tokio::test]
    async fn request_and_wait_returns_decline_and_cancel_actions() {
        let manager = Arc::new(ActionRequiredManager::new());
        let mut decline_rx = manager
            .register_action_required_stream("session-a".to_string(), "tool-call-a".to_string())
            .await;
        let mut cancel_rx = manager
            .register_action_required_stream("session-b".to_string(), "tool-call-b".to_string())
            .await;
        let decline_waiter = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .request_and_wait(
                        "session-a".to_string(),
                        "tool-call-a".to_string(),
                        "Need input A".to_string(),
                        json!({ "type": "object" }),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };
        let cancel_waiter = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .request_and_wait(
                        "session-b".to_string(),
                        "tool-call-b".to_string(),
                        "Need input B".to_string(),
                        json!({ "type": "object" }),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };

        let decline_message = recv_elicitation_message(&mut decline_rx).await;
        let decline_request_id = elicitation_id(&decline_message);
        let cancel_message = recv_elicitation_message(&mut cancel_rx).await;
        let cancel_request_id = elicitation_id(&cancel_message);

        manager
            .claim_response("session-a", &decline_request_id)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Decline)
            .unwrap();
        manager
            .claim_response("session-b", &cancel_request_id)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Cancel)
            .unwrap();

        assert_eq!(
            decline_waiter.await.unwrap().unwrap(),
            ElicitationOutcome::Decline
        );
        assert_eq!(
            cancel_waiter.await.unwrap().unwrap(),
            ElicitationOutcome::Cancel
        );
    }

    #[tokio::test]
    async fn missing_tool_call_stream_errors() {
        let manager = Arc::new(ActionRequiredManager::new());

        let result = manager
            .request_and_wait(
                "session-a".to_string(),
                "missing-tool-call".to_string(),
                "Need input".to_string(),
                json!({ "type": "object" }),
                Duration::from_secs(5),
            )
            .await;

        let err = result.expect_err("request should fail without a registered stream");
        assert!(err
            .to_string()
            .contains("Tool call request not found for elicitation"));
    }

    #[tokio::test]
    async fn closed_tool_call_stream_errors() {
        let manager = Arc::new(ActionRequiredManager::new());
        let rx = manager
            .register_action_required_stream("session-a".to_string(), "tool-call-a".to_string())
            .await;
        drop(rx);

        let result = manager
            .request_and_wait(
                "session-a".to_string(),
                "tool-call-a".to_string(),
                "Need input".to_string(),
                json!({ "type": "object" }),
                Duration::from_secs(5),
            )
            .await;

        let err = result.expect_err("request should fail when stream is closed");
        assert!(err
            .to_string()
            .contains("Tool call action-required stream closed"));
    }

    #[tokio::test]
    async fn ask_user_flow_timed_out_elicitation_retains_a_typed_cause() {
        let manager = Arc::new(ActionRequiredManager::new());
        let _stream = manager
            .register_action_required_stream("session-a".to_string(), "tool-call-a".to_string())
            .await;

        let error = manager
            .request_and_wait(
                "session-a".to_string(),
                "tool-call-a".to_string(),
                "Need input".to_string(),
                json!({ "type": "object" }),
                Duration::from_millis(1),
            )
            .await
            .expect_err("unanswered question should time out");

        assert!(error.is::<tokio::time::error::Elapsed>());
        assert_eq!(error.to_string(), "Timeout waiting for user response");
    }
}
