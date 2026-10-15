use futures::StreamExt;
use goose_sdk_types::custom_requests::{
    GitHubWorkflowDispatchCatalogRequest, GitHubWorkflowDispatchCatalogResponse,
    GitHubWorkflowDispatchInputSchema, GitHubWorkflowDispatchInputSource,
    GitHubWorkflowDispatchInputSummary, GitHubWorkflowDispatchInputType,
    GitHubWorkflowDispatchInputValue, GitHubWorkflowDispatchPreviewRequest,
    GitHubWorkflowDispatchPreviewResponse, GitHubWorkflowDispatchRequest,
    GitHubWorkflowDispatchResponse, GitHubWorkflowDispatchWorkflow,
};
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

use super::ci_status::{inspect_local_ci_target, GitHubCiClient, GitHubCiError, LocalCiTarget};
use super::pull_requests::{
    output_text, run_git, valid_branch_component, GitHubPullRequestError, GitHubRepository,
    GITHUB_API_VERSION,
};
use crate::agents::tool_audit::{
    EffectiveModel, QualifiedToolName, ToolAuditActor, ToolAuditAuthorization,
    ToolAuditExtensionSource, ToolAuditInput, ToolAuditOutcome, ToolAuditPermissionClass,
};
use crate::agents::tool_idempotency::{
    BeginDecision, ToolIdempotencyInput, ToolIdempotencyOutcome,
};

pub(crate) const MAX_WORKFLOW_BYTES: usize = 128 * 1024;
pub(crate) const MAX_WORKFLOW_INPUTS: usize = 25;
const MAX_YAML_DEPTH: usize = 16;
const MAX_YAML_NODES: usize = 4096;
const MAX_INPUT_NAME_CHARS: usize = 64;
const MAX_DESCRIPTION_CHARS: usize = 256;
const MAX_INPUT_VALUE_CHARS: usize = 4096;
const MAX_CHOICE_OPTIONS: usize = 50;
const MAX_CHOICE_OPTION_CHARS: usize = 256;
const MAX_WORKFLOW_FILES: usize = 50;
const MAX_WORKFLOW_CATALOG_BYTES: usize = 128 * 1024;
const MAX_DISPATCH_RECEIPT_BYTES: usize = 64 * 1024;
const MAX_DISPATCH_INPUT_PAYLOAD_BYTES: usize = 65_535;
const PREFLIGHT_VERSION: &str = "codebuddy.github-workflow-dispatch-preflight.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GitHubWorkflowDispatchError {
    #[error("The workflow ID must be a positive integer")]
    InvalidWorkflowId,
    #[error("The workflow was not found for the current pushed default-branch HEAD")]
    WorkflowNotFound,
    #[error("The remote default branch could not be determined")]
    MissingDefaultBranch,
    #[error("Workflow dispatch is currently limited to the pushed default branch")]
    NotDefaultBranch,
    #[error("A bounded Git command failed while reading workflows")]
    GitFailed,
    #[error("Git output exceeded the workflow safety limit")]
    GitOutputTooLarge,
    #[error("The repository contains too many workflow files")]
    TooManyWorkflows,
    #[error("The workflow file exceeded the safety limit")]
    WorkflowTooLarge,
    #[error("The workflow dispatch schema is invalid or unsupported")]
    InvalidWorkflowSchema,
    #[error("The workflow catalog returned by GitHub is invalid")]
    InvalidWorkflowCatalog,
    #[error("The workflow dispatch inputs are invalid")]
    InvalidInputs,
    #[error("The workflow dispatch preflight ID is invalid")]
    InvalidPreflightId,
    #[error("The workflow dispatch preflight is stale; run preview again")]
    PreflightStale,
    #[error("The workflow dispatch was already submitted")]
    AlreadySubmitted,
    #[error("The workflow dispatch is already in progress")]
    AlreadyInProgress,
    #[error("The durable workflow dispatch identity is unavailable")]
    IdempotencyUnavailable,
    #[error("The workflow dispatch audit record is unavailable")]
    AuditUnavailable,
    #[error("GitHub is not authenticated")]
    NotAuthenticated,
    #[error("The GitHub credential is unavailable")]
    CredentialUnavailable,
    #[error("The GitHub API is unavailable")]
    NetworkUnavailable,
    #[error("GitHub rejected the workflow dispatch request")]
    GitHubRejected,
    #[error("The workflow dispatch outcome is uncertain; inspect GitHub before retrying")]
    OutcomeUncertain,
    #[error("The GitHub response exceeded the workflow safety limit")]
    GitHubResponseTooLarge,
    #[error(transparent)]
    CiStatus(#[from] GitHubCiError),
}

impl GitHubWorkflowDispatchError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InvalidWorkflowId => "invalid_workflow_id",
            Self::WorkflowNotFound => "workflow_not_found",
            Self::MissingDefaultBranch => "missing_default_branch",
            Self::NotDefaultBranch => "not_default_branch",
            Self::GitFailed => "git_failed",
            Self::GitOutputTooLarge => "git_output_too_large",
            Self::TooManyWorkflows => "too_many_workflows",
            Self::WorkflowTooLarge => "workflow_too_large",
            Self::InvalidWorkflowSchema => "invalid_workflow_schema",
            Self::InvalidWorkflowCatalog => "invalid_workflow_catalog",
            Self::InvalidInputs => "invalid_inputs",
            Self::InvalidPreflightId => "invalid_preflight_id",
            Self::PreflightStale => "preflight_stale",
            Self::AlreadySubmitted => "already_submitted",
            Self::AlreadyInProgress => "already_in_progress",
            Self::IdempotencyUnavailable => "idempotency_unavailable",
            Self::AuditUnavailable => "audit_unavailable",
            Self::NotAuthenticated => "not_authenticated",
            Self::CredentialUnavailable => "credential_unavailable",
            Self::NetworkUnavailable => "network_unavailable",
            Self::GitHubRejected => "github_rejected",
            Self::OutcomeUncertain => "outcome_uncertain",
            Self::GitHubResponseTooLarge => "github_response_too_large",
            Self::CiStatus(error) => error.code(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LocalWorkflowDispatchDefinition {
    pub(crate) path: String,
    pub(crate) inputs: Vec<GitHubWorkflowDispatchInputSchema>,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalWorkflowDispatchTarget {
    pub(crate) ci_target: LocalCiTarget,
    pub(crate) default_branch: String,
    pub(crate) workflows: Vec<LocalWorkflowDispatchDefinition>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedDispatchInputs {
    pub(crate) typed_inputs: serde_json::Map<String, serde_json::Value>,
    pub(crate) input_summary: Vec<GitHubWorkflowDispatchInputSummary>,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkflowDispatchApiReceipt {
    pub(crate) run_id: u64,
    pub(crate) run_url: String,
}

#[derive(Deserialize)]
struct WorkflowCatalogApiResponse {
    total_count: u64,
    workflows: Vec<WorkflowApiResponse>,
}

#[derive(Deserialize)]
struct WorkflowApiResponse {
    id: u64,
    name: String,
    path: String,
    state: String,
}

#[derive(Serialize)]
struct WorkflowDispatchBody<'a> {
    #[serde(rename = "ref")]
    git_ref: &'a str,
    inputs: &'a serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct WorkflowDispatchApiResponse {
    workflow_run_id: u64,
    run_url: String,
    html_url: String,
}

pub(crate) async fn inspect_local_workflow_dispatch_target(
    working_dir: &Path,
) -> Result<LocalWorkflowDispatchTarget, GitHubWorkflowDispatchError> {
    let ci_target = inspect_local_ci_target(working_dir).await?;
    let remote_default_ref = format!("refs/remotes/{}/HEAD", ci_target.remote);
    let symbolic = output_text(
        &run_git(
            &ci_target.repository_root,
            &["symbolic-ref", "--quiet", "--short", &remote_default_ref],
        )
        .await
        .map_err(map_git_error)?,
    )
    .map_err(map_git_error)?;
    let default_branch = symbolic
        .strip_prefix(&format!("{}/", ci_target.remote))
        .filter(|branch| valid_branch_component(branch))
        .ok_or(GitHubWorkflowDispatchError::MissingDefaultBranch)?
        .to_string();
    if ci_target.branch != default_branch {
        return Err(GitHubWorkflowDispatchError::NotDefaultBranch);
    }

    let paths = run_git(
        &ci_target.repository_root,
        &[
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            "HEAD",
            "--",
            ".github/workflows",
        ],
    )
    .await
    .map_err(map_git_error)?;
    let mut workflow_paths = Vec::new();
    for path in paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path = std::str::from_utf8(path)
            .ok()
            .filter(|path| valid_workflow_path(path))
            .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
        workflow_paths.push(path.to_string());
    }
    if workflow_paths.len() > MAX_WORKFLOW_FILES {
        return Err(GitHubWorkflowDispatchError::TooManyWorkflows);
    }
    workflow_paths.sort();

    let mut workflows = Vec::new();
    for path in workflow_paths {
        let object = format!("HEAD:{path}");
        let bytes = run_git(&ci_target.repository_root, &["show", &object])
            .await
            .map_err(map_git_error)?;
        if let Some(inputs) = parse_workflow_dispatch_inputs(&bytes)? {
            workflows.push(LocalWorkflowDispatchDefinition { path, inputs });
        }
    }
    Ok(LocalWorkflowDispatchTarget {
        ci_target,
        default_branch,
        workflows,
    })
}

pub(crate) fn prepare_dispatch_inputs(
    workflow: &GitHubWorkflowDispatchWorkflow,
    values: &[GitHubWorkflowDispatchInputValue],
) -> Result<PreparedDispatchInputs, GitHubWorkflowDispatchError> {
    if workflow.id == 0 || values.len() > MAX_WORKFLOW_INPUTS {
        return Err(GitHubWorkflowDispatchError::InvalidInputs);
    }
    let mut provided = HashMap::with_capacity(values.len());
    for input in values {
        if input.value.chars().count() > MAX_INPUT_VALUE_CHARS
            || provided
                .insert(input.name.as_str(), input.value.as_str())
                .is_some()
        {
            return Err(GitHubWorkflowDispatchError::InvalidInputs);
        }
    }
    if provided
        .keys()
        .any(|name| !workflow.inputs.iter().any(|schema| schema.name == *name))
    {
        return Err(GitHubWorkflowDispatchError::InvalidInputs);
    }

    let mut typed_inputs = serde_json::Map::new();
    let mut input_summary = Vec::with_capacity(workflow.inputs.len());
    for schema in &workflow.inputs {
        let (value, source) = if let Some(value) = provided.get(schema.name.as_str()) {
            if schema.required && value.is_empty() {
                return Err(GitHubWorkflowDispatchError::InvalidInputs);
            }
            (Some(*value), GitHubWorkflowDispatchInputSource::Provided)
        } else if let Some(value) = schema.default_value.as_deref() {
            (Some(value), GitHubWorkflowDispatchInputSource::Default)
        } else if schema.required {
            return Err(GitHubWorkflowDispatchError::InvalidInputs);
        } else {
            (None, GitHubWorkflowDispatchInputSource::Omitted)
        };
        if let Some(value) = value {
            typed_inputs.insert(schema.name.clone(), typed_input_value(schema, value)?);
        }
        input_summary.push(GitHubWorkflowDispatchInputSummary {
            name: schema.name.clone(),
            input_type: schema.input_type,
            source,
        });
    }
    if serde_json::to_vec(&typed_inputs)
        .map_err(|_| GitHubWorkflowDispatchError::InvalidInputs)?
        .len()
        > MAX_DISPATCH_INPUT_PAYLOAD_BYTES
    {
        return Err(GitHubWorkflowDispatchError::InvalidInputs);
    }
    Ok(PreparedDispatchInputs {
        typed_inputs,
        input_summary,
    })
}

fn build_dispatch_preview(
    target: &LocalWorkflowDispatchTarget,
    catalog: &GitHubWorkflowDispatchCatalogResponse,
    workflow_id: u64,
    values: &[GitHubWorkflowDispatchInputValue],
) -> Result<GitHubWorkflowDispatchPreviewResponse, GitHubWorkflowDispatchError> {
    if workflow_id == 0 {
        return Err(GitHubWorkflowDispatchError::InvalidWorkflowId);
    }
    if catalog.repository_owner != target.ci_target.repository.owner
        || catalog.repository_name != target.ci_target.repository.name
        || catalog.default_branch != target.default_branch
        || catalog.head_sha != target.ci_target.head_sha
    {
        return Err(GitHubWorkflowDispatchError::InvalidWorkflowCatalog);
    }
    let workflow = catalog
        .workflows
        .iter()
        .find(|workflow| workflow.id == workflow_id)
        .cloned()
        .ok_or(GitHubWorkflowDispatchError::WorkflowNotFound)?;
    let prepared = prepare_dispatch_inputs(&workflow, values)?;
    let preflight_id = dispatch_preflight_id(target, &workflow, &prepared)?;
    Ok(GitHubWorkflowDispatchPreviewResponse {
        preflight_id,
        repository_owner: catalog.repository_owner.clone(),
        repository_name: catalog.repository_name.clone(),
        repository_url: catalog.repository_url.clone(),
        default_branch: catalog.default_branch.clone(),
        head_sha: catalog.head_sha.clone(),
        working_tree_dirty: catalog.working_tree_dirty,
        workflow,
        input_summary: prepared.input_summary,
    })
}

fn dispatch_preflight_id(
    target: &LocalWorkflowDispatchTarget,
    workflow: &GitHubWorkflowDispatchWorkflow,
    prepared: &PreparedDispatchInputs,
) -> Result<String, GitHubWorkflowDispatchError> {
    let schema = serde_json::to_vec(&workflow.inputs)
        .map_err(|_| GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
    let inputs = serde_json::to_vec(&prepared.typed_inputs)
        .map_err(|_| GitHubWorkflowDispatchError::InvalidInputs)?;
    let repository_root = target.ci_target.repository_root.to_string_lossy();
    let workflow_id = workflow.id.to_string();
    let mut hasher = Sha256::new();
    for (key, value) in [
        ("version", PREFLIGHT_VERSION.as_bytes()),
        ("repository_root", repository_root.as_bytes()),
        ("owner", target.ci_target.repository.owner.as_bytes()),
        ("repository", target.ci_target.repository.name.as_bytes()),
        ("default_branch", target.default_branch.as_bytes()),
        ("head_sha", target.ci_target.head_sha.as_bytes()),
        ("workflow_id", workflow_id.as_bytes()),
        ("workflow_name", workflow.name.as_bytes()),
        ("workflow_path", workflow.path.as_bytes()),
        ("workflow_schema", schema.as_slice()),
        ("typed_inputs", inputs.as_slice()),
    ] {
        hasher.update((key.len() as u64).to_be_bytes());
        hasher.update(key.as_bytes());
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(encoded)
}

fn typed_input_value(
    schema: &GitHubWorkflowDispatchInputSchema,
    value: &str,
) -> Result<serde_json::Value, GitHubWorkflowDispatchError> {
    match schema.input_type {
        GitHubWorkflowDispatchInputType::Boolean => match value {
            "true" => Ok(serde_json::Value::Bool(true)),
            "false" => Ok(serde_json::Value::Bool(false)),
            _ => Err(GitHubWorkflowDispatchError::InvalidInputs),
        },
        GitHubWorkflowDispatchInputType::Number => value
            .parse::<serde_json::Number>()
            .map(serde_json::Value::Number)
            .map_err(|_| GitHubWorkflowDispatchError::InvalidInputs),
        GitHubWorkflowDispatchInputType::Choice => {
            if schema.options.iter().any(|option| option == value) {
                Ok(serde_json::Value::String(value.to_string()))
            } else {
                Err(GitHubWorkflowDispatchError::InvalidInputs)
            }
        }
        GitHubWorkflowDispatchInputType::Environment | GitHubWorkflowDispatchInputType::String => {
            Ok(serde_json::Value::String(value.to_string()))
        }
    }
}

impl GitHubCiClient {
    pub(crate) async fn dispatch_catalog(
        &self,
        access_token: &str,
        target: &LocalWorkflowDispatchTarget,
    ) -> Result<GitHubWorkflowDispatchCatalogResponse, GitHubWorkflowDispatchError> {
        let mut endpoint = self
            .api_base
            .join(&format!(
                "repos/{}/{}/actions/workflows",
                target.ci_target.repository.owner, target.ci_target.repository.name
            ))
            .map_err(|_| GitHubWorkflowDispatchError::InvalidWorkflowCatalog)?;
        endpoint
            .query_pairs_mut()
            .append_pair("per_page", "100")
            .append_pair("page", "1");
        let response = self
            .client
            .get(endpoint)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| GitHubWorkflowDispatchError::NetworkUnavailable)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(GitHubWorkflowDispatchError::GitHubRejected);
        }
        let body = read_github_json(response, MAX_WORKFLOW_CATALOG_BYTES).await?;
        let raw: WorkflowCatalogApiResponse = serde_json::from_slice(&body)
            .map_err(|_| GitHubWorkflowDispatchError::InvalidWorkflowCatalog)?;
        if raw.workflows.len() > 100 || raw.total_count != raw.workflows.len() as u64 {
            return Err(GitHubWorkflowDispatchError::InvalidWorkflowCatalog);
        }
        let mut ids = HashSet::with_capacity(raw.workflows.len());
        let mut paths = HashSet::with_capacity(raw.workflows.len());
        let mut workflows = Vec::new();
        for workflow in raw.workflows {
            if workflow.id == 0
                || workflow.name.is_empty()
                || workflow.name.chars().count() > 128
                || !valid_workflow_path(&workflow.path)
                || !ids.insert(workflow.id)
                || !paths.insert(workflow.path.clone())
            {
                return Err(GitHubWorkflowDispatchError::InvalidWorkflowCatalog);
            }
            if workflow.state != "active" {
                continue;
            }
            if let Some(local) = target
                .workflows
                .iter()
                .find(|local| local.path == workflow.path)
            {
                workflows.push(GitHubWorkflowDispatchWorkflow {
                    id: workflow.id,
                    name: workflow.name,
                    path: workflow.path,
                    inputs: local.inputs.clone(),
                });
            }
        }
        workflows.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
        Ok(GitHubWorkflowDispatchCatalogResponse {
            repository_owner: target.ci_target.repository.owner.clone(),
            repository_name: target.ci_target.repository.name.clone(),
            repository_url: format!(
                "https://github.com/{}/{}",
                target.ci_target.repository.owner, target.ci_target.repository.name
            ),
            default_branch: target.default_branch.clone(),
            head_sha: target.ci_target.head_sha.clone(),
            working_tree_dirty: target.ci_target.working_tree_dirty,
            workflows,
        })
    }

    pub(crate) async fn dispatch_workflow(
        &self,
        access_token: &str,
        repository: &GitHubRepository,
        default_branch: &str,
        workflow_id: u64,
        inputs: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<WorkflowDispatchApiReceipt, GitHubWorkflowDispatchError> {
        if workflow_id == 0 {
            return Err(GitHubWorkflowDispatchError::InvalidInputs);
        }
        let endpoint = self
            .api_base
            .join(&format!(
                "repos/{}/{}/actions/workflows/{workflow_id}/dispatches",
                repository.owner, repository.name
            ))
            .map_err(|_| GitHubWorkflowDispatchError::OutcomeUncertain)?;
        let response = self
            .client
            .post(endpoint)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(access_token)
            .json(&WorkflowDispatchBody {
                git_ref: default_branch,
                inputs,
            })
            .send()
            .await
            .map_err(|_| GitHubWorkflowDispatchError::OutcomeUncertain)?;
        if response.status() != reqwest::StatusCode::OK {
            return if response.status().is_redirection() || response.status().is_client_error() {
                Err(GitHubWorkflowDispatchError::GitHubRejected)
            } else {
                Err(GitHubWorkflowDispatchError::OutcomeUncertain)
            };
        }
        let body = read_github_json(response, MAX_DISPATCH_RECEIPT_BYTES)
            .await
            .map_err(|_| GitHubWorkflowDispatchError::OutcomeUncertain)?;
        let raw: WorkflowDispatchApiResponse = serde_json::from_slice(&body)
            .map_err(|_| GitHubWorkflowDispatchError::OutcomeUncertain)?;
        validate_dispatch_receipt(repository, &raw)
            .map_err(|_| GitHubWorkflowDispatchError::OutcomeUncertain)?;
        Ok(WorkflowDispatchApiReceipt {
            run_id: raw.workflow_run_id,
            run_url: raw.html_url,
        })
    }
}

impl super::GitHubAuthService {
    pub(crate) async fn workflow_dispatch_catalog(
        &self,
        request: GitHubWorkflowDispatchCatalogRequest,
    ) -> Result<GitHubWorkflowDispatchCatalogResponse, GitHubWorkflowDispatchError> {
        let target =
            inspect_local_workflow_dispatch_target(Path::new(&request.working_dir)).await?;
        let access_token = self.workflow_dispatch_access_token().await?;
        self.ci_client
            .dispatch_catalog(&access_token, &target)
            .await
    }

    pub(crate) async fn preview_workflow_dispatch(
        &self,
        request: GitHubWorkflowDispatchPreviewRequest,
    ) -> Result<GitHubWorkflowDispatchPreviewResponse, GitHubWorkflowDispatchError> {
        if request.workflow_id == 0 {
            return Err(GitHubWorkflowDispatchError::InvalidWorkflowId);
        }
        let target =
            inspect_local_workflow_dispatch_target(Path::new(&request.working_dir)).await?;
        let access_token = self.workflow_dispatch_access_token().await?;
        let catalog = self
            .ci_client
            .dispatch_catalog(&access_token, &target)
            .await?;
        build_dispatch_preview(&target, &catalog, request.workflow_id, &request.inputs)
    }

    pub(crate) async fn dispatch_workflow_run(
        &self,
        request: GitHubWorkflowDispatchRequest,
    ) -> Result<GitHubWorkflowDispatchResponse, GitHubWorkflowDispatchError> {
        if request.workflow_id == 0 {
            return Err(GitHubWorkflowDispatchError::InvalidWorkflowId);
        }
        if !valid_dispatch_preflight_id(&request.preflight_id) {
            return Err(GitHubWorkflowDispatchError::InvalidPreflightId);
        }
        let _lifecycle = self.ci_rerun_lifecycle.lock().await;
        let target =
            inspect_local_workflow_dispatch_target(Path::new(&request.working_dir)).await?;
        let access_token = self.workflow_dispatch_access_token().await?;
        let catalog = self
            .ci_client
            .dispatch_catalog(&access_token, &target)
            .await?;
        let preview =
            build_dispatch_preview(&target, &catalog, request.workflow_id, &request.inputs)?;
        if request.preflight_id != preview.preflight_id {
            return Err(GitHubWorkflowDispatchError::PreflightStale);
        }
        let prepared = prepare_dispatch_inputs(&preview.workflow, &request.inputs)?;
        let arguments = dispatch_protected_arguments(&preview)?;
        let audit_claim = self
            .ci_rerun_audit
            .begin(dispatch_audit_input(&preview, arguments.clone())?)
            .await
            .map_err(|_| GitHubWorkflowDispatchError::AuditUnavailable)?;
        let idempotency_claim = match self
            .ci_rerun_idempotency
            .begin(ToolIdempotencyInput {
                session_id: "github-workflow-dispatch".to_string(),
                task_scope: None,
                request_id: preview.preflight_id.clone(),
                tool_name: "github_workflow_dispatch".to_string(),
                arguments,
                explicit_user_confirmation: true,
            })
            .await
        {
            Ok(BeginDecision::Execute(claim)) => claim,
            Ok(BeginDecision::ReplaySuppressed(ToolIdempotencyOutcome::Success)) => {
                self.finish_workflow_dispatch_audit(
                    &audit_claim,
                    ToolAuditOutcome::ReplaySuppressed,
                )
                .await?;
                return Err(GitHubWorkflowDispatchError::AlreadySubmitted);
            }
            Ok(BeginDecision::ReplaySuppressed(
                ToolIdempotencyOutcome::Error | ToolIdempotencyOutcome::Uncertain,
            ))
            | Ok(BeginDecision::Ambiguous) => {
                self.finish_workflow_dispatch_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                    .await?;
                return Err(GitHubWorkflowDispatchError::OutcomeUncertain);
            }
            Ok(BeginDecision::InFlight) => {
                self.finish_workflow_dispatch_audit(
                    &audit_claim,
                    ToolAuditOutcome::ReplaySuppressed,
                )
                .await?;
                return Err(GitHubWorkflowDispatchError::AlreadyInProgress);
            }
            Err(_) => {
                self.finish_workflow_dispatch_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                    .await?;
                return Err(GitHubWorkflowDispatchError::IdempotencyUnavailable);
            }
        };

        match self
            .ci_client
            .dispatch_workflow(
                &access_token,
                &target.ci_target.repository,
                &target.default_branch,
                preview.workflow.id,
                &prepared.typed_inputs,
            )
            .await
        {
            Ok(api_receipt) => {
                if self
                    .ci_rerun_idempotency
                    .complete(&idempotency_claim, ToolIdempotencyOutcome::Success)
                    .await
                    .is_err()
                {
                    self.finish_workflow_dispatch_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                        .await?;
                    return Err(GitHubWorkflowDispatchError::OutcomeUncertain);
                }
                let audit_receipt = self
                    .ci_rerun_audit
                    .complete_with_receipt(&audit_claim, ToolAuditOutcome::Success)
                    .await
                    .map_err(|_| GitHubWorkflowDispatchError::OutcomeUncertain)?;
                Ok(GitHubWorkflowDispatchResponse {
                    repository_owner: preview.repository_owner,
                    repository_name: preview.repository_name,
                    repository_url: preview.repository_url,
                    default_branch: preview.default_branch,
                    head_sha: preview.head_sha,
                    workflow_id: preview.workflow.id,
                    workflow_name: preview.workflow.name,
                    workflow_path: preview.workflow.path,
                    run_id: api_receipt.run_id,
                    run_url: api_receipt.run_url,
                    audit_id: audit_receipt.audit_id,
                    accepted_at: audit_receipt
                        .completed_at
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                })
            }
            Err(error @ GitHubWorkflowDispatchError::GitHubRejected) => {
                if self
                    .ci_rerun_idempotency
                    .abandon_definite(&idempotency_claim)
                    .await
                    .is_err()
                {
                    self.finish_workflow_dispatch_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                        .await?;
                    return Err(GitHubWorkflowDispatchError::OutcomeUncertain);
                }
                self.finish_workflow_dispatch_audit(&audit_claim, ToolAuditOutcome::ToolError)
                    .await?;
                Err(error)
            }
            Err(_) => {
                let _ = self
                    .ci_rerun_idempotency
                    .complete(&idempotency_claim, ToolIdempotencyOutcome::Uncertain)
                    .await;
                self.finish_workflow_dispatch_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                    .await?;
                Err(GitHubWorkflowDispatchError::OutcomeUncertain)
            }
        }
    }

    async fn workflow_dispatch_access_token(&self) -> Result<String, GitHubWorkflowDispatchError> {
        self.active_access_token()
            .await
            .map_err(|error| match error {
                super::pull_requests::GitHubPullRequestError::NotAuthenticated => {
                    GitHubWorkflowDispatchError::NotAuthenticated
                }
                _ => GitHubWorkflowDispatchError::CredentialUnavailable,
            })
    }

    async fn finish_workflow_dispatch_audit(
        &self,
        claim: &crate::agents::tool_audit::ToolAuditClaim,
        outcome: ToolAuditOutcome,
    ) -> Result<(), GitHubWorkflowDispatchError> {
        self.ci_rerun_audit
            .complete_with_receipt(claim, outcome)
            .await
            .map(|_| ())
            .map_err(|_| GitHubWorkflowDispatchError::AuditUnavailable)
    }
}

fn valid_dispatch_preflight_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn dispatch_protected_arguments(
    preview: &GitHubWorkflowDispatchPreviewResponse,
) -> Result<serde_json::Map<String, serde_json::Value>, GitHubWorkflowDispatchError> {
    serde_json::json!({
        "repositoryOwner": preview.repository_owner,
        "repositoryName": preview.repository_name,
        "defaultBranch": preview.default_branch,
        "headSha": preview.head_sha,
        "workflowId": preview.workflow.id,
        "workflowName": preview.workflow.name,
        "workflowPath": preview.workflow.path,
        "inputSummary": preview.input_summary,
        "preflightId": preview.preflight_id,
    })
    .as_object()
    .cloned()
    .ok_or(GitHubWorkflowDispatchError::AuditUnavailable)
}

fn dispatch_audit_input(
    preview: &GitHubWorkflowDispatchPreviewResponse,
    arguments: serde_json::Map<String, serde_json::Value>,
) -> Result<ToolAuditInput, GitHubWorkflowDispatchError> {
    Ok(ToolAuditInput {
        session_id: "github-workflow-dispatch".to_string(),
        request_id: preview.preflight_id.clone(),
        task_scope: None,
        tool_name: QualifiedToolName::new("github::dispatch_workflow")
            .map_err(|_| GitHubWorkflowDispatchError::AuditUnavailable)?,
        arguments,
        actor: ToolAuditActor::HostUnknown,
        effective_model: EffectiveModel::new("unknown")
            .map_err(|_| GitHubWorkflowDispatchError::AuditUnavailable)?,
        extension_source: ToolAuditExtensionSource::Frontend,
        permission_class: ToolAuditPermissionClass::ExternalWrite,
        authorization: ToolAuditAuthorization::UserConfirmed,
    })
}

async fn read_github_json(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, GitHubWorkflowDispatchError> {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| *value == "application/json" || value.ends_with("+json"))
        .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowCatalog)?;
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > max_bytes)
    {
        return Err(GitHubWorkflowDispatchError::GitHubResponseTooLarge);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| GitHubWorkflowDispatchError::NetworkUnavailable)?;
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(GitHubWorkflowDispatchError::GitHubResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn validate_dispatch_receipt(
    repository: &GitHubRepository,
    receipt: &WorkflowDispatchApiResponse,
) -> Result<(), GitHubWorkflowDispatchError> {
    if receipt.workflow_run_id == 0
        || !exact_run_url(
            &receipt.run_url,
            "api.github.com",
            repository,
            receipt.workflow_run_id,
        )
        || !exact_run_url(
            &receipt.html_url,
            "github.com",
            repository,
            receipt.workflow_run_id,
        )
    {
        return Err(GitHubWorkflowDispatchError::InvalidWorkflowCatalog);
    }
    Ok(())
}

fn exact_run_url(value: &str, host: &str, repository: &GitHubRepository, run_id: u64) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let expected_path = if host == "api.github.com" {
        format!(
            "/repos/{}/{}/actions/runs/{run_id}",
            repository.owner, repository.name
        )
    } else {
        format!(
            "/{}/{}/actions/runs/{run_id}",
            repository.owner, repository.name
        )
    };
    url.scheme() == "https"
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == expected_path
}

fn map_git_error(error: GitHubPullRequestError) -> GitHubWorkflowDispatchError {
    match error {
        GitHubPullRequestError::GitOutputTooLarge => GitHubWorkflowDispatchError::GitOutputTooLarge,
        _ => GitHubWorkflowDispatchError::GitFailed,
    }
}

fn valid_workflow_path(path: &str) -> bool {
    let Some(file_name) = path.strip_prefix(".github/workflows/") else {
        return false;
    };
    !file_name.is_empty()
        && file_name.len() <= 128
        && !file_name.contains(['/', '\\'])
        && (file_name.ends_with(".yml") || file_name.ends_with(".yaml"))
        && file_name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

pub(crate) fn parse_workflow_dispatch_inputs(
    bytes: &[u8],
) -> Result<Option<Vec<GitHubWorkflowDispatchInputSchema>>, GitHubWorkflowDispatchError> {
    if bytes.len() > MAX_WORKFLOW_BYTES {
        return Err(GitHubWorkflowDispatchError::WorkflowTooLarge);
    }
    let document: Value = serde_yaml::from_slice(bytes)
        .map_err(|_| GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
    let mut nodes = 0;
    validate_yaml_shape(&document, 0, &mut nodes)?;
    let root = document
        .as_mapping()
        .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
    let Some(triggers) = get_value(root, "on") else {
        return Ok(None);
    };
    let dispatch = match triggers {
        Value::String(trigger) => {
            return Ok((trigger == "workflow_dispatch").then(Vec::new));
        }
        Value::Sequence(triggers) => {
            let mut found = false;
            for trigger in triggers {
                let trigger = trigger
                    .as_str()
                    .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
                found |= trigger == "workflow_dispatch";
            }
            return Ok(found.then(Vec::new));
        }
        Value::Mapping(triggers) => get_value(triggers, "workflow_dispatch"),
        _ => return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema),
    };
    let Some(dispatch) = dispatch else {
        return Ok(None);
    };
    let dispatch = match dispatch {
        Value::Null => return Ok(Some(Vec::new())),
        Value::Mapping(dispatch) => dispatch,
        _ => return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema),
    };
    reject_unknown_keys(dispatch, &["inputs"])?;
    let Some(inputs) = get_value(dispatch, "inputs") else {
        return Ok(Some(Vec::new()));
    };
    if inputs.is_null() {
        return Ok(Some(Vec::new()));
    }
    let inputs = inputs
        .as_mapping()
        .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
    if inputs.len() > MAX_WORKFLOW_INPUTS {
        return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema);
    }

    let mut parsed = Vec::with_capacity(inputs.len());
    for (name, schema) in inputs {
        let name = name
            .as_str()
            .filter(|name| valid_input_name(name))
            .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
        parsed.push(parse_input_schema(name, schema)?);
    }
    parsed.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(Some(parsed))
}

fn parse_input_schema(
    name: &str,
    value: &Value,
) -> Result<GitHubWorkflowDispatchInputSchema, GitHubWorkflowDispatchError> {
    let schema = value
        .as_mapping()
        .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
    reject_unknown_keys(
        schema,
        &["description", "required", "default", "type", "options"],
    )?;
    let description = match get_value(schema, "description") {
        Some(Value::String(description))
            if description.chars().count() <= MAX_DESCRIPTION_CHARS =>
        {
            description.clone()
        }
        None => String::new(),
        _ => return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema),
    };
    let required = match get_value(schema, "required") {
        Some(Value::Bool(required)) => *required,
        None => false,
        _ => return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema),
    };
    let input_type = match get_value(schema, "type").and_then(Value::as_str) {
        Some("boolean") => GitHubWorkflowDispatchInputType::Boolean,
        Some("choice") => GitHubWorkflowDispatchInputType::Choice,
        Some("number") => GitHubWorkflowDispatchInputType::Number,
        Some("environment") => GitHubWorkflowDispatchInputType::Environment,
        Some("string") => GitHubWorkflowDispatchInputType::String,
        _ => return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema),
    };
    let options = parse_options(schema, input_type)?;
    let default_value = get_value(schema, "default")
        .map(|value| normalized_value(value, input_type))
        .transpose()?;
    if input_type == GitHubWorkflowDispatchInputType::Choice
        && default_value
            .as_ref()
            .is_some_and(|default| !options.contains(default))
    {
        return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema);
    }

    Ok(GitHubWorkflowDispatchInputSchema {
        name: name.to_string(),
        description,
        input_type,
        required,
        default_value,
        options,
    })
}

fn parse_options(
    schema: &Mapping,
    input_type: GitHubWorkflowDispatchInputType,
) -> Result<Vec<String>, GitHubWorkflowDispatchError> {
    let Some(options) = get_value(schema, "options") else {
        return if input_type == GitHubWorkflowDispatchInputType::Choice {
            Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema)
        } else {
            Ok(Vec::new())
        };
    };
    if input_type != GitHubWorkflowDispatchInputType::Choice {
        return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema);
    }
    let options = options
        .as_sequence()
        .filter(|options| !options.is_empty() && options.len() <= MAX_CHOICE_OPTIONS)
        .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
    let mut parsed = Vec::with_capacity(options.len());
    let mut unique = HashSet::with_capacity(options.len());
    for option in options {
        let option = option
            .as_str()
            .filter(|option| {
                !option.is_empty() && option.chars().count() <= MAX_CHOICE_OPTION_CHARS
            })
            .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
        if !unique.insert(option) {
            return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema);
        }
        parsed.push(option.to_string());
    }
    Ok(parsed)
}

fn normalized_value(
    value: &Value,
    input_type: GitHubWorkflowDispatchInputType,
) -> Result<String, GitHubWorkflowDispatchError> {
    let normalized = match input_type {
        GitHubWorkflowDispatchInputType::Boolean => match value {
            Value::Bool(value) => value.to_string(),
            Value::String(value) if value == "true" || value == "false" => value.clone(),
            _ => return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema),
        },
        GitHubWorkflowDispatchInputType::Number => match value {
            Value::Number(value) => value.to_string(),
            Value::String(value) if value.parse::<serde_json::Number>().is_ok() => value.clone(),
            _ => return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema),
        },
        GitHubWorkflowDispatchInputType::Choice
        | GitHubWorkflowDispatchInputType::Environment
        | GitHubWorkflowDispatchInputType::String => value
            .as_str()
            .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?
            .to_string(),
    };
    if normalized.chars().count() > MAX_INPUT_VALUE_CHARS {
        return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema);
    }
    Ok(normalized)
}

fn validate_yaml_shape(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), GitHubWorkflowDispatchError> {
    *nodes += 1;
    if depth > MAX_YAML_DEPTH || *nodes > MAX_YAML_NODES {
        return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema);
    }
    match value {
        Value::Sequence(values) => {
            for value in values {
                validate_yaml_shape(value, depth + 1, nodes)?;
            }
        }
        Value::Mapping(values) => {
            for (key, value) in values {
                validate_yaml_shape(key, depth + 1, nodes)?;
                validate_yaml_shape(value, depth + 1, nodes)?;
            }
        }
        Value::Tagged(_) => return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema),
        _ => {}
    }
    Ok(())
}

fn get_value<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a Value> {
    mapping.get(Value::String(key.to_string()))
}

fn reject_unknown_keys(
    mapping: &Mapping,
    allowed: &[&str],
) -> Result<(), GitHubWorkflowDispatchError> {
    for key in mapping.keys() {
        let key = key
            .as_str()
            .ok_or(GitHubWorkflowDispatchError::InvalidWorkflowSchema)?;
        if !allowed.contains(&key) {
            return Err(GitHubWorkflowDispatchError::InvalidWorkflowSchema);
        }
    }
    Ok(())
}

fn valid_input_name(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    name.chars().count() <= MAX_INPUT_NAME_CHARS
        && (first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use goose_sdk_types::custom_requests::{
        GitHubWorkflowDispatchInputType, GitHubWorkflowDispatchInputValue,
    };
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::ci_status::GitHubCiClient;
    use super::super::credential_store::{
        GitHubCredentialStore, MemoryGitHubCredentialStore, StoredGitHubCredentialV1,
    };
    use super::super::device_flow::GitHubDeviceFlowClient;
    use super::super::pull_requests::{GitHubRepository, GITHUB_API_VERSION};
    use super::super::{GitHubAuthClock, GitHubAuthService};
    use chrono::{DateTime, Utc};
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn parses_all_supported_dispatch_input_types() {
        let yaml = br#"
name: Release
on:
  workflow_dispatch:
    inputs:
      deploy:
        description: Deploy now
        required: true
        type: boolean
        default: false
      channel:
        description: Release channel
        required: true
        type: choice
        options: [stable, beta]
        default: stable
      retries:
        description: Retry count
        type: number
        default: 2
      target:
        description: Target environment
        type: environment
      notes:
        description: Release notes
        type: string
"#;

        let inputs = parse_workflow_dispatch_inputs(yaml).unwrap().unwrap();

        assert_eq!(inputs.len(), 5);
        assert_eq!(inputs[0].name, "channel");
        assert_eq!(
            inputs[0].input_type,
            GitHubWorkflowDispatchInputType::Choice
        );
        assert_eq!(inputs[0].options, ["stable", "beta"]);
        assert_eq!(inputs[0].default_value.as_deref(), Some("stable"));
        assert_eq!(inputs[1].name, "deploy");
        assert_eq!(
            inputs[1].input_type,
            GitHubWorkflowDispatchInputType::Boolean
        );
        assert_eq!(inputs[1].default_value.as_deref(), Some("false"));
        assert_eq!(inputs[2].name, "notes");
        assert_eq!(
            inputs[2].input_type,
            GitHubWorkflowDispatchInputType::String
        );
        assert_eq!(inputs[3].name, "retries");
        assert_eq!(
            inputs[3].input_type,
            GitHubWorkflowDispatchInputType::Number
        );
        assert_eq!(inputs[3].default_value.as_deref(), Some("2"));
        assert_eq!(inputs[4].name, "target");
        assert_eq!(
            inputs[4].input_type,
            GitHubWorkflowDispatchInputType::Environment
        );
    }

    #[test]
    fn accepts_scalar_and_sequence_dispatch_without_inputs() {
        assert!(parse_workflow_dispatch_inputs(b"on: workflow_dispatch\n")
            .unwrap()
            .unwrap()
            .is_empty());
        assert!(
            parse_workflow_dispatch_inputs(b"on: [push, workflow_dispatch]\n")
                .unwrap()
                .unwrap()
                .is_empty()
        );
        assert!(parse_workflow_dispatch_inputs(b"on: push\n")
            .unwrap()
            .is_none());
    }

    #[test]
    fn rejects_unknown_or_inconsistent_input_schema() {
        for yaml in [
            "on:\n  workflow_dispatch:\n    inputs:\n      bad:\n        type: object\n",
            "on:\n  workflow_dispatch:\n    inputs:\n      bad:\n        type: string\n        options: [x]\n",
            "on:\n  workflow_dispatch:\n    inputs:\n      bad:\n        type: choice\n        options: []\n",
            "on:\n  workflow_dispatch:\n    inputs:\n      bad:\n        type: choice\n        options: [x]\n        default: y\n",
            "on:\n  workflow_dispatch:\n    unexpected: true\n",
        ] {
            assert_eq!(
                parse_workflow_dispatch_inputs(yaml.as_bytes()).unwrap_err(),
                GitHubWorkflowDispatchError::InvalidWorkflowSchema
            );
        }
    }

    #[test]
    fn rejects_oversized_or_excessive_schema() {
        let oversized = vec![b'a'; MAX_WORKFLOW_BYTES + 1];
        assert_eq!(
            parse_workflow_dispatch_inputs(&oversized).unwrap_err(),
            GitHubWorkflowDispatchError::WorkflowTooLarge
        );

        let mut yaml = String::from("on:\n  workflow_dispatch:\n    inputs:\n");
        for index in 0..=MAX_WORKFLOW_INPUTS {
            yaml.push_str(&format!("      input_{index}:\n        type: string\n"));
        }
        assert_eq!(
            parse_workflow_dispatch_inputs(yaml.as_bytes()).unwrap_err(),
            GitHubWorkflowDispatchError::InvalidWorkflowSchema
        );
    }

    #[test]
    fn rejects_malformed_yaml_and_unknown_input_fields() {
        for yaml in [
            "on: [workflow_dispatch\n",
            "on:\n  workflow_dispatch:\n    inputs:\n      bad:\n        type: string\n        secret: true\n",
            "on:\n  workflow_dispatch:\n    inputs:\n      1bad:\n        type: string\n",
        ] {
            assert_eq!(
                parse_workflow_dispatch_inputs(yaml.as_bytes()).unwrap_err(),
                GitHubWorkflowDispatchError::InvalidWorkflowSchema
            );
        }
    }

    struct TestRepository {
        _temp: tempfile::TempDir,
        root: PathBuf,
    }

    fn git(cwd: &Path, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {arguments:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn setup_repository() -> TestRepository {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        git(&root, &["init", "--initial-branch", "main"]);
        git(&root, &["config", "user.name", "CodePro Test"]);
        git(&root, &["config", "user.email", "codepro@example.invalid"]);
        std::fs::write(
            root.join(".github/workflows/release.yml"),
            "on:\n  workflow_dispatch:\n    inputs:\n      channel:\n        type: choice\n        options: [stable, beta]\n        default: stable\n",
        )
        .unwrap();
        git(&root, &["add", ".github/workflows/release.yml"]);
        git(&root, &["commit", "-m", "workflow"]);
        let head = git(&root, &["rev-parse", "HEAD"]);
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/octo/demo.git",
            ],
        );
        git(&root, &["update-ref", "refs/remotes/origin/main", &head]);
        git(
            &root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        git(&root, &["config", "branch.main.remote", "origin"]);
        git(&root, &["config", "branch.main.merge", "refs/heads/main"]);
        TestRepository { _temp: temp, root }
    }

    #[tokio::test]
    async fn reads_dispatch_schema_from_exact_head_instead_of_dirty_worktree() {
        let repository = setup_repository();
        std::fs::write(
            repository.root.join(".github/workflows/release.yml"),
            "on:\n  workflow_dispatch:\n    inputs:\n      channel:\n        type: choice\n        options: [nightly]\n        default: nightly\n",
        )
        .unwrap();

        let target = inspect_local_workflow_dispatch_target(&repository.root)
            .await
            .unwrap();

        assert_eq!(target.default_branch, "main");
        assert!(target.ci_target.working_tree_dirty);
        assert_eq!(target.workflows.len(), 1);
        assert_eq!(target.workflows[0].path, ".github/workflows/release.yml");
        assert_eq!(target.workflows[0].inputs[0].options, ["stable", "beta"]);
    }

    #[tokio::test]
    async fn rejects_an_exact_pushed_non_default_branch() {
        let repository = setup_repository();
        git(&repository.root, &["switch", "-c", "feature"]);
        let head = git(&repository.root, &["rev-parse", "HEAD"]);
        git(
            &repository.root,
            &["update-ref", "refs/remotes/origin/feature", &head],
        );
        git(
            &repository.root,
            &["config", "branch.feature.remote", "origin"],
        );
        git(
            &repository.root,
            &["config", "branch.feature.merge", "refs/heads/feature"],
        );

        assert_eq!(
            inspect_local_workflow_dispatch_target(&repository.root)
                .await
                .unwrap_err(),
            GitHubWorkflowDispatchError::NotDefaultBranch
        );
    }

    fn api_target() -> LocalWorkflowDispatchTarget {
        LocalWorkflowDispatchTarget {
            ci_target: LocalCiTarget {
                repository: GitHubRepository {
                    owner: "octo".to_string(),
                    name: "demo".to_string(),
                },
                repository_root: PathBuf::from("D:\\demo"),
                remote: "origin".to_string(),
                branch: "main".to_string(),
                head_sha: "1".repeat(40),
                working_tree_dirty: false,
            },
            default_branch: "main".to_string(),
            workflows: vec![LocalWorkflowDispatchDefinition {
                path: ".github/workflows/release.yml".to_string(),
                inputs: parse_workflow_dispatch_inputs(
                    b"on:\n  workflow_dispatch:\n    inputs:\n      channel:\n        type: choice\n        options: [stable, beta]\n      deploy:\n        type: boolean\n      retries:\n        type: number\n",
                )
                .unwrap()
                .unwrap(),
            }],
        }
    }

    #[tokio::test]
    async fn client_lists_exact_active_workflows_and_posts_typed_dispatch_once() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/workflows"))
            .and(query_param("per_page", "100"))
            .and(query_param("page", "1"))
            .and(header("authorization", "Bearer dispatch-token"))
            .and(header("x-github-api-version", GITHUB_API_VERSION))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type", "application/json").set_body_json(serde_json::json!({
                "total_count": 2,
                "workflows": [
                    {"id": 42, "name": "Release", "path": ".github/workflows/release.yml", "state": "active"},
                    {"id": 43, "name": "Disabled", "path": ".github/workflows/disabled.yml", "state": "disabled_manually"}
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/actions/workflows/42/dispatches"))
            .and(header("authorization", "Bearer dispatch-token"))
            .and(header("x-github-api-version", GITHUB_API_VERSION))
            .and(body_json(serde_json::json!({
                "ref": "main",
                "inputs": {"channel": "beta", "deploy": true, "retries": 3}
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "workflow_run_id": 9001,
                        "run_url": "https://api.github.com/repos/octo/demo/actions/runs/9001",
                        "html_url": "https://github.com/octo/demo/actions/runs/9001"
                    })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = GitHubCiClient::for_test(&server.uri()).unwrap();
        let target = api_target();

        let catalog = client
            .dispatch_catalog("dispatch-token", &target)
            .await
            .unwrap();
        assert_eq!(catalog.workflows.len(), 1);
        assert_eq!(catalog.workflows[0].id, 42);
        let prepared = prepare_dispatch_inputs(
            &catalog.workflows[0],
            &[
                GitHubWorkflowDispatchInputValue {
                    name: "channel".to_string(),
                    value: "beta".to_string(),
                },
                GitHubWorkflowDispatchInputValue {
                    name: "deploy".to_string(),
                    value: "true".to_string(),
                },
                GitHubWorkflowDispatchInputValue {
                    name: "retries".to_string(),
                    value: "3".to_string(),
                },
            ],
        )
        .unwrap();
        let receipt = client
            .dispatch_workflow(
                "dispatch-token",
                &target.ci_target.repository,
                &target.default_branch,
                catalog.workflows[0].id,
                &prepared.typed_inputs,
            )
            .await
            .unwrap();
        assert_eq!(receipt.run_id, 9001);
        assert_eq!(
            receipt.run_url,
            "https://github.com/octo/demo/actions/runs/9001"
        );
    }

    #[tokio::test]
    async fn dispatch_classifies_definite_and_uncertain_failures_without_leaks_or_retries() {
        for (status, expected) in [
            (302, GitHubWorkflowDispatchError::GitHubRejected),
            (422, GitHubWorkflowDispatchError::GitHubRejected),
            (500, GitHubWorkflowDispatchError::OutcomeUncertain),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/repos/octo/demo/actions/workflows/42/dispatches"))
                .respond_with(
                    ResponseTemplate::new(status)
                        .insert_header("location", "https://attacker.invalid"),
                )
                .expect(1)
                .mount(&server)
                .await;
            let client = GitHubCiClient::for_test(&server.uri()).unwrap();
            let error = client
                .dispatch_workflow(
                    "dispatch-secret-must-not-leak",
                    &api_target().ci_target.repository,
                    "main",
                    42,
                    &serde_json::Map::new(),
                )
                .await
                .unwrap_err();
            assert_eq!(error, expected);
            assert!(!error.to_string().contains("dispatch-secret-must-not-leak"));
        }
    }

    #[tokio::test]
    async fn dispatch_rejects_invalid_success_receipts_as_uncertain() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/actions/workflows/42/dispatches"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "workflow_run_id": 9001,
                        "run_url": "https://api.github.com/repos/octo/demo/actions/runs/9001",
                        "html_url": "https://attacker.invalid/octo/demo/actions/runs/9001"
                    })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = GitHubCiClient::for_test(&server.uri()).unwrap();

        assert_eq!(
            client
                .dispatch_workflow(
                    "token",
                    &api_target().ci_target.repository,
                    "main",
                    42,
                    &serde_json::Map::new(),
                )
                .await
                .unwrap_err(),
            GitHubWorkflowDispatchError::OutcomeUncertain
        );
    }

    struct FixedClock;

    impl GitHubAuthClock for FixedClock {
        fn monotonic_now(&self) -> Instant {
            Instant::now()
        }

        fn utc_now(&self) -> DateTime<Utc> {
            DateTime::parse_from_rfc3339("2026-08-05T01:00:00Z")
                .unwrap()
                .to_utc()
        }
    }

    fn credential_store() -> Arc<MemoryGitHubCredentialStore> {
        let store = Arc::new(MemoryGitHubCredentialStore::default());
        store
            .save(&StoredGitHubCredentialV1 {
                schema_version: 1,
                account_login: "octocat".to_string(),
                account_id: 1,
                access_token: "ghu_dispatch-secret-must-not-leak".to_string(),
                refresh_token: None,
                access_token_expires_at: Some("2026-08-05T02:00:00Z".to_string()),
                refresh_token_expires_at: None,
            })
            .unwrap();
        store
    }

    fn service_with_data_dir(server: &MockServer, data_dir: PathBuf) -> GitHubAuthService {
        GitHubAuthService::for_test_with_ci_data_dir(
            Some("Iv1.codebuddy-test".to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            credential_store(),
            Arc::new(FixedClock),
            data_dir,
        )
    }

    async fn mount_catalog(server: &MockServer, expected: u64) {
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/workflows"))
            .and(query_param("per_page", "100"))
            .and(query_param("page", "1"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "total_count": 1,
                        "workflows": [{
                            "id": 42,
                            "name": "Release",
                            "path": ".github/workflows/release.yml",
                            "state": "active"
                        }]
                    })),
            )
            .expect(expected)
            .mount(server)
            .await;
    }

    fn dispatch_values(channel: &str) -> Vec<GitHubWorkflowDispatchInputValue> {
        vec![GitHubWorkflowDispatchInputValue {
            name: "channel".to_string(),
            value: channel.to_string(),
        }]
    }

    #[tokio::test]
    async fn service_rechecks_inputs_audits_and_suppresses_duplicate_success() {
        let repository = setup_repository();
        let server = MockServer::start().await;
        mount_catalog(&server, 4).await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/actions/workflows/42/dispatches"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "workflow_run_id": 9001,
                        "run_url": "https://api.github.com/repos/octo/demo/actions/runs/9001",
                        "html_url": "https://github.com/octo/demo/actions/runs/9001"
                    })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let service = GitHubAuthService::for_test(
            Some("Iv1.codebuddy-test".to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            credential_store(),
            Arc::new(FixedClock),
        );
        let working_dir = repository.root.to_string_lossy().into_owned();
        let preview = service
            .preview_workflow_dispatch(GitHubWorkflowDispatchPreviewRequest {
                working_dir: working_dir.clone(),
                workflow_id: 42,
                inputs: dispatch_values("beta"),
            })
            .await
            .unwrap();
        assert_eq!(
            preview.input_summary[0].source,
            GitHubWorkflowDispatchInputSource::Provided
        );

        let stale = GitHubWorkflowDispatchRequest {
            working_dir: working_dir.clone(),
            workflow_id: 42,
            inputs: dispatch_values("stable"),
            preflight_id: preview.preflight_id.clone(),
        };
        assert_eq!(
            service.dispatch_workflow_run(stale).await.unwrap_err(),
            GitHubWorkflowDispatchError::PreflightStale
        );

        let execute = GitHubWorkflowDispatchRequest {
            working_dir,
            workflow_id: 42,
            inputs: dispatch_values("beta"),
            preflight_id: preview.preflight_id,
        };
        let accepted = service
            .dispatch_workflow_run(execute.clone())
            .await
            .unwrap();
        assert_eq!(accepted.run_id, 9001);
        assert_eq!(accepted.workflow_id, 42);
        assert!(!accepted.audit_id.is_empty());
        let serialized = serde_json::to_string(&accepted).unwrap();
        assert!(!serialized.contains("beta"));
        assert!(!serialized.contains("ghu_dispatch-secret-must-not-leak"));
        assert!(!serialized.contains(repository.root.to_string_lossy().as_ref()));

        assert_eq!(
            service.dispatch_workflow_run(execute).await.unwrap_err(),
            GitHubWorkflowDispatchError::AlreadySubmitted
        );
    }

    #[tokio::test]
    async fn audit_failure_and_uncertain_restart_never_issue_a_second_post() {
        let repository = setup_repository();
        let working_dir = repository.root.to_string_lossy().into_owned();
        let blocked = tempfile::tempdir().unwrap();
        let blocked_data_dir = blocked.path().join("not-a-directory");
        std::fs::write(&blocked_data_dir, "blocked").unwrap();
        let audit_server = MockServer::start().await;
        mount_catalog(&audit_server, 2).await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/actions/workflows/42/dispatches"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&audit_server)
            .await;
        let audit_service = service_with_data_dir(&audit_server, blocked_data_dir);
        let preview = audit_service
            .preview_workflow_dispatch(GitHubWorkflowDispatchPreviewRequest {
                working_dir: working_dir.clone(),
                workflow_id: 42,
                inputs: dispatch_values("beta"),
            })
            .await
            .unwrap();
        assert_eq!(
            audit_service
                .dispatch_workflow_run(GitHubWorkflowDispatchRequest {
                    working_dir: working_dir.clone(),
                    workflow_id: 42,
                    inputs: dispatch_values("beta"),
                    preflight_id: preview.preflight_id,
                })
                .await
                .unwrap_err(),
            GitHubWorkflowDispatchError::AuditUnavailable
        );

        let data = tempfile::tempdir().unwrap();
        let uncertain_server = MockServer::start().await;
        mount_catalog(&uncertain_server, 2).await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/actions/workflows/42/dispatches"))
            .respond_with(ResponseTemplate::new(500))
            .expect(1)
            .mount(&uncertain_server)
            .await;
        let uncertain_service = service_with_data_dir(&uncertain_server, data.path().to_path_buf());
        let preview = uncertain_service
            .preview_workflow_dispatch(GitHubWorkflowDispatchPreviewRequest {
                working_dir: working_dir.clone(),
                workflow_id: 42,
                inputs: dispatch_values("beta"),
            })
            .await
            .unwrap();
        let execute = GitHubWorkflowDispatchRequest {
            working_dir: working_dir.clone(),
            workflow_id: 42,
            inputs: dispatch_values("beta"),
            preflight_id: preview.preflight_id,
        };
        assert_eq!(
            uncertain_service
                .dispatch_workflow_run(execute.clone())
                .await
                .unwrap_err(),
            GitHubWorkflowDispatchError::OutcomeUncertain
        );
        drop(uncertain_service);

        let suppressed_server = MockServer::start().await;
        mount_catalog(&suppressed_server, 1).await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/actions/workflows/42/dispatches"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&suppressed_server)
            .await;
        assert_eq!(
            service_with_data_dir(&suppressed_server, data.path().to_path_buf())
                .dispatch_workflow_run(execute)
                .await
                .unwrap_err(),
            GitHubWorkflowDispatchError::OutcomeUncertain
        );
    }
}
