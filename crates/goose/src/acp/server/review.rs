use super::*;
use crate::agents::codepro_review::{
    capture_snapshot, delete_stored_review_session, ReviewModel, ReviewRunner, ReviewScope,
    ReviewStartRequest as ReviewExecutionRequest, ReviewTestEvidence, SnapshotRequest,
    REVIEW_SCHEMA_VERSION,
};
use goose_providers::model::ModelConfig;
use goose_sdk_types::custom_requests::{
    CodeProReviewCancelRequest, CodeProReviewGetRequest, CodeProReviewResultResponse,
    CodeProReviewScope, CodeProReviewSnapshotRequest, CodeProReviewSnapshotResponse,
    CodeProReviewStartRequest,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::time::Duration;

const REVIEW_EXECUTION_TIMEOUT: Duration = Duration::from_secs(600);

pub(super) struct ReviewRuntime {
    model: ReviewModel,
    runner: ReviewRunner,
}

impl GooseAcpAgent {
    pub(super) async fn delete_codepro_reviews_for_session(
        &self,
        session_id: &str,
    ) -> Result<(), agent_client_protocol::Error> {
        let runtime = self.review_runners.lock().await.remove(session_id);
        if let Some(runtime) = runtime {
            runtime
                .runner
                .delete_session(session_id)
                .await
                .map_err(review_internal)?;
        } else {
            delete_stored_review_session(&self.review_data_root, session_id)
                .await
                .map_err(review_internal)?;
        }
        let mut snapshots = self.review_snapshots.lock().await;
        let snapshot_ids = snapshots
            .iter()
            .filter(|(_, snapshot)| snapshot.session_id == session_id)
            .map(|(snapshot_id, _)| snapshot_id.clone())
            .collect::<Vec<_>>();
        for snapshot_id in snapshot_ids {
            snapshots.pop(&snapshot_id);
        }
        Ok(())
    }

    pub(super) async fn on_codepro_review_snapshot(
        &self,
        request: CodeProReviewSnapshotRequest,
    ) -> Result<CodeProReviewSnapshotResponse, agent_client_protocol::Error> {
        validate_schema(request.schema_version)?;
        let (working_dir, provider, model_config, model) =
            self.review_context(&request.session_id).await?;
        let snapshot = capture_snapshot(
            &SnapshotRequest {
                session_id: request.session_id,
                working_dir,
                scope: from_sdk_scope(request.scope),
                base_ref: request.base_ref,
                model,
            },
            CancellationToken::new(),
        )
        .await
        .map_err(review_invalid_params)?;
        self.review_snapshots
            .lock()
            .await
            .put(snapshot.snapshot_id.clone(), snapshot.clone());
        let _ = self
            .runner_for(
                &snapshot.session_id,
                provider,
                model_config,
                snapshot.model.clone(),
            )
            .await?;
        Ok(CodeProReviewSnapshotResponse {
            snapshot: convert(snapshot)?,
        })
    }

    pub(super) async fn on_codepro_review_start(
        &self,
        request: CodeProReviewStartRequest,
    ) -> Result<CodeProReviewResultResponse, agent_client_protocol::Error> {
        validate_schema(request.schema_version)?;
        let preview = self
            .review_snapshots
            .lock()
            .await
            .get(&request.snapshot_id)
            .cloned()
            .ok_or_else(|| review_not_found(&request.snapshot_id))?;
        if preview.session_id != request.session_id {
            return Err(review_not_found(&request.snapshot_id));
        }
        let (working_dir, provider, model_config, model) =
            self.review_context(&request.session_id).await?;
        let current = capture_snapshot(
            &SnapshotRequest {
                session_id: request.session_id.clone(),
                working_dir,
                scope: preview.scope,
                base_ref: preview.base_ref.clone(),
                model: model.clone(),
            },
            CancellationToken::new(),
        )
        .await
        .map_err(review_invalid_params)?;
        let runner = self
            .runner_for(&request.session_id, provider, model_config, model.clone())
            .await?;
        let result = runner
            .start(ReviewExecutionRequest {
                session_id: request.session_id,
                request_id: request.request_id,
                snapshot: preview,
                current_model: model,
                current_fingerprint: current.fingerprint,
                test_evidence: request
                    .test_evidence
                    .into_iter()
                    .map(|evidence| ReviewTestEvidence {
                        id: evidence.id,
                        snapshot_fingerprint: evidence.snapshot_fingerprint,
                    })
                    .collect(),
            })
            .await
            .map_err(review_invalid_params)?;
        Ok(CodeProReviewResultResponse {
            result: convert(result)?,
            snapshot: None,
        })
    }

    pub(super) async fn on_codepro_review_get(
        &self,
        request: CodeProReviewGetRequest,
    ) -> Result<CodeProReviewResultResponse, agent_client_protocol::Error> {
        validate_schema(request.schema_version)?;
        let (working_dir, provider, model_config, model) =
            self.review_context(&request.session_id).await?;
        let runner = self
            .runner_for(&request.session_id, provider, model_config, model.clone())
            .await?;
        let snapshot = runner
            .snapshot(&request.session_id, &request.review_id)
            .await
            .map_err(|error| review_store_error(error, &request.review_id))?;
        let fingerprint = capture_snapshot(
            &SnapshotRequest {
                session_id: request.session_id.clone(),
                working_dir,
                scope: snapshot.scope,
                base_ref: snapshot.base_ref.clone(),
                model: model.clone(),
            },
            CancellationToken::new(),
        )
        .await
        .ok()
        .map(|snapshot| snapshot.fingerprint);
        let result = runner
            .get(
                &request.session_id,
                &request.review_id,
                &model,
                fingerprint.as_deref(),
            )
            .await
            .map_err(|error| review_store_error(error, &request.review_id))?;
        let response_snapshot = if request.include_snapshot {
            Some(convert(snapshot)?)
        } else {
            None
        };
        Ok(CodeProReviewResultResponse {
            result: convert(result)?,
            snapshot: response_snapshot,
        })
    }

    pub(super) async fn on_codepro_review_cancel(
        &self,
        request: CodeProReviewCancelRequest,
    ) -> Result<CodeProReviewResultResponse, agent_client_protocol::Error> {
        validate_schema(request.schema_version)?;
        let (_, provider, model_config, model) = self.review_context(&request.session_id).await?;
        let runner = self
            .runner_for(&request.session_id, provider, model_config, model)
            .await?;
        let result = runner
            .cancel(&request.session_id, &request.review_id)
            .await
            .map_err(|error| review_store_error(error, &request.review_id))?;
        Ok(CodeProReviewResultResponse {
            result: convert(result)?,
            snapshot: None,
        })
    }

    async fn review_context(
        &self,
        session_id: &str,
    ) -> Result<(PathBuf, Arc<dyn Provider>, ModelConfig, ReviewModel), agent_client_protocol::Error>
    {
        let session = self
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| review_not_found(session_id))?;
        let agent = self.get_session_agent(session_id).await?;
        let provider = agent.provider().await.map_err(review_internal)?;
        let model_config = agent
            .model_config_for_session(session_id)
            .await
            .map_err(review_internal)?;
        let model = ReviewModel {
            provider: provider.get_name().to_owned(),
            model: model_config.model_name.clone(),
        };
        Ok((session.working_dir, provider, model_config, model))
    }

    async fn runner_for(
        &self,
        session_id: &str,
        provider: Arc<dyn Provider>,
        model_config: ModelConfig,
        model: ReviewModel,
    ) -> Result<ReviewRunner, agent_client_protocol::Error> {
        let mut runtimes = self.review_runners.lock().await;
        if let Some(runtime) = runtimes.get(session_id) {
            if runtime.model == model {
                return Ok(runtime.runner.clone());
            }
            let runner = runtime
                .runner
                .with_provider(provider, model_config, REVIEW_EXECUTION_TIMEOUT)
                .map_err(review_internal)?;
            runtimes.insert(
                session_id.to_owned(),
                ReviewRuntime {
                    model,
                    runner: runner.clone(),
                },
            );
            return Ok(runner);
        }
        let runner = ReviewRunner::open_for_session(
            &self.review_data_root,
            session_id,
            provider,
            model_config,
            REVIEW_EXECUTION_TIMEOUT,
        )
        .await
        .map_err(review_internal)?;
        runtimes.insert(
            session_id.to_owned(),
            ReviewRuntime {
                model,
                runner: runner.clone(),
            },
        );
        Ok(runner)
    }
}

fn validate_schema(schema_version: u16) -> Result<(), agent_client_protocol::Error> {
    if schema_version != REVIEW_SCHEMA_VERSION {
        return Err(agent_client_protocol::Error::invalid_params().data(format!(
            "unsupported review schema version {schema_version}"
        )));
    }
    Ok(())
}

fn from_sdk_scope(scope: CodeProReviewScope) -> ReviewScope {
    match scope {
        CodeProReviewScope::WorkingTree => ReviewScope::WorkingTree,
        CodeProReviewScope::Staged => ReviewScope::Staged,
        CodeProReviewScope::Branch => ReviewScope::Branch,
    }
}

fn convert<T: Serialize, U: DeserializeOwned>(value: T) -> Result<U, agent_client_protocol::Error> {
    serde_json::from_value(serde_json::to_value(value).map_err(review_internal)?)
        .map_err(review_internal)
}

fn review_not_found(id: &str) -> agent_client_protocol::Error {
    agent_client_protocol::Error::resource_not_found(Some(id.to_owned()))
        .data(format!("Review resource not found: {id}"))
}

fn review_store_error(error: anyhow::Error, id: &str) -> agent_client_protocol::Error {
    if error.to_string().contains("review_not_found") {
        review_not_found(id)
    } else {
        review_internal(error)
    }
}

fn review_invalid_params(error: anyhow::Error) -> agent_client_protocol::Error {
    agent_client_protocol::Error::invalid_params().data(error.to_string())
}

fn review_internal(error: impl std::fmt::Display) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(error.to_string())
}
