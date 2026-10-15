use crate::conversation::message::Message;
use crate::session::Session;
use anyhow::{anyhow, ensure, Result};
use rmcp::model::Role;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const KEY: &str = "codepro_clarification.v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MessageLink {
    pub id: String,
    pub content_sha256: String,
}

impl MessageLink {
    pub fn new(message: &Message) -> Result<Self> {
        Ok(Self {
            id: message
                .id
                .clone()
                .ok_or_else(|| anyhow!("Clarification message has no ID"))?,
            content_sha256: Sha256::digest(serde_json::to_vec(&message.content)?)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        })
    }

    pub fn verify(&self, message: &Message, role: Role) -> Result<()> {
        ensure!(
            message.role == role && message.is_user_visible() && *self == Self::new(message)?,
            "Clarification source message changed or has the wrong role"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ClarificationStatus {
    Pending,
    Prepared { answer: MessageLink },
    Started { answer: MessageLink },
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClarificationState {
    pub session_id: String,
    pub workspace: std::path::PathBuf,
    pub source: MessageLink,
    pub question: MessageLink,
    pub previous_answers: Vec<MessageLink>,
    pub last_input: Option<ClarificationReply>,
    pub execution_run_id: Option<String>,
    pub status: ClarificationStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClarificationReply {
    pub message: MessageLink,
    pub notice: Option<String>,
}

impl ClarificationState {
    pub fn answer_for_input<'a>(
        &self,
        session: &'a Session,
        user: &Message,
    ) -> Result<Option<&'a Message>> {
        let (ClarificationStatus::Prepared { answer } | ClarificationStatus::Started { answer }) =
            &self.status
        else {
            return Ok(None);
        };
        if Some(answer.id.as_str()) == user.id.as_deref() {
            answer.verify(user, Role::User)?;
        } else if let Some(reply) = self.last_input.as_ref().filter(|reply| {
            Some(reply.message.id.as_str()) == user.id.as_deref() && reply.notice.is_none()
        }) {
            reply.message.verify(user, Role::User)?;
        } else {
            return Ok(None);
        }
        self.message(session, answer, Role::User).map(Some)
    }

    pub fn read(session: &Session) -> Result<Option<Self>> {
        session
            .extension_data
            .extension_states
            .get(KEY)
            .map(|value| serde_json::from_value(value.clone()).map_err(Into::into))
            .transpose()
    }

    pub fn message<'a>(
        &self,
        session: &'a Session,
        link: &MessageLink,
        role: Role,
    ) -> Result<&'a Message> {
        let messages = session
            .conversation
            .as_ref()
            .ok_or_else(|| anyhow!("Clarification history unavailable"))?;
        let mut matched = messages
            .messages()
            .iter()
            .filter(|message| message.id.as_deref() == Some(&link.id));
        let message = matched
            .next()
            .ok_or_else(|| anyhow!("Clarification source message missing"))?;
        ensure!(
            matched.next().is_none(),
            "Clarification message ID is ambiguous"
        );
        link.verify(message, role)?;
        Ok(message)
    }

    pub fn context(&self, session: &Session, answer: Option<&Message>) -> Result<String> {
        ensure!(
            self.session_id == session.id
                && self.workspace == session.working_dir.canonicalize()?,
            "Clarification belongs to another session or workspace"
        );
        let source = self.message(session, &self.source, Role::User)?;
        let question = self.message(session, &self.question, Role::Assistant)?;
        let mut context = format!(
            "原始用户目标：\n{}\n",
            source.agent_visible_content().as_concat_text()
        );
        for link in &self.previous_answers {
            context.push_str(&format!(
                "\n此前用户补充：\n{}\n",
                self.message(session, link, Role::User)?
                    .agent_visible_content()
                    .as_concat_text()
            ));
        }
        context.push_str(&format!(
            "\n需要澄清的问题：\n{}\n",
            question.agent_visible_content().as_concat_text()
        ));
        if let Some(answer) = answer {
            context.push_str(&format!(
                "\n用户对该问题的回答：\n{}",
                answer.agent_visible_content().as_concat_text()
            ));
        }
        Ok(context)
    }
}
