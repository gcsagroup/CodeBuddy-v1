//! The Main Agent proposes semantic relationships; the existing control plane
//! retains ownership of revisions, authorization, receipts, and terminal state.
use crate::agents::protocol::{
    EvidenceRequirement, ExecutionObligation, RequirementSemantics, UserRequirement,
};
use rmcp::model::{Tool, ToolAnnotations};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub(crate) const TOOL_NAME: &str = "codepro__task_contract";
pub(crate) const PROGRESS_TOOL_NAME: &str = "codepro__publish_progress";
pub(crate) const REVISION_BATCH_NOT_RUN: &str = "No calls in this batch were executed. Submit codepro__task_contract revise alone, then wait for its receipt before calling other tools; a changed requirement revision can invalidate prior workspace authorization.";
pub(crate) const FINISH_BATCH_NOT_RUN: &str = "No calls in this batch were executed. Submit propose_coverage or report_blocked alone so finalization cannot race sibling actions. Rejected coverage does not finish the task.";

pub(crate) const PUBLIC_PROGRESS_INSTRUCTIONS: &str = r#"

# Explain the work as it happens

Use codepro__publish_progress for a useful public update, including during read-only investigation. Its optional stage is a concise title describing the concrete problem you are working on, in the user's language: for example, 追踪消息从模型到界面的传递路径, not merely 正在分析代码. It is your publicly declared work focus, not private reasoning, execution evidence, or a success claim. The UI retains it within this turn while tools run. Update it when the focus actually changes, not after every tool or on a timer. Do not invent progress during silence.

Use codepro__publish_progress for meaningful stage changes, important findings, or blockers affecting the user's result. Group related reads, edits, commands and desktop actions into one concise update. Routine clicks and retries already have live tool activity; they do not each need a public paragraph.

Keep updates short, specific, and natural. Distinguish intended work, work in progress, and confirmed results. If an attempt fails, explain the effect on the user's task and what you will do next. When later evidence changes the picture, explicitly update the user; only say recovered or unaffected when the evidence supports it. Internal contracts, audit IDs, exit codes, and raw code belong in the expandable record, not in the public explanation. Do not expose private reasoning or repeat an update after every tool call. Publish the introduction before the execution tools when the user needs it to understand what starts next.

Put the explanation in text and its short title in stage in the same update; do not repeat that explanation as a second ordinary message. Where independent tool calls can share a batch, the update need not take a separate round trip. Never make extra reads, tests, retries or model rounds merely to refresh a title. No update is required for a brief direct answer. Missing or invalid optional stage does not prevent answering or completing the task. This communication tool does not grant any other tools or change the user's scope.
"#;

pub(crate) const DEVELOPMENT_DELIVERY_INSTRUCTIONS: &str = r#"

For a development request, your first action should be a short codepro__publish_progress introduction acknowledging the requested outcome and the first concrete step, before inspecting contracts or running commands. For multi-step work, use todo_write as a small user-facing checklist of deliverables, not a requirements document. Update that same checklist when a coherent step finishes or the next step changes; preserve completed items, do not replace a half-finished list with a different fully checked list. Do not include audit, contract or completion-proposal chores. A checked checklist is not a delivered result. Publish what remains in plain language if verification or startup is still unresolved.

In that checklist use [ ] for work not started, [-] for the step you are actually working on, and [x] for finished work. Mark the current step before starting its operations, with natural present-tense wording. These are public planning notes, not execution receipts or run state.

A user message arriving during execution is not automatically a requirement change. Answer incidental or explanatory questions with codepro__publish_progress, then continue the original work unless the user directs otherwise. Do not add such questions to the checklist or task contract. When the user actually changes the requested work, inspect the contract and its followup_inputs, then use revise with the real source_message_id before acting on that change. Preserve, replace or withdraw prior requirements explicitly as appropriate. Submit revise alone and wait for its receipt before execution tools. Neither a follow-up message nor a contract revision grants tool permissions. Do not silently ignore a requested change or treat a question as permission to change files.

For local web delivery, bind startup and readiness to the current workspace and the exact process you started. Check an available port before starting; an occupied port is not permission to stop its owner. Match the response to this project's routes and expected content, not just HTTP 200 or a page title shared with an older project. If /login and /auth/login disagree with the source, investigate identity before changing application code. Never assume an absent PID means cached HTTP responses or that an unowned listener belongs to this task. Prefer an unused port over terminating another task's service. Leave an explicitly requested usable service running and provide its verified address; do not clean it up immediately before offering the user a link.

Use developer shell process_action=start with a foreground command and its concrete port for a local web service. This retains an OS process-group owner and redirects streams without pipe timeouts. Use process_action=status/stop with its returned process_handle and identical command. A running group is not readiness: on Windows require listener_owned=true and verify the route/content before giving the address. If the owner probe is unavailable, say so; do not substitute a shared HTTP 200. Handles are scoped to this backend session and are invalid after restart; older unmanaged commands have no such handle and cannot be certified retrospectively.

Unresolved host receipts are not user-owned decisions. Never ask the user to confirm that an unknown command succeeded or promise that clicking an option will unlock completion. A user reply cannot reconcile execution evidence. If the host has no supported verification path, stop retrying that internal step, explain the concrete delivery limitation and preserve verified results. Do not expose the internal procedure as the user's next task.

Follow the user's explicit language choice, then known preference, then the current query's language, using UI locale only as fallback. Do not ask which language to use when the query is clear. Use the user's terms and level of technical detail. Never invent progress to fill silence. Public updates are commentary, not evidence, permission, or a completion decision.

The final delivery should explain what the user received, what was actually checked, remaining limitations, the current running state if relevant, and the concrete next step. Distinguish file creation, service readiness, page smoke checks, and business workflows actually exercised; an exit code or page count does not establish untested behavior. Provide an existing usable link or file location when available. Do not advertise a stopped service as an openable application, invent a launch control, or imply that an old successful check proves current availability. Submit propose_coverage alone before the final delivery; its accepted receipt closes execution and the following response answers the user without tools. Rejection remains a tool result, not a new user request. Host receipt checks do not independently certify semantic test coverage.
"#;

/// A presentation-only message. It cannot mutate the task contract or supply
/// completion evidence; the normal request/receipt pair is its persisted source.
pub(crate) fn publish_progress(
    arguments: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Progress {
        text: String,
        #[serde(default)]
        stage: Option<serde_json::Value>,
    }
    let progress: Progress = serde_json::from_value(json!(arguments))
        .map_err(|error| format!("Invalid public progress: {error}"))?;
    if progress.text.trim().is_empty() || progress.text.chars().count() > 4000 {
        return Err(
            "Public progress must contain 1 to 4000 characters of concise user-facing explanation."
                .to_string(),
        );
    }
    let stage = progress
        .stage
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|stage| !stage.is_empty() && stage.chars().count() <= 100);
    Ok(json!({ "schema_version": 1, "published": true, "stage": stage }))
}

pub(crate) fn progress_tool() -> Tool {
    Tool::new(PROGRESS_TOOL_NAME,
        "Give a concise update when the stage changes, an important result arrives, or a blocker affects the user. Group routine tool calls, desktop clicks and retries; do not narrate every invocation. Use the user's language, leaving technical diagnostics in expandable details. This public commentary cannot change requirements, grant permission, supply evidence or finish the task.",
        json!({"type":"object", "properties":{"text":{"type":"string","minLength":1,"maxLength":4000},"stage":{"type":"string","maxLength":100,"description":"Optional short current activity title in the user's language; not a completion claim."}}, "required":["text"], "additionalProperties":false}).as_object().expect("literal object").clone())
        .annotate(ToolAnnotations::with_title("Progress update").read_only(true).destructive(false).idempotent(false).open_world(false))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ContractRequest {
    Inspect,
    ReportBlocked {
        summary: String,
    },
    Revise {
        requirement_revision: u32,
        requirements: Vec<ProposedRequirement>,
    },
    ProposeCoverage {
        requirement_revision: u32,
        coverage: Vec<ActionCoverage>,
        #[serde(default)]
        summary: Option<String>,
    },
}

// These are the existing wire shapes, not new operations or relaxed defaults.
const OPERATION_FIELDS: &[(&str, &[&str], &[&str])] = &[
    ("inspect", &["operation"], &[]),
    ("report_blocked", &["operation", "summary"], &[]),
    (
        "revise",
        &["operation", "requirement_revision", "requirements"],
        &[],
    ),
    (
        "propose_coverage",
        &["operation", "requirement_revision", "coverage"],
        &["summary"],
    ),
];

impl ContractRequest {
    pub(crate) fn parse(arguments: Option<&rmcp::model::JsonObject>) -> Result<Self, String> {
        parse_request(
            arguments
                .cloned()
                .map(serde_json::Value::Object)
                .unwrap_or_else(|| json!({})),
        )
    }
}

fn parse_request_strict(value: serde_json::Value) -> Result<ContractRequest, String> {
    let shape = OPERATION_FIELDS.iter().find(|(operation, _, _)| {
        value.get("operation").and_then(serde_json::Value::as_str) == Some(*operation)
    });
    serde_path_to_error::deserialize(value.clone())
            .map_err(|error| {
                // Internally tagged enums buffer their payload and can lose nested
                // Serde paths. Recover the path from the same requirement wire type.
                if shape.is_some_and(|(operation, _, _)| *operation == "revise") {
                    if let Some(requirements) = value.get("requirements") {
                        if let Err(nested) = serde_path_to_error::deserialize::<_, Vec<ProposedRequirement>>(requirements.clone()) {
                            return format!("requirements{}: {}", nested.path(), nested.inner());
                        }
                    }
                }
                error.to_string()
            })
            .and_then(|request| {
                // Serde's internally tagged unit variant ignores extra fields even
                // with deny_unknown_fields. Enforce the advertised operation shape.
                if let (Some((_, required, optional)), Some(fields)) = (shape, value.as_object()) {
                    if let Some(field) = fields.keys().find(|field| {
                        !required.contains(&field.as_str()) && !optional.contains(&field.as_str())
                    }) {
                        return Err(format!("unknown field `{field}`"));
                    }
                }
                Ok(request)
            })
            .map_err(|error| {
            let expected = shape.map_or_else(
                || "operation must be one of inspect, report_blocked, revise, propose_coverage".to_string(),
                |(operation, required, optional)| {
                    let optional_note = if optional.is_empty() {
                        String::new()
                    } else {
                        format!("; optional fields: {}", optional.join(", "))
                    };
                    format!("{operation} requires these top-level fields: {}{optional_note}; no other fields are accepted", required.join(", "))
                },
            );
            format!("Invalid task contract proposal: {error}. {expected}. No requirements, coverage or terminal state were changed. Read the tool schema; use inspect for the current revision and actual action IDs, not invented values.")
            })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProposedRequirement {
    pub requirement_id: String,
    pub source_message_id: String,
    pub semantics: RequirementSemantics,
    #[serde(default)]
    pub execution_obligations: Vec<ProposedExecution>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProposedExecution {
    pub obligation_id: String,
    pub command: String,
    pub cwd: String,
    pub evidence_requirement: EvidenceRequirement,
}

impl ProposedRequirement {
    pub(crate) fn into_requirement(self) -> Result<UserRequirement, String> {
        if self.semantics.expected_effect
            == Some(crate::agents::protocol::RequirementEffect::Execution)
            && self.execution_obligations.is_empty()
        {
            return Err("An execution requirement needs at least one execution_obligation binding its command, absolute cwd, and required exit outcome. An unrelated successful command cannot prove this requirement.".to_string());
        }
        let mut obligations = Vec::new();
        for execution in self.execution_obligations {
            if !std::path::Path::new(&execution.cwd).is_absolute() {
                return Err("execution obligation cwd must be an absolute path".to_string());
            }
            let invocation = super::validation_invocation::ValidationInvocation::for_evidence(
                &execution.command,
                std::path::Path::new(&execution.cwd),
            )
            .map_err(|error| format!(
                "Execution obligation '{}' was not registered ({}); no command was executed by this proposal. {} Inspect the existing contract before revising it; ordinary tool execution and required validation obligations are separate.",
                execution.obligation_id, error.code(), error.recoverable_message()
            ))?;
            obligations.push(ExecutionObligation {
                obligation_id: execution.obligation_id,
                source_message_id: self.source_message_id.clone(),
                invocation,
                evidence_requirement: execution.evidence_requirement,
                allow_equivalent_invocation: false,
            });
        }
        Ok(UserRequirement {
            requirement_id: self.requirement_id,
            source_message_id: self.source_message_id,
            continuation_source: None,
            semantics: Some(self.semantics),
            execution_obligations: obligations,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ActionCoverage {
    pub requirement_id: String,
    pub audit_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub desktop_results: Vec<DesktopResultEvidence>,
}

/// The Agent interprets images; the host checks provenance and action/image binding.
/// These claims never turn an input receipt into remote delivery confirmation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopResultEvidence {
    pub action_id: String,
    pub observation_id: String,
    pub result: DesktopResultKind,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopResultKind {
    UiState,
    UiSubmitted,
    ApplicationResponse,
}

pub(crate) fn validate_effect_revision(
    previous: &UserRequirement,
    proposed: &UserRequirement,
) -> Result<(), String> {
    use crate::agents::protocol::RequirementEffect;
    let old_effect = previous.semantics.as_ref().and_then(|s| s.expected_effect);
    let new_effect = proposed.semantics.as_ref().and_then(|s| s.expected_effect);
    if previous.source_message_id == proposed.source_message_id
        && matches!(
            (old_effect, new_effect),
            (
                Some(RequirementEffect::ExternalEffect),
                Some(RequirementEffect::Observation | RequirementEffect::DesktopInteraction)
            ) | (
                Some(RequirementEffect::DesktopInteraction),
                Some(RequirementEffect::Observation)
            )
        )
    {
        return Err("An existing delivery/desktop action requirement cannot be downgraded to a weaker observation using the same user input. Preserve it, obtain its required receipt, or report the specific unconfirmed delivery; never resend to repair evidence.".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CoverageProposal {
    pub requirement_revision: u32,
    pub coverage: Vec<ActionCoverage>,
}

/// Protocol guidance only: examples never select receipts or certify coverage.
pub(crate) fn request_formats() -> serde_json::Value {
    json!({
        "inspect": {"operation":"inspect"},
        "revise": {"operation":"revise","requirement_revision":1,"requirements":[{
            "requirement_id":"REQUIREMENT_ID","source_message_id":"SOURCE_MESSAGE_ID",
            "semantics":{"content":"UNCHANGED_USER_REQUIREMENT","target_resources":[],
                "expected_effect":"observation","revision_relation":{
                    "previous_revision":1,"requirement_ids":["REQUIREMENT_ID"],"kind":"replaced"}}
        }]},
        "propose_coverage": {"operation":"propose_coverage","requirement_revision":1,
            "coverage":[{"requirement_id":"REQUIREMENT_ID","audit_ids":["ACTUAL_CALL_ID"]}]},
        "report_blocked": {"operation":"report_blocked","summary":"CONCRETE_DELIVERY_AND_GAP"}
    })
}

pub(crate) fn parse_request(value: serde_json::Value) -> Result<ContractRequest, String> {
    parse_request_strict(value.clone()).map_err(|error| {
        let formats = request_formats();
        let expected = value.get("operation").and_then(serde_json::Value::as_str)
            .and_then(|operation| formats.get(operation)).unwrap_or(&formats);
        format!("Invalid task contract request: {error}. No contract state changed. Expected argument structure: {expected}. Only operation fields belong at the top level. Each requirement's revision_relation belongs at requirements[i].semantics.revision_relation, not at requirements[i].revision_relation; coverage and audit_ids are JSON arrays, not JSON strings. Replace example identifiers and revision using inspect; choose expected_effect and revision relation kind from the actual user requirement. Do not replay completed actions.")
    })
}

#[cfg(test)]
mod request_format_tests {
    use super::*;

    #[test]
    fn revision_relation_repair_preserves_nested_semantics() {
        let valid = request_formats()["revise"].clone();
        let mut misplaced = valid.clone();
        let relation = misplaced["requirements"][0]["semantics"]
            .as_object_mut()
            .unwrap()
            .remove("revision_relation")
            .unwrap();
        misplaced["requirements"][0]["revision_relation"] = relation;
        let error = parse_request(misplaced).unwrap_err();
        assert!(error.contains("requirements[0]"), "{error}");
        assert!(error.contains("requirements[i].semantics.revision_relation"));
        assert!(error.contains("No contract state changed"));
        assert!(!error.contains("Fields belong at the top level"));
        let ContractRequest::Revise { requirements, .. } = parse_request(valid).unwrap() else {
            panic!("revise expected")
        };
        assert!(requirements[0].semantics.revision_relation.is_some());
        // Whether a relation is required depends on committed state, owned by RunProjection.
        let mut missing = request_formats()["revise"].clone();
        missing["requirements"][0]["semantics"]
            .as_object_mut()
            .unwrap()
            .remove("revision_relation");
        assert!(parse_request(missing).is_ok());
    }

    #[test]
    fn task_contract_reports_repairable_shapes_for_real_malformed_calls() {
        let invalid = [
            json!({"operation":"propose_coverage","revision":1,"audit_ids":"[\"call_saved\"]"}),
            json!({"operation":"propose_coverage","payload":{"coverage":[]}}),
            json!({"operation":"propose_coverage","requirement_revision":1,"coverage":[{"requirement_id":"run-goal","audit_ids":["call_saved"],"basis":"done"}]}),
        ];
        for value in invalid {
            let error = parse_request(value).unwrap_err();
            assert!(error.contains("No contract state changed"));
            assert!(error.contains("\"requirement_revision\":1"));
            assert!(error.contains("\"audit_ids\":[\"ACTUAL_CALL_ID\"]"));
        }
        let corrected = json!({"operation":"propose_coverage","requirement_revision":2,
            "coverage":[{"requirement_id":"run-goal","audit_ids":["call_saved"]}]});
        let ContractRequest::ProposeCoverage {
            requirement_revision,
            coverage,
            ..
        } = parse_request(corrected).unwrap()
        else {
            panic!("coverage request expected")
        };
        assert_eq!(requirement_revision, 2);
        assert_eq!(coverage[0].audit_ids, ["call_saved"]);
        for example in request_formats().as_object().unwrap().values() {
            parse_request(example.clone()).expect("repair examples must remain parseable");
        }
    }
}

pub(crate) fn tool() -> Tool {
    let mut schema = json!({
        "type": "object",
        "properties": {
            "operation": {"type":"string", "enum":["inspect", "revise", "propose_coverage", "report_blocked"]},
            "summary": {"type":"string", "minLength":1, "maxLength":6000,
                "description":"For report_blocked: concise handoff proposal describing confirmed work and the remaining gap; the final user answer follows the committed run outcome. For propose_coverage: optional concise completion proposal, checked before generating the final answer. Neither is completion evidence."},
            "requirement_revision": {"type":"integer", "minimum":1},
            "requirements": {"type":"array", "items":{
                "type":"object",
                "properties": {
                    "requirement_id":{"type":"string"},
                    "source_message_id":{"type":"string"},
                    "semantics": {"type":"object", "properties":{
                        "content":{"type":"string"},
                        "target_resources":{"type":"array", "items":{"type":"string"}},
                        "expected_effect":{"type":"string", "enum":["workspace_change","observation","execution","external_effect","desktop_interaction","memory_update"]},
                        "revision_relation":{"type":"object", "properties":{
                            "previous_revision":{"type":"integer"},
                            "requirement_ids":{"type":"array", "items":{"type":"string"}},
                            "kind":{"type":"string", "enum":["retained","replaced","withdrawn"]}
                        }, "required":["previous_revision","requirement_ids","kind"], "additionalProperties":false}
                    }, "required":["content","target_resources","expected_effect"], "additionalProperties":false},
                    "execution_obligations":{"type":"array", "items":{
                        "type":"object", "properties":{
                            "obligation_id":{"type":"string"},
                            "command":{"type":"string"},
                            "cwd":{"type":"string"},
                            "evidence_requirement":{"type":"string","enum":["exit_code_observed","successful_exit_code"]}
                        },"required":["obligation_id","command","cwd","evidence_requirement"],"additionalProperties":false
                    }}
                }, "required":["requirement_id","source_message_id","semantics"], "additionalProperties":false
            }},
            "coverage":{"type":"array", "items":{
                "type":"object", "properties":{
                    "requirement_id":{"type":"string"},
                    "desktop_results":{"type":"array", "description":"Required for desktop_interaction. Cite the actual state-changing action and its after-image (the same receipt is allowed). Summarize the visible target/content/result, not just tool success. These are visual claims, not independent remote delivery receipts.", "items":{"type":"object","properties":{
                        "action_id":{"type":"string"},"observation_id":{"type":"string"},
                        "result":{"type":"string","enum":["ui_state","ui_submitted","application_response"]},
                        "summary":{"type":"string","minLength":1,"maxLength":2000}
                    },"required":["action_id","observation_id","result","summary"],"additionalProperties":false}},
                    "audit_ids":{"type":"array", "description":"Exact audit IDs or shorter callId values from inspect. The host resolves callId to its own receipt; never reconstruct or guess an ID.", "items":{"type":"string"}, "minItems":1}
                }, "required":["requirement_id","audit_ids"], "additionalProperties":false
            }}
        }, "required":["operation"], "additionalProperties":false
    });
    // Keep the root object for provider compatibility, with an exact branch for
    // each serde variant. In particular report_blocked has no revision field.
    schema["oneOf"] = serde_json::Value::Array(OPERATION_FIELDS.iter().map(|(operation, required, optional)| {
        let mut properties = rmcp::model::JsonObject::new();
        for field in required.iter().chain(optional.iter()) {
            properties.insert((*field).to_string(), schema["properties"][*field].clone());
        }
        properties.insert("operation".to_string(), json!({"type":"string", "enum":[operation]}));
        json!({"type":"object", "properties":properties, "required":required, "additionalProperties":false})
    }).collect());
    Tool::new(TOOL_NAME, concat!(
        "Inspect the current task contract and real action index. This tool never grants permission. inspect returns request_formats with exact argument shapes; use top-level fields and JSON arrays, not wrappers or stringified JSON. Replace example values from the current contract and real receipts. Accepted propose_coverage closes execution after host validation; rejection does not complete the run. ",
        "Use report_blocked with summary when no supported action can resolve the blocker. This requests a normal paused handoff, not successful completion, does not waive any requirement, and preserves all uncertain operations. After the pause is committed, answer the user using the returned run facts; execution tools are no longer available. Call it alone, without execution tools in the same batch. Do not keep probing unrelated processes or ask the user to certify tool outcomes. ",
        "Use inspect first to read the current revision and requirements. If an expected_effect is unknown, classify it once with revise (replaced) before performing the requested work rather than waiting for finalization to fail. Both revise and propose_coverage require requirement_revision from inspect; revise also requires requirements and propose_coverage requires coverage. ",
        "Use revise to clarify active requirements or incorporate an actual change requested in followup_inputs, using their real source_message_id from inspect. followup_inputs are raw messages received during this execution, not accepted requirements; ordinary questions need only a public answer and must not change the contract. Submit revise alone before executing changed work. Include every prior active requirement through retained, replaced, or withdrawn relations. Retained means unchanged semantics and obligations. To clarify an unknown effect or change an existing requirement, use replaced referencing the previous revision and requirement IDs, preserving the actual user request. ",
        "Do not weaken a requirement because execution failed. Preserve user constraints, including who may implement. ",
        "expected_effect describes the requested result, not a tool's permission category. workspace_change needs concrete target_resources and observed file changes; observation covers diagnosis or inspection, even a diagnostic nonzero exit. ",
        "For desktop inspection or a local on-screen result, use observation with the exact desktop:PID/HWND resource or app/window identity from inspect desktopObservation. A successful desktop action may include a fresh after-image usable as observation: interpret that image, use its current receipt, and do not take a redundant screenshot solely for coverage. A stale image does not cover a later action. Use desktop_interaction for a requested GUI operation whose result can be checked in the application, including submitting a chat message or obtaining an application reply. Keep the exact user goal and constraints; this is not observation-only work. Bind target_resources to the actual desktop:PID/HWND and provide desktop_results with the state-changing action_id, its after-image observation_id, result (ui_submitted, application_response, or ui_state), and a concrete visual summary. The action receipt itself is sufficient when its after-image shows the result; otherwise observe without repeating the action. Confirm the requested recipient, content, draft preservation and postcondition from the images. A visible new outgoing bubble proves UI submission, not recipient delivery; a matching application reply proves the observed reply. Do not block these ordinary UI goals merely because there is no remote delivery API. Use external_effect when the user actually requires independently confirmed remote delivery or another owner-confirmed external result; preserve that requirement and report its precise gap if unavailable. Never downgrade an already-bound external_effect based on the same user input. Unknown sends must be reconciled by observation, never replayed. ",
        "An execution requirement must include at least one execution_obligation. Register requested execution obligations using the exact shell command and absolute working directory used by the shell tool; registration does not execute or authorize it. The host derives invocation identity independently from execution policy. Use exit_code_observed for diagnosis or successful_exit_code when success is required. ",
        "Use propose_coverage only when every active requirement is actually satisfied. If even one remains blocked, use report_blocked directly and describe both the completed portion and the gap; failed attempts and screenshots showing an unavailable target are not completion coverage. Do not repeatedly refresh unchanged windows or manufacture coverage for a known blocker. For successful completion, use propose_coverage with the current requirement_revision and exact audit IDs or callId values from inspect for each active requirement. Select currentResourceEvidence for file delivery, not every historical write. Inspect includes unresolved action details; do not search project memory for them. ",
        "Prose, memory persistence, plans, and tool success alone cannot prove delivery of project files. Report unresolved work rather than proposing false coverage."
    ), schema.as_object().expect("literal object").clone())
        .annotate(ToolAnnotations::with_title("当前任务与完成证据").read_only(false).destructive(false).idempotent(false).open_world(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_contract_schema_matches_operation_parser() {
        let schema = serde_json::to_value(tool().input_schema).unwrap();
        let validator = jsonschema::validator_for(&schema).unwrap();
        // Exercise the public provider schema and the runtime parser independently.
        // Evidence validity remains the responsibility of the existing coverage gate.
        for proposal in [
            json!({"operation":"inspect"}),
            json!({"operation":"report_blocked", "summary":"The input is missing."}),
            json!({"operation":"revise", "requirement_revision":1, "requirements":[]}),
            json!({"operation":"propose_coverage", "requirement_revision":1, "coverage":[]}),
            json!({"operation":"propose_coverage", "requirement_revision":1, "coverage":[], "summary":"Ready for checking."}),
        ] {
            assert!(validator.is_valid(&proposal), "schema rejected {proposal}");
            assert!(
                ContractRequest::parse(proposal.as_object()).is_ok(),
                "parser rejected {proposal}"
            );
        }
        for proposal in [
            json!({"operation":"propose_coverage", "coverage":[]}),
            json!({"operation":"propose_coverage", "requirement_revision":1}),
            json!({"operation":"propose_coverage", "requirement_revision":1, "coverage":[], "summary (optional)":"not a field"}),
            json!({"operation":"report_blocked", "summary":"Missing input", "requirement_revision":1}),
            json!({"operation":"inspect", "summary":"not allowed"}),
        ] {
            assert!(!validator.is_valid(&proposal), "schema accepted {proposal}");
            assert!(
                ContractRequest::parse(proposal.as_object()).is_err(),
                "parser accepted {proposal}"
            );
        }
    }
}
