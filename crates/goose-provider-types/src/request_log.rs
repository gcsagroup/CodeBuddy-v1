use std::{
    error::Error,
    fmt::Display,
    sync::{Arc, OnceLock},
};

use serde::Serialize;
use serde_json::json;

use crate::conversation::token_usage::Usage;

type RequestLogError = Box<dyn Error + Send + Sync>;

static LOGGER: OnceLock<Arc<dyn RequestLogger>> = OnceLock::new();

/// Opt-in, content-free timing. Explicit GOOSE_STREAM_DIAGNOSTICS=1 also
/// enables diagnostic correlation. Never persisted as conversation metadata or
/// sent back to the model. Body arrival means reqwest delivered a chunk to us,
/// not the time a packet reached the network interface.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamTiming {
    pub request_id: String,
    pub parsed_sequence: u64,
}

impl StreamTiming {
    pub fn start() -> Option<Self> {
        static ENABLED: OnceLock<bool> = OnceLock::new();
        let enabled = *ENABLED.get_or_init(|| {
            std::env::var("GOOSE_STREAM_TIMING")
                .map(|value| value == "1")
                .unwrap_or(false)
        });
        // Explicit diagnostics also needs a correlation ID in release builds.
        (enabled || std::env::var("GOOSE_STREAM_DIAGNOSTICS").is_ok_and(|value| value == "1")).then(
            || Self {
                request_id: uuid::Uuid::new_v4().to_string(),
                parsed_sequence: 0,
            },
        )
    }

    pub fn record(&self, stage: &'static str, sequence: u64, size: usize) {
        tracing::info!(target: "goose::stream_timing", request_id = %self.request_id,
            at_ms = chrono::Utc::now().timestamp_millis(), stage, sequence, size,
            parsed_sequence = self.parsed_sequence, "stream timing");
    }
}

#[derive(Debug)]
pub struct LoggerAlreadyInstalled;

impl Display for LoggerAlreadyInstalled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "request logger is already installed")
    }
}

impl Error for LoggerAlreadyInstalled {}

pub fn install_logger<R: RequestLogger + 'static>(r: R) -> Result<(), LoggerAlreadyInstalled> {
    LOGGER.set(Arc::new(r)).map_err(|_| LoggerAlreadyInstalled)
}

pub trait RequestLogger: Send + Sync {
    fn start(&self) -> Result<Box<dyn RequestLogHandle>, RequestLogError>;
}

pub trait RequestLogHandle: Send {
    fn write(&mut self, s: &str) -> Result<(), RequestLogError>;
}

#[derive(Debug)]
pub enum LogError {
    LoggerError(String),
    SerializeError(serde_json::Error),
}

impl Display for LogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogError::LoggerError(msg) => write!(f, "{}", msg),
            LogError::SerializeError(error) => write!(f, "serialize error: {}", error),
        }
    }
}

impl Error for LogError {}

impl From<RequestLogError> for LogError {
    fn from(value: RequestLogError) -> Self {
        Self::LoggerError(value.to_string())
    }
}

fn serialize(v: &serde_json::Value) -> Result<String, LogError> {
    serde_json::to_string(v).map_err(LogError::SerializeError)
}

pub fn start_log<M, P>(
    model_config: M,
    payload: P,
) -> Result<Option<Box<dyn RequestLogHandle>>, LogError>
where
    M: Serialize,
    P: Serialize,
{
    let logger = if let Some(logger) = LOGGER.get() {
        logger
    } else {
        return Ok(None);
    };

    let mut handle = logger.start()?;
    let payload = json!({
        "model_config": model_config,
        "input": payload,
    });

    handle.write(serialize(&payload)?.as_str())?;
    Ok(Some(handle))
}

pub trait LoggerHandleExt {
    fn write<Payload>(&mut self, data: &Payload, usage: Option<&Usage>) -> Result<(), LogError>
    where
        Payload: Serialize;
    fn error<E>(&mut self, error: E) -> Result<(), LogError>
    where
        E: Display;
}

impl LoggerHandleExt for Option<Box<dyn RequestLogHandle>> {
    fn write<Payload>(&mut self, data: &Payload, usage: Option<&Usage>) -> Result<(), LogError>
    where
        Payload: Serialize,
    {
        let log = if let Some(log) = self {
            log
        } else {
            return Ok(());
        };

        let line = serialize(&json!({
            "data": data,
            "usage": usage,
        }))?;

        Ok(log.write(line.as_str())?)
    }

    fn error<E>(&mut self, error: E) -> Result<(), LogError>
    where
        E: Display,
    {
        let log = if let Some(log) = self {
            log
        } else {
            return Ok(());
        };

        let line = serialize(&json!({
            "error": format!("{}", error),
        }))?;

        Ok(log.write(line.as_str())?)
    }
}
