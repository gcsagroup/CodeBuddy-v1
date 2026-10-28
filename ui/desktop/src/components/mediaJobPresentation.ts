import {
  getToolRequests,
  getToolResponses,
  type Message,
  type ToolRequestMessageContent,
  type ToolResponseMessageContent,
} from '../types/message';
import { generatedMediaReceipt } from '../utils/mediaToolReceipt';
import { presentedToolCall } from './codepro/CodeProToolContent';
import type { MediaJob } from '../workspace-panel/WorkspaceGeneration';

export interface MediaJobCall {
  request: ToolRequestMessageContent;
  response?: ToolResponseMessageContent;
  responseOrder: number;
}
export interface MediaJobPresentation {
  key: string;
  jobId: string;
  kind: 'image' | 'video';
  anchorId: string;
  calls: MediaJobCall[];
  latestReturned?: MediaJobCall;
  latestReceipt?: { call: MediaJobCall; value: Record<string, unknown> };
  historyUncertain: boolean;
}
export type MediaJobsByCall = ReadonlyMap<string, MediaJobPresentation>;

export interface MediaJobObservation {
  status: string;
  active: boolean;
  receipt?: Record<string, unknown>;
  source: 'snapshot' | 'receipt' | 'unavailable';
}
const statuses = new Set([
  'preparing',
  'submission_unknown',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'unavailable',
]);
const terminal = (status: unknown) => ['completed', 'failed', 'cancelled'].includes(String(status));
const identity = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// Only native capabilities have this receipt contract. Similar external tool
// names cannot establish the contract or its ID namespace.
export function mediaToolKind(name: string): 'image' | 'video' | undefined {
  return name === 'generate_image' ? 'image' : name === 'generate_video' ? 'video' : undefined;
}

// This projection is scoped to one conversation. Returned owner receipts
// establish jobs; pending arguments can join one, but cannot manufacture one.
export function collectMediaJobs(
  messages: Message[],
  visibleMessages: Message[] = messages
): MediaJobsByCall {
  const requests = new Map<string, ToolRequestMessageContent>();
  const responses = new Map<string, { response: ToolResponseMessageContent; order: number }>();
  let order = 0;
  for (const message of messages) {
    for (const request of getToolRequests(message)) requests.set(request.id, request);
    for (const response of getToolResponses(message))
      responses.set(response.id, { response, order: order++ });
  }
  const jobs = new Map<string, MediaJobPresentation>();
  for (const request of requests.values()) {
    const call = presentedToolCall(request);
    const kind = call && mediaToolKind(call.name);
    if (
      !call ||
      !kind ||
      !['generate', 'status', 'cancel'].includes(String(call.arguments.operation))
    )
      continue;
    const value = generatedMediaReceipt(responses.get(request.id)?.response);
    if (
      !value ||
      !identity(value.job_id) ||
      !statuses.has(String(value.status)) ||
      (value.kind !== undefined && value.kind !== kind) ||
      (call.arguments.operation !== 'generate' && call.arguments.job_id !== value.job_id)
    )
      continue;
    const key = JSON.stringify([kind, value.job_id]);
    if (!jobs.has(key))
      jobs.set(key, {
        key,
        jobId: value.job_id,
        kind,
        anchorId: request.id,
        calls: [],
        historyUncertain: false,
      });
  }
  const byCall = new Map<string, MediaJobPresentation>();
  for (const request of requests.values()) {
    const call = presentedToolCall(request);
    const kind = call && mediaToolKind(call.name);
    if (
      !call ||
      !kind ||
      !['generate', 'status', 'cancel'].includes(String(call.arguments.operation))
    )
      continue;
    const returned = responses.get(request.id);
    const value = generatedMediaReceipt(returned?.response);
    const jobId =
      call.arguments.operation === 'generate'
        ? (value?.job_id ?? call.arguments.request_id)
        : call.arguments.job_id;
    if (
      !identity(jobId) ||
      (value?.job_id !== undefined && value.job_id !== jobId) ||
      (value?.kind !== undefined && value.kind !== kind)
    )
      continue;
    const job = jobs.get(JSON.stringify([kind, jobId]));
    if (!job) continue;
    const entry = { request, response: returned?.response, responseOrder: returned?.order ?? -1 };
    job.calls.push(entry);
    byCall.set(request.id, job);
    if (returned && entry.responseOrder > (job.latestReturned?.responseOrder ?? -1))
      job.latestReturned = entry;
    if (
      value?.job_id === jobId &&
      statuses.has(String(value.status)) &&
      entry.responseOrder > (job.latestReceipt?.call.responseOrder ?? -1)
    )
      job.latestReceipt = { call: entry, value };
  }
  for (const job of jobs.values()) {
    let settled: string | undefined;
    for (const call of [...job.calls].sort((a, b) => a.responseOrder - b.responseOrder)) {
      const status = generatedMediaReceipt(call.response)?.status;
      if (typeof status !== 'string' || !statuses.has(status)) continue;
      // There is no job revision to distinguish corrections from stale replies,
      // including legacy cancelled -> running observations.
      if (settled && status !== settled) job.historyUncertain = true;
      if (terminal(status)) settled = status;
    }
  }
  const anchored = new Set<string>();
  for (const message of visibleMessages)
    for (const request of getToolRequests(message)) {
      const job = byCall.get(request.id);
      if (job && !anchored.has(job.key)) {
        job.anchorId = request.id;
        anchored.add(job.key);
      }
    }
  return byCall;
}

// Read display evidence, never decide execution. Failed observations cannot
// promote cached terminals, and conflicting terminal evidence stays unknown.
export function mediaJobObservation(
  job: MediaJobPresentation,
  snapshot: { jobs: MediaJob[]; disconnected: boolean }
): MediaJobObservation {
  const unknown: MediaJobObservation = {
    status: 'unavailable',
    active: false,
    source: 'unavailable',
  };
  if (job.historyUncertain) return unknown;
  const history = job.latestReceipt?.value;
  const current = snapshot.jobs.find(
    (value) => value.job_id === job.jobId && value.kind === job.kind
  );
  if (
    current &&
    ((current.status === 'cancelled' && history?.cancellation_confirmed === false) ||
      (history?.status === 'cancelled' && current.status !== 'cancelled'))
  )
    return unknown;
  if (
    current &&
    terminal(history?.status) &&
    current.status !== history?.status &&
    (terminal(current.status) || (!snapshot.disconnected && !current.observation_error))
  )
    return unknown;
  if (current && !snapshot.disconnected && !current.observation_error) {
    if (!statuses.has(current.status)) return unknown;
    return {
      status: current.status,
      active: ['preparing', 'queued', 'running'].includes(current.status),
      receipt: { ...current },
      source: 'snapshot',
    };
  }
  if (!history) return unknown;
  if (terminal(history.status))
    return { status: String(history.status), active: false, receipt: history, source: 'receipt' };
  if (snapshot.disconnected || current?.observation_error) return unknown;
  const last = job.latestReturned;
  if (last && !generatedMediaReceipt(last.response)) return unknown;
  return { status: String(history.status), active: false, receipt: history, source: 'receipt' };
}
