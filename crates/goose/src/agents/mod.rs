pub mod action_budget;
pub mod activity_event;
mod agent;
mod desktop_tool_stream;
pub(crate) use agent::clarification::ClarificationInput;
pub(crate) use agent::compaction_lifecycle_message;
pub mod agent_role;
mod analysis_tools;
pub mod checkpoint_transaction;
pub mod codebuddy_identity;
pub(crate) mod codepro_clarification;
pub mod codepro_event_log;
pub mod codepro_evidence;
pub mod codepro_intent;
mod codepro_report;
pub mod codepro_review;
pub mod codepro_routing_evidence;
mod codepro_run_result;
mod codepro_simple_change;
mod codepro_simple_change_run;
pub mod codepro_state_store;
mod codepro_terminal_report;
mod codepro_validation_retry;
pub mod codepro_workspace;
pub mod codepro_workspace_binding;
pub mod container;
pub mod control_plane;
pub mod coordinator;
pub mod execute_commands;
pub mod extension;
pub mod extension_malware_check;
pub mod extension_manager;
pub(crate) mod external_http_attempt_budget;
pub mod final_output_tool;
pub mod finding_record;
pub mod git_mcp;
mod large_response_handler;
mod main_agent_contract;
pub mod mcp_client;
pub mod model_router;
pub mod moim;
pub mod planner_agent;
pub mod platform_extensions;
pub mod platform_tools;
pub mod prompt_manager;
pub mod protocol;
pub mod reply_parts;
mod report_writer_agent;
pub mod reporting;
pub mod result_aggregator;
pub mod retry;
pub mod reviewer_agent;
pub mod reviewer_test_decision;
mod schedule_tool;
pub mod subagent_execution_tool;
pub(crate) mod subagent_handler;
pub(crate) mod subagent_task_config;
pub mod task_dag;
pub mod task_detector;
pub(crate) mod task_evidence;
pub mod task_graph;
pub(crate) mod task_input;
pub mod task_scheduler;
mod test_config;
mod test_result_parser;
mod tester_runtime;
pub(crate) mod tool_audit;
mod tool_confirmation_router;
mod tool_execution;
pub(crate) mod tool_idempotency;
pub(crate) mod tool_security;
mod tool_task;
pub mod types;
mod user_report;
pub mod validate_extensions;
pub mod validation_invocation;
pub mod workers;
mod workspace_discovery;

pub use crate::permission::failure_semantics::CodeProFailureKind;
pub use activity_event::{
    ActivityEvent, ActivityEventKind, ActivityEventStatus, ACTIVITY_EVENT_SCHEMA_VERSION,
};
pub use agent::{Agent, AgentConfig, AgentEvent, ExtensionLoadResult, GoosePlatform};
pub(crate) use agent::{
    CodeProCheckpointContext, CodeProCheckpointInputDecision, CodeProResumeRequest,
    CodeProRetryStrategy,
};
pub use agent_role::AgentRole;
pub use codepro_event_log::{
    read_codepro_event_records, CodeProArtifactStore, CodeProEventLog, CodeProEventRecord,
};
pub use codepro_state_store::{
    CodeProCleanupPolicy, CodeProCleanupReport, CodeProRunState, CodeProRunStatus,
    CodeProStateStore,
};
pub use codepro_workspace::{
    CodeProGitWorktreeMetadata, CodeProWorkspaceDescriptor, CodeProWorkspaceMode,
    CodeProWorkspaceProjection, CODEPRO_WORKSPACE_SCHEMA_VERSION,
};
pub use container::Container;
pub use execute_commands::COMPACT_TRIGGERS;
pub use extension::{ExtensionConfig, ExtensionError};
pub use extension_manager::ExtensionManager;
pub use finding_record::{
    classify_finding_validation, compare_finding_runs, false_positive_still_applies,
    generate_finding_fingerprint, select_finding_reruns, validate_finding_candidate,
    validate_finding_replay_contract, validate_finding_replay_review, validate_finding_validation,
    CoverageRecord, FindingCandidate, FindingCheckDefinition, FindingComparisonCoverage,
    FindingFalsePositive, FindingFingerprintInput, FindingKind, FindingLifecycle, FindingRecord,
    FindingReplayContract, FindingReplayReview, FindingRerunInput, FindingRunComparison,
    FindingRunSnapshot, FindingValidation, FindingValidationDecision,
    FindingValidationDecisionReason, FindingValidationStatus, SourceLocation, VerificationEvidence,
    COVERAGE_RECORD_SCHEMA_VERSION, FINDING_CANDIDATE_SCHEMA_VERSION,
    FINDING_CHECK_DEFINITION_SCHEMA_VERSION, FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION,
    FINDING_FALSE_POSITIVE_SCHEMA_VERSION, FINDING_FINGERPRINT_INPUT_SCHEMA_VERSION,
    FINDING_RECORD_SCHEMA_VERSION, FINDING_REPLAY_CONTRACT_SCHEMA_VERSION,
    FINDING_REPLAY_REVIEW_SCHEMA_VERSION, FINDING_RERUN_INPUT_SCHEMA_VERSION,
    FINDING_RUN_COMPARISON_SCHEMA_VERSION, FINDING_RUN_SNAPSHOT_SCHEMA_VERSION,
    FINDING_VALIDATION_SCHEMA_VERSION,
};
pub use model_router::{ModelRouter, ModelRouterConfig};
pub use planner_agent::PlannerAgent;
pub use platform_extensions::codepro_memory::CodeProMemoryClient;
pub use platform_extensions::git::GitClient;
pub use platform_extensions::project_memory::ProjectMemoryClient;
pub use prompt_manager::PromptManager;
pub use result_aggregator::ResultAggregator;
pub use subagent_handler::SUBAGENT_TOOL_REQUEST_TYPE;
pub use subagent_task_config::TaskConfig;
pub use task_dag::{DagOutcome, TaskDAG, TaskNode, TaskOutput, TaskStatus};
pub use task_detector::TaskDetector;
pub use task_scheduler::TaskScheduler;
pub(crate) use tool_confirmation_router::ToolConfirmationOutcome;
pub use tool_execution::ToolCallContext;
pub use types::{FrontendTool, RetryConfig, SessionConfig, SuccessCheck};

pub mod vision_service;
mod web_search_routing;
