use super::ProtocolError;
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use std::path::{Component, Path, PathBuf};

const MAX_IDENTIFIER_BYTES: usize = 128;

fn validate_identifier(kind: &'static str, value: String) -> Result<String, ProtocolError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'));
    if valid {
        Ok(value)
    } else {
        Err(ProtocolError::InvalidIdentifier { kind, value })
    }
}

macro_rules! protocol_id {
    ($name:ident, $kind:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ProtocolError> {
                validate_identifier($kind, value.into()).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

protocol_id!(RunId, "run_id");
protocol_id!(TaskId, "task_id");
protocol_id!(AgentId, "agent_id");
protocol_id!(EventId, "event_id");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceRef {
    run_id: RunId,
    event_id: EventId,
    artifact_ref: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidenceRefWire {
    run_id: RunId,
    event_id: EventId,
    artifact_ref: PathBuf,
}

impl<'de> Deserialize<'de> for EvidenceRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = EvidenceRefWire::deserialize(deserializer)?;
        Self::new(wire.run_id, wire.event_id, wire.artifact_ref).map_err(serde::de::Error::custom)
    }
}

impl EvidenceRef {
    pub fn new(
        run_id: RunId,
        event_id: EventId,
        artifact_ref: impl Into<PathBuf>,
    ) -> Result<Self, ProtocolError> {
        let artifact_ref = artifact_ref.into();
        validate_artifact_ref(&artifact_ref)?;
        Ok(Self {
            run_id,
            event_id,
            artifact_ref,
        })
    }

    pub fn validate_for_run(&self, run_id: &RunId) -> Result<(), ProtocolError> {
        validate_artifact_ref(&self.artifact_ref)?;
        if &self.run_id == run_id {
            Ok(())
        } else {
            Err(ProtocolError::CrossRunEvidence {
                expected: run_id.to_string(),
                actual: self.run_id.to_string(),
            })
        }
    }

    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }

    pub fn event_id(&self) -> &EventId {
        &self.event_id
    }

    pub fn artifact_ref(&self) -> &std::path::Path {
        &self.artifact_ref
    }
}

fn validate_artifact_ref(path: &Path) -> Result<(), ProtocolError> {
    let display = path.to_string_lossy();
    let normalized = display.replace('\\', "/");
    let has_windows_prefix = normalized
        .split('/')
        .next()
        .is_some_and(|segment| segment.ends_with(':'));
    let invalid_component = path.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir | Component::CurDir
        )
    });
    let invalid_segment = normalized
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."));
    if display.is_empty()
        || path.is_absolute()
        || has_windows_prefix
        || invalid_component
        || invalid_segment
    {
        Err(ProtocolError::InvalidArtifactRef(display.into_owned()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialization_cannot_bypass_identifier_validation() {
        assert!(serde_json::from_str::<RunId>(r#""run-1""#).is_ok());
        assert!(serde_json::from_str::<RunId>(r#""../run""#).is_err());
    }

    #[test]
    fn artifact_references_are_relative_and_normalized() {
        let run_id = RunId::new("run-1").unwrap();
        let event_id = EventId::new("event-1").unwrap();
        assert!(EvidenceRef::new(run_id.clone(), event_id.clone(), "artifacts/out.txt").is_ok());
        assert!(EvidenceRef::new(run_id.clone(), event_id.clone(), "../out.txt").is_err());
        assert!(EvidenceRef::new(run_id, event_id, r"C:\out.txt").is_err());
        assert!(serde_json::from_str::<EvidenceRef>(
            r#"{"run_id":"run-1","event_id":"event-1","artifact_ref":"../out.txt"}"#
        )
        .is_err());
    }
}
