use super::*;
#[cfg(feature = "local-inference")]
use crate::dictation::providers::transcribe_local;
use crate::dictation::providers::{
    all_providers, get_provider_def, is_configured, transcribe_with_provider, DictationProvider,
};
#[cfg(feature = "local-inference")]
use crate::dictation::whisper;
#[cfg(any(feature = "local-inference", test))]
use fs2::FileExt;
#[cfg(any(feature = "local-inference", test))]
use std::{
    fs::{File, OpenOptions},
    path::Path,
    sync::{Mutex, MutexGuard, OnceLock},
};

const OPENAI_TRANSCRIPTION_MODEL_CONFIG_KEY: &str = "OPENAI_TRANSCRIPTION_MODEL";
const GROQ_TRANSCRIPTION_MODEL_CONFIG_KEY: &str = "GROQ_TRANSCRIPTION_MODEL";
const ELEVENLABS_TRANSCRIPTION_MODEL_CONFIG_KEY: &str = "ELEVENLABS_TRANSCRIPTION_MODEL";
const OPENAI_TRANSCRIPTION_MODEL: &str = "whisper-1";
const GROQ_TRANSCRIPTION_MODEL: &str = "whisper-large-v3-turbo";
const ELEVENLABS_TRANSCRIPTION_MODEL: &str = "scribe_v1";

#[cfg(any(feature = "local-inference", test))]
static LOCAL_MODEL_LIFECYCLE_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(any(feature = "local-inference", test))]
#[derive(Debug, thiserror::Error)]
enum LocalModelLifecycleError {
    #[error("the active local dictation model is controlled by the environment")]
    EnvironmentOwned,
    #[error("the local dictation model is not downloaded")]
    ModelNotDownloaded,
    #[error("the local dictation model path is not a regular file")]
    InvalidModelFile,
    #[error("the local dictation model selection remains active after clearing writable state")]
    SelectionStillActive,
    #[error("local dictation model configuration failed")]
    Config(#[source] crate::config::ConfigError),
    #[error("local dictation model filesystem operation failed")]
    Io(#[source] std::io::Error),
    #[error("the local dictation model lifecycle lock was poisoned")]
    LockPoisoned,
}

#[cfg(any(feature = "local-inference", test))]
struct LocalModelLifecycleGuard {
    _process_guard: MutexGuard<'static, ()>,
    _file: File,
}

#[cfg(any(feature = "local-inference", test))]
fn acquire_local_model_lifecycle_lock_at(
    lock_path: &Path,
) -> Result<LocalModelLifecycleGuard, LocalModelLifecycleError> {
    let process_guard = LOCAL_MODEL_LIFECYCLE_MUTEX
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| LocalModelLifecycleError::LockPoisoned)?;
    if let Some(parent) = lock_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(LocalModelLifecycleError::Io)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(LocalModelLifecycleError::Io)?;
    file.lock_exclusive()
        .map_err(LocalModelLifecycleError::Io)?;
    Ok(LocalModelLifecycleGuard {
        _process_guard: process_guard,
        _file: file,
    })
}

#[cfg(any(feature = "local-inference", test))]
fn ensure_downloaded_local_model_file(path: &Path) -> Result<(), LocalModelLifecycleError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(LocalModelLifecycleError::ModelNotDownloaded);
        }
        Err(error) => return Err(LocalModelLifecycleError::Io(error)),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(LocalModelLifecycleError::InvalidModelFile);
    }
    Ok(())
}

#[cfg(feature = "local-inference")]
fn is_downloaded_local_model_file(path: &Path) -> bool {
    ensure_downloaded_local_model_file(path).is_ok()
}

#[cfg(any(feature = "local-inference", test))]
fn configured_local_model_id(config: &Config) -> Result<Option<String>, LocalModelLifecycleError> {
    let values = config
        .merged_values_snapshot()
        .map_err(LocalModelLifecycleError::Config)?;
    values
        .get("LOCAL_WHISPER_MODEL")
        .cloned()
        .map(serde_yaml::from_value::<String>)
        .transpose()
        .map_err(crate::config::ConfigError::from)
        .map_err(LocalModelLifecycleError::Config)
        .map(|value| {
            value.and_then(|value| {
                let value = value.trim();
                (!value.is_empty()).then(|| value.to_string())
            })
        })
}

#[cfg(any(feature = "local-inference", test))]
fn select_local_model_at(
    config: &Config,
    model_id: &str,
    model_path: &Path,
    lock_path: &Path,
    active_environment_model: Option<&str>,
) -> Result<(), LocalModelLifecycleError> {
    let _guard = acquire_local_model_lifecycle_lock_at(lock_path)?;
    if active_environment_model.is_some() {
        return Err(LocalModelLifecycleError::EnvironmentOwned);
    }
    ensure_downloaded_local_model_file(model_path)?;
    config
        .set_param("LOCAL_WHISPER_MODEL", model_id)
        .map_err(LocalModelLifecycleError::Config)
}

#[cfg(any(feature = "local-inference", test))]
fn delete_local_model_at(
    config: &Config,
    model_id: &str,
    model_path: &Path,
    lock_path: &Path,
    active_environment_model: Option<&str>,
    remove_file: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), LocalModelLifecycleError> {
    let _guard = acquire_local_model_lifecycle_lock_at(lock_path)?;
    if active_environment_model.is_some_and(|active| active == model_id) {
        return Err(LocalModelLifecycleError::EnvironmentOwned);
    }
    if configured_local_model_id(config)?.as_deref() == Some(model_id) {
        config
            .delete("LOCAL_WHISPER_MODEL")
            .map_err(LocalModelLifecycleError::Config)?;
        if configured_local_model_id(config)?.as_deref() == Some(model_id) {
            return Err(LocalModelLifecycleError::SelectionStillActive);
        }
    }
    ensure_downloaded_local_model_file(model_path)?;
    remove_file(model_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            LocalModelLifecycleError::ModelNotDownloaded
        } else {
            LocalModelLifecycleError::Io(error)
        }
    })
}

#[cfg(any(feature = "local-inference", test))]
fn auto_select_downloaded_local_model_at(
    config: &Config,
    model_id: &str,
    model_path: &Path,
    lock_path: &Path,
    active_environment_model: Option<&str>,
    selected_model_is_downloaded: impl FnOnce(&str) -> bool,
) -> Result<bool, LocalModelLifecycleError> {
    let _guard = acquire_local_model_lifecycle_lock_at(lock_path)?;
    ensure_downloaded_local_model_file(model_path)?;
    if active_environment_model.is_some() {
        return Ok(false);
    }
    if configured_local_model_id(config)?
        .as_deref()
        .is_some_and(selected_model_is_downloaded)
    {
        return Ok(false);
    }
    config
        .set_param("LOCAL_WHISPER_MODEL", model_id)
        .map_err(LocalModelLifecycleError::Config)?;
    Ok(true)
}

#[cfg(feature = "local-inference")]
fn active_local_model_environment() -> Option<String> {
    std::env::var_os(whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY)
        .map(|value| value.to_string_lossy().trim().to_string())
}

#[cfg(feature = "local-inference")]
fn local_dictation_model_statuses() -> Vec<DictationLocalModelStatus> {
    use crate::download_manager::{get_download_manager, DownloadStatus};

    let manager = get_download_manager();
    let recommended_id = whisper::recommend_model();
    whisper::available_models()
        .iter()
        .map(|model| DictationLocalModelStatus {
            id: model.id.to_string(),
            label: model.id.to_string(),
            description: model.description.to_string(),
            size_mb: model.size_mb,
            downloaded: is_downloaded_local_model_file(&model.local_path()),
            download_in_progress: manager
                .get_progress(model.id)
                .map(|progress| progress.status == DownloadStatus::Downloading)
                .unwrap_or(false),
            recommended: model.id == recommended_id,
        })
        .collect()
}

#[cfg(feature = "local-inference")]
fn local_model_lifecycle_lock_path() -> std::path::PathBuf {
    crate::config::paths::Paths::models_dir().join(".dictation-model-lifecycle.lock")
}

#[cfg(feature = "local-inference")]
fn local_model_lifecycle_error(error: LocalModelLifecycleError) -> agent_client_protocol::Error {
    match error {
        LocalModelLifecycleError::EnvironmentOwned => {
            agent_client_protocol::Error::invalid_params()
                .data("The active local dictation model is controlled by the environment")
        }
        LocalModelLifecycleError::ModelNotDownloaded => {
            agent_client_protocol::Error::invalid_params().data("Model not downloaded")
        }
        LocalModelLifecycleError::InvalidModelFile => {
            agent_client_protocol::Error::invalid_params().data("Local model file is invalid")
        }
        error => {
            error!(error = %error, "Local dictation model lifecycle operation failed");
            agent_client_protocol::Error::internal_error()
                .data("Local dictation model lifecycle operation failed")
        }
    }
}

impl GooseAcpAgent {
    pub(super) async fn on_dictation_transcribe(
        &self,
        req: DictationTranscribeRequest,
    ) -> Result<DictationTranscribeResponse, agent_client_protocol::Error> {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
        let config = crate::config::Config::global();

        #[cfg(not(feature = "local-inference"))]
        if req.provider == "local" {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("Local inference is not available in this build"));
        }

        let provider: DictationProvider = serde_json::from_value(serde_json::Value::String(
            req.provider.clone(),
        ))
        .map_err(|_| {
            agent_client_protocol::Error::invalid_params()
                .data(format!("Unknown provider: {}", req.provider))
        })?;

        let audio_bytes = BASE64.decode(&req.audio).map_err(|_| {
            agent_client_protocol::Error::invalid_params().data("Invalid base64 audio data")
        })?;

        if audio_bytes.len() > 50 * 1024 * 1024 {
            return Err(
                agent_client_protocol::Error::invalid_params().data("Audio too large (max 50MB)")
            );
        }

        let extension = match req.mime_type.as_str() {
            "audio/webm" | "audio/webm;codecs=opus" => "webm",
            "audio/mp4" => "mp4",
            "audio/mpeg" | "audio/mpga" => "mp3",
            "audio/m4a" => "m4a",
            "audio/wav" | "audio/x-wav" => "wav",
            other => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data(format!("Unsupported format: {other}")));
            }
        };

        let text = match provider {
            #[cfg(feature = "local-inference")]
            DictationProvider::Local => transcribe_local(audio_bytes).await,
            remote => {
                let (model_param, default_model) = dictation_transcribe_params(remote);
                let model = dictation_selected_model(config, remote)
                    .unwrap_or_else(|| default_model.to_string());
                transcribe_with_provider(
                    remote,
                    model_param.to_string(),
                    model,
                    audio_bytes,
                    extension,
                    &req.mime_type,
                )
                .await
            }
        }
        .internal_err()?;

        Ok(DictationTranscribeResponse { text })
    }

    pub(super) async fn on_dictation_config(
        &self,
        _req: DictationConfigRequest,
    ) -> Result<DictationConfigResponse, agent_client_protocol::Error> {
        let config = crate::config::Config::global();
        let mut providers = std::collections::HashMap::new();

        for def in all_providers() {
            let provider = def.provider;
            let host = if let Some(host_key) = def.host_key {
                config
                    .get(host_key, false)
                    .ok()
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
            } else {
                None
            };

            let provider_key = serde_json::to_value(provider)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| format!("{:?}", provider).to_lowercase());
            providers.insert(
                provider_key,
                DictationProviderStatusEntry {
                    configured: is_configured(provider),
                    host,
                    description: def.description.to_string(),
                    uses_provider_config: def.uses_provider_config,
                    settings_path: def.settings_path.map(|s| s.to_string()),
                    config_key: if !def.uses_provider_config {
                        Some(def.config_key.to_string())
                    } else {
                        None
                    },
                    model_config_key: dictation_model_config_key(provider),
                    default_model: dictation_default_model(provider),
                    selected_model: dictation_selected_model(config, provider),
                    available_models: dictation_available_models(provider),
                },
            );
        }

        Ok(DictationConfigResponse { providers })
    }

    pub(super) async fn on_dictation_secret_save(
        &self,
        req: DictationSecretSaveRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        let provider = parse_dictation_provider(&req.provider)?;
        let key = dictation_secret_config_key(provider)?;
        let config = self.config()?;
        config.set_secret(key, &req.value).internal_err()?;
        Config::global().invalidate_secrets_cache();
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_dictation_secret_delete(
        &self,
        req: DictationSecretDeleteRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        let provider = parse_dictation_provider(&req.provider)?;
        let key = dictation_secret_config_key(provider)?;
        let config = self.config()?;
        config.delete_secret(key).internal_err()?;
        Config::global().invalidate_secrets_cache();
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_dictation_models_list(
        &self,
        _req: DictationModelsListRequest,
    ) -> Result<DictationModelsListResponse, agent_client_protocol::Error> {
        #[cfg(feature = "local-inference")]
        {
            Ok(DictationModelsListResponse {
                models: local_dictation_model_statuses(),
            })
        }

        #[cfg(not(feature = "local-inference"))]
        Ok(DictationModelsListResponse::default())
    }

    pub(super) async fn on_dictation_model_download(
        &self,
        _req: DictationModelDownloadRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        #[cfg(feature = "local-inference")]
        {
            use crate::download_manager::get_download_manager;

            let model = whisper::get_model(&_req.model_id).ok_or_else(|| {
                agent_client_protocol::Error::invalid_params().data("Unknown model id")
            })?;
            let manager = get_download_manager();
            let model_id_for_config = model.id.to_string();
            let model_path_for_config = model.local_path();

            manager
                .download_model(
                    model.id.to_string(),
                    model.url.to_string(),
                    model.local_path(),
                    Some(Box::new(move || {
                        let config = crate::config::Config::global();
                        let active_environment_model = active_local_model_environment();
                        if let Err(error) = auto_select_downloaded_local_model_at(
                            config,
                            &model_id_for_config,
                            &model_path_for_config,
                            &local_model_lifecycle_lock_path(),
                            active_environment_model.as_deref(),
                            |selected| {
                                whisper::get_model(selected).is_some_and(|selected| {
                                    is_downloaded_local_model_file(&selected.local_path())
                                })
                            },
                        ) {
                            error!(error = %error, "Failed to auto-select downloaded local dictation model");
                        }
                    })),
                )
                .await
                .internal_err()?;

            Ok(EmptyResponse {})
        }

        #[cfg(not(feature = "local-inference"))]
        Err(agent_client_protocol::Error::invalid_params().data("Local inference not enabled"))
    }

    pub(super) async fn on_dictation_model_download_progress(
        &self,
        _req: DictationModelDownloadProgressRequest,
    ) -> Result<DictationModelDownloadProgressResponse, agent_client_protocol::Error> {
        #[cfg(feature = "local-inference")]
        {
            use crate::download_manager::get_download_manager;

            let manager = get_download_manager();
            let progress =
                manager
                    .get_progress(&_req.model_id)
                    .map(|progress| DictationDownloadProgress {
                        bytes_downloaded: progress.bytes_downloaded,
                        total_bytes: progress.total_bytes,
                        progress_percent: progress.progress_percent,
                        status: serde_json::to_value(&progress.status)
                            .ok()
                            .and_then(|value| value.as_str().map(ToOwned::to_owned))
                            .unwrap_or_else(|| "unknown".to_string()),
                        error: progress.error,
                    });

            Ok(DictationModelDownloadProgressResponse { progress })
        }

        #[cfg(not(feature = "local-inference"))]
        Ok(DictationModelDownloadProgressResponse { progress: None })
    }

    pub(super) async fn on_dictation_model_cancel(
        &self,
        _req: DictationModelCancelRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        #[cfg(feature = "local-inference")]
        {
            use crate::download_manager::get_download_manager;

            let manager = get_download_manager();
            manager.cancel_download(&_req.model_id).internal_err()?;

            Ok(EmptyResponse {})
        }

        #[cfg(not(feature = "local-inference"))]
        Err(agent_client_protocol::Error::invalid_params().data("Local inference not enabled"))
    }

    pub(super) async fn on_dictation_model_delete(
        &self,
        _req: DictationModelDeleteRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        #[cfg(feature = "local-inference")]
        {
            let model = whisper::get_model(&_req.model_id).ok_or_else(|| {
                agent_client_protocol::Error::invalid_params().data("Unknown model id")
            })?;
            let path = model.local_path();
            let active_environment_model = active_local_model_environment();
            delete_local_model_at(
                crate::config::Config::global(),
                model.id,
                &path,
                &local_model_lifecycle_lock_path(),
                active_environment_model.as_deref(),
                |path| std::fs::remove_file(path),
            )
            .map_err(local_model_lifecycle_error)?;

            Ok(EmptyResponse {})
        }

        #[cfg(not(feature = "local-inference"))]
        Err(agent_client_protocol::Error::invalid_params().data("Local inference not enabled"))
    }

    pub(super) async fn on_dictation_model_select(
        &self,
        req: DictationModelSelectRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        #[cfg(not(feature = "local-inference"))]
        if req.provider == "local" {
            return Err(
                agent_client_protocol::Error::invalid_params().data("Local inference not enabled")
            );
        }

        let provider: DictationProvider = serde_json::from_value(serde_json::Value::String(
            req.provider.clone(),
        ))
        .map_err(|_| {
            agent_client_protocol::Error::invalid_params()
                .data(format!("Unknown provider: {}", req.provider))
        })?;

        let key = match provider {
            DictationProvider::OpenAI => OPENAI_TRANSCRIPTION_MODEL_CONFIG_KEY,
            DictationProvider::Groq => GROQ_TRANSCRIPTION_MODEL_CONFIG_KEY,
            DictationProvider::ElevenLabs => ELEVENLABS_TRANSCRIPTION_MODEL_CONFIG_KEY,
            #[cfg(feature = "local-inference")]
            DictationProvider::Local => {
                let model = whisper::get_model(&req.model_id).ok_or_else(|| {
                    agent_client_protocol::Error::invalid_params().data("Unknown model id")
                })?;
                let active_environment_model = active_local_model_environment();
                select_local_model_at(
                    crate::config::Config::global(),
                    model.id,
                    &model.local_path(),
                    &local_model_lifecycle_lock_path(),
                    active_environment_model.as_deref(),
                )
                .map_err(local_model_lifecycle_error)?;
                return Ok(EmptyResponse {});
            }
        };

        crate::config::Config::global()
            .set_param(key, req.model_id)
            .internal_err()?;

        Ok(EmptyResponse {})
    }
}

fn parse_dictation_provider(
    provider: &str,
) -> Result<DictationProvider, agent_client_protocol::Error> {
    serde_json::from_value(serde_json::Value::String(provider.to_string())).map_err(|_| {
        agent_client_protocol::Error::invalid_params().data(format!("Unknown provider: {provider}"))
    })
}

fn dictation_secret_config_key(
    provider: DictationProvider,
) -> Result<&'static str, agent_client_protocol::Error> {
    let def = get_provider_def(provider);
    if def.uses_provider_config {
        return Err(agent_client_protocol::Error::invalid_params().data(
            "Dictation provider uses the main provider configuration. Configure its credentials in provider settings instead.",
        ));
    }

    #[cfg(feature = "local-inference")]
    if provider == DictationProvider::Local {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("Dictation provider does not use an API key or secret."));
    }

    Ok(def.config_key)
}

fn dictation_model_config_key(provider: DictationProvider) -> Option<String> {
    match provider {
        DictationProvider::OpenAI => Some(OPENAI_TRANSCRIPTION_MODEL_CONFIG_KEY.to_string()),
        DictationProvider::Groq => Some(GROQ_TRANSCRIPTION_MODEL_CONFIG_KEY.to_string()),
        DictationProvider::ElevenLabs => {
            Some(ELEVENLABS_TRANSCRIPTION_MODEL_CONFIG_KEY.to_string())
        }
        #[cfg(feature = "local-inference")]
        DictationProvider::Local => Some(whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY.to_string()),
    }
}

/// Returns the (param_name, default_model) pair used by `transcribe_with_provider`
/// for remote dictation providers. Local inference is handled separately.
fn dictation_transcribe_params(provider: DictationProvider) -> (&'static str, &'static str) {
    match provider {
        DictationProvider::OpenAI => ("model", OPENAI_TRANSCRIPTION_MODEL),
        DictationProvider::Groq => ("model", GROQ_TRANSCRIPTION_MODEL),
        DictationProvider::ElevenLabs => ("model_id", ELEVENLABS_TRANSCRIPTION_MODEL),
        #[cfg(feature = "local-inference")]
        DictationProvider::Local => ("", ""),
    }
}

fn dictation_default_model(provider: DictationProvider) -> Option<String> {
    match provider {
        DictationProvider::OpenAI => Some(OPENAI_TRANSCRIPTION_MODEL.to_string()),
        DictationProvider::Groq => Some(GROQ_TRANSCRIPTION_MODEL.to_string()),
        DictationProvider::ElevenLabs => Some(ELEVENLABS_TRANSCRIPTION_MODEL.to_string()),
        #[cfg(feature = "local-inference")]
        DictationProvider::Local => Some(whisper::recommend_model().to_string()),
    }
}

fn dictation_selected_model(config: &Config, provider: DictationProvider) -> Option<String> {
    #[cfg(feature = "local-inference")]
    if provider == DictationProvider::Local {
        let selected = match active_local_model_environment() {
            Some(environment) => {
                let environment = environment.trim();
                (!environment.is_empty()).then(|| environment.to_string())
            }
            None => configured_local_model_id(config).ok().flatten(),
        };
        return selected.filter(|model_id| {
            whisper::get_model(model_id)
                .is_some_and(|model| is_downloaded_local_model_file(&model.local_path()))
        });
    }

    dictation_model_config_key(provider)
        .and_then(|key| {
            config
                .get(&key, false)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
        })
        .or_else(|| dictation_default_model(provider))
}

fn dictation_available_models(provider: DictationProvider) -> Vec<DictationModelOption> {
    match provider {
        DictationProvider::OpenAI => vec![DictationModelOption {
            id: OPENAI_TRANSCRIPTION_MODEL.to_string(),
            label: "Whisper-1".to_string(),
            description: "OpenAI's hosted Whisper transcription model.".to_string(),
        }],
        DictationProvider::Groq => vec![DictationModelOption {
            id: GROQ_TRANSCRIPTION_MODEL.to_string(),
            label: "Whisper Large V3 Turbo".to_string(),
            description: "Groq's fast hosted Whisper transcription model.".to_string(),
        }],
        DictationProvider::ElevenLabs => vec![DictationModelOption {
            id: ELEVENLABS_TRANSCRIPTION_MODEL.to_string(),
            label: "Scribe v1".to_string(),
            description: "ElevenLabs' hosted speech-to-text model.".to_string(),
        }],
        #[cfg(feature = "local-inference")]
        DictationProvider::Local => whisper::available_models()
            .iter()
            .map(|model| DictationModelOption {
                id: model.id.to_string(),
                label: model.id.to_string(),
                description: model.description.to_string(),
            })
            .collect(),
    }
}

#[cfg(all(test, windows))]
fn create_test_file_symlink(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_file(target, link).unwrap();
}

#[cfg(all(test, unix))]
fn create_test_file_symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(all(test, feature = "local-inference"))]
mod selected_model_tests {
    use super::*;

    #[test]
    fn local_selected_model_requires_an_existing_downloaded_file() {
        let root = tempfile::tempdir().unwrap();
        let root_value = root.path().to_string_lossy().to_string();
        let _env = env_lock::lock_env([
            ("CODEBUDDY_HOME", Some(root_value.as_str())),
            ("GOOSE_PATH_ROOT", None::<&str>),
            (whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, None::<&str>),
        ]);
        let config = Config::new(
            root.path().join("config.yaml"),
            "dictation-selected-model-test",
        )
        .unwrap();
        config
            .set_param(whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, "tiny")
            .unwrap();

        assert_eq!(
            dictation_selected_model(&config, DictationProvider::Local),
            None,
            "a catalog id without its model file is not an active selection"
        );
    }

    #[test]
    fn local_selected_model_rejects_directories_and_file_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let root_value = root.path().to_string_lossy().to_string();
        let _env = env_lock::lock_env([
            ("CODEBUDDY_HOME", Some(root_value.as_str())),
            ("GOOSE_PATH_ROOT", None::<&str>),
            (whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, None::<&str>),
        ]);
        let config = Config::new(
            root.path().join("config.yaml"),
            "dictation-selected-model-no-follow-test",
        )
        .unwrap();
        config
            .set_param(whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, "tiny")
            .unwrap();
        let model_path = whisper::get_model("tiny").unwrap().local_path();
        std::fs::create_dir_all(model_path.parent().unwrap()).unwrap();

        std::fs::create_dir(&model_path).unwrap();
        assert!(
            !local_dictation_model_statuses()
                .into_iter()
                .find(|model| model.id == "tiny")
                .unwrap()
                .downloaded
        );
        assert_eq!(
            dictation_selected_model(&config, DictationProvider::Local),
            None,
            "a directory must not be treated as a downloaded model"
        );
        std::fs::remove_dir(&model_path).unwrap();

        let target = root.path().join("outside-model.gguf");
        std::fs::write(&target, b"outside").unwrap();
        create_test_file_symlink(&target, &model_path);
        assert!(
            !local_dictation_model_statuses()
                .into_iter()
                .find(|model| model.id == "tiny")
                .unwrap()
                .downloaded
        );
        assert_eq!(
            dictation_selected_model(&config, DictationProvider::Local),
            None,
            "a file symlink must not be followed as a downloaded model"
        );
    }

    #[test]
    fn environment_authority_is_effective_while_deleting_a_latent_persisted_selection() {
        let root = tempfile::tempdir().unwrap();
        let root_value = root.path().to_string_lossy().to_string();
        let environment = env_lock::lock_env([
            ("CODEBUDDY_HOME", Some(root_value.as_str())),
            ("GOOSE_PATH_ROOT", None::<&str>),
            (whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, Some("base")),
        ]);
        let config = Config::new(
            root.path().join("config.yaml"),
            "dictation-environment-authority-test",
        )
        .unwrap();
        config
            .set_param(whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, "tiny")
            .unwrap();
        let tiny_path = whisper::get_model("tiny").unwrap().local_path();
        let base_path = whisper::get_model("base").unwrap().local_path();
        std::fs::create_dir_all(tiny_path.parent().unwrap()).unwrap();
        std::fs::write(&tiny_path, b"tiny").unwrap();
        std::fs::write(&base_path, b"base").unwrap();

        assert_eq!(
            dictation_selected_model(&config, DictationProvider::Local).as_deref(),
            Some("base"),
            "the nonblank environment value is the effective selection"
        );
        delete_local_model_at(
            &config,
            "tiny",
            &tiny_path,
            &root.path().join("lifecycle.lock"),
            Some("base"),
            |path| std::fs::remove_file(path),
        )
        .unwrap();
        assert!(!tiny_path.exists());

        drop(environment);
        assert!(matches!(
            config.get(whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, false),
            Err(crate::config::ConfigError::NotFound(_))
        ));
    }

    #[test]
    fn blank_environment_masks_persisted_selection_and_blocks_typed_select() {
        let root = tempfile::tempdir().unwrap();
        let root_value = root.path().to_string_lossy().to_string();
        let environment = env_lock::lock_env([
            ("CODEBUDDY_HOME", Some(root_value.as_str())),
            ("GOOSE_PATH_ROOT", None::<&str>),
            (whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, Some("   ")),
        ]);
        let config = Config::new(
            root.path().join("config.yaml"),
            "dictation-blank-environment-test",
        )
        .unwrap();
        config
            .set_param(whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, "tiny")
            .unwrap();
        let tiny_path = whisper::get_model("tiny").unwrap().local_path();
        std::fs::create_dir_all(tiny_path.parent().unwrap()).unwrap();
        std::fs::write(&tiny_path, b"tiny").unwrap();

        assert_eq!(
            dictation_selected_model(&config, DictationProvider::Local),
            None,
            "a present but blank environment value masks persisted state"
        );
        let active_environment = active_local_model_environment();
        assert!(active_environment.is_some());
        assert!(matches!(
            select_local_model_at(
                &config,
                "tiny",
                &tiny_path,
                &root.path().join("lifecycle.lock"),
                active_environment.as_deref(),
            ),
            Err(LocalModelLifecycleError::EnvironmentOwned)
        ));

        drop(environment);
        assert_eq!(
            config
                .get(whisper::LOCAL_WHISPER_MODEL_CONFIG_KEY, false)
                .unwrap()
                .as_str(),
            Some("tiny")
        );
    }
}

#[cfg(test)]
mod local_model_lifecycle_tests {
    use super::*;
    use std::io;

    fn test_config(root: &std::path::Path) -> Config {
        Config::new(root.join("config.yaml"), "dictation-lifecycle-test").unwrap()
    }

    #[cfg(feature = "local-inference")]
    #[test]
    fn lifecycle_error_mapper_redacts_internal_details_from_acp_data() {
        const PRIVATE_PATH: &str = r"C:\Users\private\dictation\lifecycle.lock";
        let errors = [
            LocalModelLifecycleError::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                PRIVATE_PATH,
            )),
            LocalModelLifecycleError::Config(crate::config::ConfigError::FileError(
                io::Error::new(io::ErrorKind::PermissionDenied, PRIVATE_PATH),
            )),
            LocalModelLifecycleError::SelectionStillActive,
        ];

        for internal in errors {
            let mapped = local_model_lifecycle_error(internal);
            assert_eq!(mapped.message, "Internal error");
            assert_eq!(
                mapped.data,
                Some(serde_json::json!(
                    "Local dictation model lifecycle operation failed"
                ))
            );
            let serialized = serde_json::to_string(&mapped).unwrap();
            assert!(!serialized.contains(PRIVATE_PATH));
            assert!(!serialized.contains("PermissionDenied"));
        }
    }

    #[test]
    fn selected_delete_failure_keeps_the_file_but_clears_the_selection() {
        let _env = env_lock::lock_env([("LOCAL_WHISPER_MODEL", None::<&str>)]);
        let root = tempfile::tempdir().unwrap();
        let config = test_config(root.path());
        let model_path = root.path().join("tiny.gguf");
        std::fs::write(&model_path, b"model").unwrap();
        config.set_param("LOCAL_WHISPER_MODEL", "tiny").unwrap();

        let error = delete_local_model_at(
            &config,
            "tiny",
            &model_path,
            &root.path().join("lifecycle.lock"),
            None,
            |_| Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected")),
        )
        .expect_err("the injected file deletion must fail");

        assert!(matches!(error, LocalModelLifecycleError::Io(_)));
        assert!(model_path.is_file());
        assert!(matches!(
            config.get("LOCAL_WHISPER_MODEL", false),
            Err(crate::config::ConfigError::NotFound(_))
        ));
    }

    #[test]
    fn lower_layer_selection_prevents_deleting_its_model_file() {
        let _env = env_lock::lock_env([("LOCAL_WHISPER_MODEL", None::<&str>)]);
        let root = tempfile::tempdir().unwrap();
        let lower_path = root.path().join("system.yaml");
        let write_path = root.path().join("user.yaml");
        std::fs::write(&lower_path, "LOCAL_WHISPER_MODEL: tiny\n").unwrap();
        let config = Config::new_with_config_paths(
            vec![lower_path, write_path],
            root.path().join("secrets.yaml"),
        )
        .unwrap();
        let model_path = root.path().join("tiny.gguf");
        std::fs::write(&model_path, b"model").unwrap();
        let remove_called = std::cell::Cell::new(false);

        let error = delete_local_model_at(
            &config,
            "tiny",
            &model_path,
            &root.path().join("lifecycle.lock"),
            None,
            |_| {
                remove_called.set(true);
                Ok(())
            },
        )
        .expect_err("a lower-layer active selection must fail closed before file deletion");

        assert!(error.to_string().contains("selection remains active"));
        assert!(!remove_called.get());
        assert!(model_path.is_file());
        assert_eq!(
            configured_local_model_id(&config).unwrap().as_deref(),
            Some("tiny")
        );
    }

    #[test]
    fn multi_layer_remove_failure_keeps_file_after_revealing_lower_selection() {
        let _env = env_lock::lock_env([("LOCAL_WHISPER_MODEL", None::<&str>)]);
        let root = tempfile::tempdir().unwrap();
        let lower_path = root.path().join("system.yaml");
        let write_path = root.path().join("user.yaml");
        std::fs::write(&lower_path, "LOCAL_WHISPER_MODEL: base\n").unwrap();
        std::fs::write(&write_path, "LOCAL_WHISPER_MODEL: tiny\n").unwrap();
        let config = Config::new_with_config_paths(
            vec![lower_path, write_path],
            root.path().join("secrets.yaml"),
        )
        .unwrap();
        let model_path = root.path().join("tiny.gguf");
        std::fs::write(&model_path, b"model").unwrap();

        let error = delete_local_model_at(
            &config,
            "tiny",
            &model_path,
            &root.path().join("lifecycle.lock"),
            None,
            |_| Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected")),
        )
        .expect_err("the injected file deletion must fail");

        assert!(matches!(error, LocalModelLifecycleError::Io(_)));
        assert!(model_path.is_file());
        assert_eq!(
            configured_local_model_id(&config).unwrap().as_deref(),
            Some("base")
        );
    }

    #[test]
    fn active_environment_target_cannot_be_deleted_or_overwritten() {
        let _env = env_lock::lock_env([("LOCAL_WHISPER_MODEL", None::<&str>)]);
        let root = tempfile::tempdir().unwrap();
        let config = test_config(root.path());
        let model_path = root.path().join("tiny.gguf");
        std::fs::write(&model_path, b"model").unwrap();
        config.set_param("LOCAL_WHISPER_MODEL", "tiny").unwrap();

        assert!(matches!(
            delete_local_model_at(
                &config,
                "tiny",
                &model_path,
                &root.path().join("lifecycle.lock"),
                Some("tiny"),
                |path| std::fs::remove_file(path),
            ),
            Err(LocalModelLifecycleError::EnvironmentOwned)
        ));
        assert!(model_path.is_file());
        assert_eq!(
            config.get("LOCAL_WHISPER_MODEL", false).unwrap().as_str(),
            Some("tiny")
        );

        assert!(matches!(
            select_local_model_at(
                &config,
                "tiny",
                &model_path,
                &root.path().join("lifecycle.lock"),
                Some("base"),
            ),
            Err(LocalModelLifecycleError::EnvironmentOwned)
        ));
    }

    #[test]
    fn download_callback_revalidates_the_file_after_acquiring_the_lifecycle_lock() {
        let _env = env_lock::lock_env([("LOCAL_WHISPER_MODEL", None::<&str>)]);
        let root = tempfile::tempdir().unwrap();
        let config = test_config(root.path());
        let missing_model_path = root.path().join("tiny.gguf");

        let result = auto_select_downloaded_local_model_at(
            &config,
            "tiny",
            &missing_model_path,
            &root.path().join("lifecycle.lock"),
            None,
            |_| false,
        );

        assert!(matches!(
            result,
            Err(LocalModelLifecycleError::ModelNotDownloaded)
        ));
        assert!(matches!(
            config.get("LOCAL_WHISPER_MODEL", false),
            Err(crate::config::ConfigError::NotFound(_))
        ));
    }

    #[test]
    fn download_callback_rejects_directories_and_file_symlinks() {
        let _env = env_lock::lock_env([("LOCAL_WHISPER_MODEL", None::<&str>)]);
        let root = tempfile::tempdir().unwrap();
        let config = test_config(root.path());
        let model_path = root.path().join("tiny.gguf");
        std::fs::create_dir(&model_path).unwrap();

        assert!(matches!(
            auto_select_downloaded_local_model_at(
                &config,
                "tiny",
                &model_path,
                &root.path().join("lifecycle.lock"),
                None,
                |_| false,
            ),
            Err(LocalModelLifecycleError::InvalidModelFile)
        ));
        std::fs::remove_dir(&model_path).unwrap();

        let target = root.path().join("outside-model.gguf");
        std::fs::write(&target, b"outside").unwrap();
        create_test_file_symlink(&target, &model_path);
        assert!(matches!(
            auto_select_downloaded_local_model_at(
                &config,
                "tiny",
                &model_path,
                &root.path().join("lifecycle.lock"),
                None,
                |_| false,
            ),
            Err(LocalModelLifecycleError::InvalidModelFile)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn lifecycle_guard_holds_an_exclusive_os_file_lock() {
        use fs2::FileExt;
        use std::fs::OpenOptions;

        let root = tempfile::tempdir().unwrap();
        let lock_path = root.path().join("lifecycle.lock");
        let _guard = acquire_local_model_lifecycle_lock_at(&lock_path).unwrap();
        let competing = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();

        assert!(competing.try_lock_exclusive().is_err());
    }
}
