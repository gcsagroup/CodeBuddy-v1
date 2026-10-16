import { Client, specTypeSchemas } from '@modelcontextprotocol/client';
import { CreateTaskResultSchema, GetTaskResultSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';

const extension = 'io.modelcontextprotocol/tasks';
const modernTask = z.object({
  taskId: z.string().min(1),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(), lastUpdatedAt: z.string(),
  ttlMs: z.number().int().nonnegative().nullable(),
  pollIntervalMs: z.number().int().nonnegative().optional(),
}).passthrough();
const modernCreated = modernTask.extend({ resultType: z.literal('task') });
const toolResult = specTypeSchemas.CallToolResult;
const legacyCallResult = union(CreateTaskResultSchema, toolResult);
const modernCallResult = union(modernCreated, toolResult);
const emptyResult = z.object({}).passthrough();

function union(...schemas) {
  return { '~standard': { version: 1, vendor: 'codebuddy-mcp', async validate(value) {
    for (const schema of schemas) {
      const parsed = await schema['~standard'].validate(value);
      if (!parsed.issues) return parsed;
    }
    return { issues: [{ message: 'Expected an MCP tool result or task creation result' }] };
  } } };
}

// SDK 2.2.0 supplies transport, request cancellation and era negotiation, but
// not a Tasks runtime. This version-pinned compatibility shim extends its
// internal codec only for negotiated Tasks. Recheck it when upgrading the SDK;
// ordinary results still use the SDK's unmodified decoder.
export class McpTaskClient extends Client {
  request(request, schemaOrOptions, maybeOptions) {
    const options = maybeOptions ?? schemaOrOptions;
    const tool = options?.toolDefinition;
    if (request.method !== 'tools/call' || !tool) return super.request(request, schemaOrOptions, maybeOptions);
    const mode = mcpTaskMode(this, tool);
    if (!mode) {
      if (tool.execution?.taskSupport === 'required') return Promise.reject(Error('MCP tool requires Tasks, but the server did not negotiate task execution'));
      return super.request(request, schemaOrOptions, maybeOptions);
    }
    // Keep Client.callTool() in charge of header mirroring and final output
    // schema validation. Its request settles only when the task result arrives.
    return runTaskCall(this, mode, request.params, options,
      (params, schema) => super.request({ ...request, params }, schema, options));
  }

  _resolveOutboundCodec(method) {
    const codec = super._resolveOutboundCodec(method);
    if (this.getProtocolEra() !== 'modern' || !this.getServerCapabilities()?.extensions?.[extension]) return codec;
    return {
      ...codec,
      hasRequestMethod: name => ['tasks/get', 'tasks/cancel'].includes(name) || codec.hasRequestMethod(name),
      decodeResult(name, raw) {
        if (name === 'tools/call' && raw?.resultType === 'task') {
          const parsed = modernCreated.safeParse(raw);
          return parsed.success ? { kind: 'complete', result: parsed.data }
            : { kind: 'invalid', error: Error('Invalid MCP task creation result') };
        }
        return codec.decodeResult(name, raw);
      },
    };
  }
}

function mcpTaskMode(client, tool) {
  const caps = client.getServerCapabilities();
  if (client.getProtocolEra() === 'modern') return caps?.extensions?.[extension] ? 'modern' : undefined;
  return caps?.tasks?.requests?.tools?.call && ['optional', 'required'].includes(tool.execution?.taskSupport)
    ? 'legacy' : undefined;
}

async function runTaskCall(client, mode, params, options, submit) {
  const first = await submit({
    ...params, ...(mode === 'legacy' ? { task: {} } : {}),
  }, mode === 'legacy' ? legacyCallResult : modernCallResult);
  let task = mode === 'legacy' ? first.task : first.resultType === 'task' ? first : undefined;
  if (!task) return first;
  const taskId = task.taskId;
  const taskOptions = options;
  try {
    for (;;) {
      if (task.taskId !== taskId) throw Error('MCP task response identity changed');
      if (task.status === 'completed' || mode === 'legacy' && task.status === 'failed') {
        return mode === 'legacy'
          ? await client.request({ method: 'tasks/result', params: { taskId } }, toolResult, taskOptions)
          : await validateToolResult(task.result);
      }
      if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'input_required')
        throw Error(`MCP task ${taskId}: ${task.status}; ${task.status === 'input_required' ? 'task input interaction is not supported' : 'no successful result confirmed'}`);
      const interval = mode === 'legacy' ? task.pollInterval : task.pollIntervalMs;
      await delay(Math.max(100, Math.min(interval ?? 1000, 2_147_483_647)), undefined, { signal: options.signal });
      task = await client.request({ method: 'tasks/get', params: { taskId } },
        mode === 'legacy' ? GetTaskResultSchema : modernTask, taskOptions);
    }
  } catch (error) {
    // Never resubmit tools/call after a task has been accepted. Cancellation is
    // cooperative; an acknowledgement is not proof that the remote work stopped.
    if (options.signal?.aborted && (mode === 'modern' || client.getServerCapabilities()?.tasks?.cancel)) {
      await client.request({ method: 'tasks/cancel', params: { taskId } }, emptyResult,
        { ...taskOptions, signal: AbortSignal.timeout(5000), timeout: 5000 }).catch(() => {});
    }
    const state = ['failed', 'cancelled', 'completed'].includes(task.status)
      ? `remote status is ${task.status}` : 'remote final state is unconfirmed';
    throw new Error(`MCP task ${taskId}: ${error.message}; ${state}`, { cause: error });
  }
}

async function validateToolResult(result) {
  const parsed = await toolResult['~standard'].validate(result);
  if (parsed.issues) throw Error('MCP task completed without a valid tool result');
  return parsed.value;
}
