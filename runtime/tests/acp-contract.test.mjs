import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createCompatServer } from "../server.mjs";
import { Compat } from "../compat.mjs";
import { permissionDriver } from './fixtures/permission-driver.mjs';
import { workspaceIdentity } from "../workspaces.mjs";
import { build } from "../../ui/node_modules/esbuild/lib/main.js";
import { fileURLToPath } from "node:url";
import {
  zCustomProviderDeleteResponse_unstable,
  zRefreshProviderInventoryResponse_unstable,
} from "../../ui/sdk/src/generated/zod.gen.ts";

const secret = "contract-test-only-secret";
const ext = (name) => `_goose/unstable/${name}`;
const providerUrls = new WeakMap();
let rendererAdapter;
async function originalRendererAdapter() {
  rendererAdapter ??= build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../../ui/desktop/src/acp/sessionNotificationAdapter.ts",
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  }).then(
    (result) =>
      import(
        "data:text/javascript;base64," +
          Buffer.from(result.outputFiles[0].text).toString("base64")
      ),
  );
  return (await rendererAdapter).createAcpSessionNotificationAdapter;
}

async function connect(baseUrl) {
  const ws = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/acp?token=${secret}`,
  );
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const notifications = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (Object.hasOwn(message, "id") && pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error)
        task.reject(
          Object.assign(new Error(message.error.message), message.error),
        );
      else task.resolve(message.result);
    } else if (message.method) notifications.push(message);
  });
  ws.addEventListener("close", () => {
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("ACP connection closed before response"));
    }
    pending.clear();
  });
  return {
    notifications,
    request(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    notify(method, params) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    reply(id, result) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    },
    close() {
      ws.close();
    },
  };
}

function controlledDriver(prompt) {
  return {
    permissions: permissionDriver(),
    created: [],
    cancelled: [],
    async createSession(input) {
      this.created.push(input);
      return { sessionId: input.sessionId };
    },
    async prompt(sessionId, content, options) {
      if (prompt) return prompt(sessionId, content, options);
      await options.onEvent({ type: "thinking_delta", text: "checking fixture" });
      await options.onEvent({ type: "text_delta", text: "first " });
      await options.onEvent({ type: "text_delta", text: "second" });
      await options.onEvent({
        type: "tool_call",
        id: "tool-1",
        name: "read_file",
        arguments: { path: "fixture.txt" },
      });
      await options.onEvent({
        type: "tool_result",
        id: "tool-1",
        result: "fixture contents",
        isError: false,
      });
      await options.onEvent({ type: "usage", inputTokens: 5, outputTokens: 8 });
      return { stopReason: "end_turn" };
    },
    async cancel(sessionId) {
      this.cancelled.push(sessionId);
    },
    async close() {},
  };
}

async function setup(t, driver = controlledDriver()) {
  const dataDir = await realpath(await mkdtemp(
    path.join(os.tmpdir(), "codebuddy-acp-contract-"),
  ));
  let server = await createCompatServer({ dataDir, secret, driver });
  const baseUrl = await server.listen(0, "127.0.0.1");
  const provider = http.createServer(async (request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models")
      response.end(JSON.stringify({ data: [{ id: "contract-model" }] }));
    else if (request.url === "/v1/chat/completions")
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        }),
      );
    else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.close());
    await server.close();
    await new Promise((resolve) => provider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const client = await connect(baseUrl);
  providerUrls.set(client, `http://127.0.0.1:${provider.address().port}`);
  clients.push(client);
  const initialize = await client.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "codebuddy-contract-test", version: "1.0.0" },
    clientCapabilities: { _meta: { goose: { customNotifications: true } } },
  });
  return {
    dataDir,
    server,
    baseUrl,
    client,
    initialize,
    driver,
    async restart() {
      clients.forEach((previous) => previous.close());
      await server.close();
      server = await createCompatServer({ dataDir, secret, driver });
      const next = await connect(await server.listen(0, "127.0.0.1"));
      clients.push(next);
      await next.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      providerUrls.set(next, providerUrls.get(client));
      return next;
    },
  };
}

async function configure(client) {
  const created = await client.request(ext("providers/custom/create"), {
    engine: "openai_compatible",
    displayName: "Controlled contract provider",
    apiUrl: providerUrls.get(client),
    requiresAuth: false,
    models: ["contract-model"],
    supportsStreaming: true,
    headers: {},
  });
  assert.equal(typeof created.providerId, "string");
  assert.equal(created.status.providerId, created.providerId);
  assert.equal(created.status.isConfigured, true);
  assert.ok(Array.isArray(created.refresh.started));
  await client.request(ext("defaults/save"), {
    providerId: created.providerId,
    modelId: "contract-model",
  });
  return created.providerId;
}

async function newSession(client, cwd) {
  const response = await client.request("session/new", {
    cwd,
    mcpServers: [],
    _meta: { client: "goose-desktop", workspaceMode: "code" },
  });
  assert.equal(typeof response.sessionId, "string");
  return response.sessionId;
}

function updates(client, sessionId) {
  return client.notifications
    .filter(
      (event) =>
        event.method === "session/update" &&
        event.params.sessionId === sessionId,
    )
    .map((event) => event.params.update);
}

test("original Electron readiness authenticates both health and ACP endpoints", async (t) => {
  const { baseUrl } = await setup(t);
  assert.equal(
    (await fetch(`${baseUrl}/status`, { headers: { "X-Secret-Key": secret } }))
      .ok,
    true,
  );
  assert.equal((await fetch(`${baseUrl}/acp?token=${secret}`)).status, 406);
  for (const endpoint of ["/acp", "/acp?token=wrong"]) {
    assert.ok(
      [401, 403].includes((await fetch(`${baseUrl}${endpoint}`)).status),
    );
  }
  assert.equal(
    (
      await fetch(
        `${baseUrl}/acp?token=${encodeURIComponent("é".repeat(secret.length))}`,
      )
    ).status,
    401,
  );
  assert.equal(
    (await fetch(`${baseUrl}/status`, { headers: { "X-Secret-Key": secret } }))
      .ok,
    true,
  );
});

test("initialize advertises working session capabilities and unsupported methods fail explicitly", async (t) => {
  const { client, initialize, dataDir } = await setup(t);
  assert.equal(initialize.protocolVersion, 1);
  assert.equal(typeof initialize.agentInfo.name, "string");
  assert.equal(initialize.agentCapabilities.loadSession, true);
  assert.equal(
    typeof initialize.agentCapabilities.sessionCapabilities.list,
    "object",
  );
  assert.ok(Array.isArray(initialize.authMethods));
  await assert.rejects(
    client.request("_goose/unstable/not-a-real-capability"),
    (error) => error.code === -32601,
  );
  await assert.rejects(
    client.request("session/new", {
      cwd: dataDir,
      mcpServers: [],
      _meta: { workspaceMode: "codepro" },
    }),
    (error) =>
      error.code === -32602 && /Configure a model provider/.test(error.message),
  );
  await assert.rejects(
    client.request(ext("codepro/model-routing/save"), {
      config: { advancedRoutingEnabled: false },
    }),
    (error) => error.code === -32602 && /routing/.test(error.message),
  );
});

test("provider/default/session contracts preserve the existing picker and session metadata", async (t) => {
  const { client, dataDir, driver } = await setup(t);
  const providerId = await configure(client);
  assert.deepEqual(await client.request(ext("defaults/read")), {
    providerId,
    modelId: "contract-model",
  });
  const inventory = await client.request(ext("providers/list"), {
    providerIds: [providerId],
  });
  const entry = inventory.entries.find(
    (provider) => provider.providerId === providerId,
  );
  assert.ok(entry);
  for (const key of [
    "providerName",
    "description",
    "defaultModel",
    "providerType",
    "category",
  ])
    assert.equal(typeof entry[key], "string", key);
  for (const key of ["configured", "supportsRefresh", "refreshing", "stale"])
    assert.equal(typeof entry[key], "boolean", key);
  for (const key of ["configKeys", "setupSteps", "models"])
    assert.ok(Array.isArray(entry[key]), key);
  assert.ok(
    entry.models.some(
      (model) =>
        model.id === "contract-model" && typeof model.name === "string",
    ),
  );
  const sessionId = await newSession(client, dataDir);
  const { session } = await client.request(ext("session/info"), { sessionId });
  assert.equal(session.sessionId, sessionId);
  assert.equal(session.cwd, dataDir);
  assert.equal(session._meta.providerId, providerId);
  assert.equal(session._meta.modelId, "contract-model");
  assert.equal(session._meta.sessionType, "user");
  assert.ok(Number.isFinite(Date.parse(session.updatedAt)));
  assert.equal(
    driver.created.length,
    0,
    "session metadata is available before capability initialization",
  );
  await client.request(ext("tools/list"), { sessionId });
  assert.ok(
    driver.created.some(
      (created) => created.sessionId === sessionId && created.cwd === dataDir,
    ),
  );
  const list = await client.request("session/list", {
    _meta: { types: ["user", "scheduled"] },
  });
  assert.ok(list.sessions.some((item) => item.sessionId === sessionId));
});

test('production ACP carries draft progress without storing a call or replaying a stopped input', async t => {
  const driver = controlledDriver(async (sessionId, _content, { onEvent }) => {
    await onEvent({ type: 'tool_input', sessionId, preview: { id: 'draft-only', name: 'write', kilobytes: 14 } });
    await onEvent({ type: 'assistant_end', sessionId });
    return { stopReason: 'cancelled' };
  });
  const { client, dataDir } = await setup(t, driver);
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Prepare a file' }], _meta: { 'codeagentpro/source-message-id': 'draft-input' } });
  assert.equal(result.stopReason, 'cancelled');
  const activity = client.notifications.filter(n => n.params?.sessionId === sessionId)
    .map(n => n.params.update).filter(u => u.sessionUpdate === 'status_message');
  assert.ok(activity.some(u => u.status?.data?.tool_input?.kilobytes === 14));
  assert.equal(updates(client, sessionId).filter(u => u.sessionUpdate === 'tool_call').length, 0);
  client.notifications.length = 0;
  await client.request('session/load', { sessionId, cwd: dataDir, mcpServers: [] });
  assert.doesNotMatch(JSON.stringify(updates(client, sessionId)), /draft-only|tool_input/);
});

test("driver deltas become stable message/thought/tool updates and replay as history", async (t) => {
  const { client, dataDir } = await setup(t);
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  const result = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Read fixture.txt" }],
    _meta: { "codeagentpro/source-message-id": "user-source-1" },
  });
  assert.equal(result.stopReason, "end_turn");
  const live = updates(client, sessionId);
  const text = live.filter(
    (item) => item.sessionUpdate === "agent_message_chunk",
  );
  assert.equal(text.map((item) => item.content.text).join(""), "first second");
  assert.ok(text.length >= 2, "upstream deltas must remain incremental");
  const thought = live.find(
    (item) => item.sessionUpdate === "agent_thought_chunk",
  );
  assert.equal(thought?.content.text, "checking fixture");
  const id = (item) => item.messageId ?? item._meta?.goose?.messageId;
  assert.equal(typeof id(text[0]), "string");
  assert.equal(id(thought), id(text[0]));
  const tool = live.find((item) => item.sessionUpdate === "tool_call");
  assert.equal(tool?.toolCallId, "tool-1");
  assert.deepEqual(tool.rawInput, { path: "fixture.txt" });
  assert.equal(
    tool._meta?.goose?.toolCall?.toolName ?? tool.title,
    "read_file",
  );
  const completed = live.find(
    (item) =>
      item.sessionUpdate === "tool_call_update" && item.toolCallId === "tool-1",
  );
  assert.equal(completed?.status, "completed");
  assert.ok(
    completed.content?.some(
      (item) =>
        item.type === "content" &&
        item.content.type === "text" &&
        item.content.text.includes("fixture contents"),
    ),
  );
  const { session } = await client.request(ext("session/info"), { sessionId });
  assert.ok(session._meta.messageCount >= 2);
  client.notifications.length = 0;
  await client.request("session/load", {
    sessionId,
    cwd: dataDir,
    mcpServers: [],
  });
  const replay = updates(client, sessionId);
  assert.equal(
    replay
      .filter((item) => item.sessionUpdate === "user_message_chunk")
      .map((item) => item.content.text)
      .join(""),
    "Read fixture.txt",
  );
  assert.equal(
    replay
      .filter((item) => item.sessionUpdate === "agent_message_chunk")
      .map((item) => item.content.text)
      .join(""),
    "first second",
  );
  assert.ok(
    replay.some((item) => item.sessionUpdate === "agent_thought_chunk"),
  );
  assert.ok(
    replay.some(
      (item) =>
        item.sessionUpdate === "tool_call_update" &&
        item.status === "completed",
    ),
  );
});

test("cancel is handled while prompt is pending on the same transport", async (t) => {
  let started;
  const promptStarted = new Promise((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const driver = controlledDriver(
    async (_sessionId, _content, { onEvent, signal }) => {
      onEvent({ type: "text_delta", text: "started" });
      started();
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      aborted = true;
      return { stopReason: "cancelled" };
    },
  );
  const { client, dataDir } = await setup(t, driver);
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  const pending = client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Controlled long operation" }],
  });
  await promptStarted;
  client.notify("session/cancel", { sessionId });
  const result = await pending;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(aborted, true);
});

test("malformed and missing sessions fail without dispatching the driver", async (t) => {
  let calls = 0;
  const { client, dataDir } = await setup(
    t,
    controlledDriver(async () => {
      calls++;
      return { stopReason: "end_turn" };
    }),
  );
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  await assert.rejects(
    client.request("session/prompt", {
      sessionId,
      prompt: "not a content array",
    }),
    (error) => Number.isInteger(error.code),
  );
  await assert.rejects(
    client.request("session/prompt", {
      sessionId: "missing-session",
      prompt: [{ type: "text", text: "hello" }],
    }),
    (error) => Number.isInteger(error.code),
  );
  await assert.rejects(
    client.request(ext("session/info"), { sessionId: "missing-session" }),
    (error) => Number.isInteger(error.code),
  );
  assert.equal(calls, 0);
});

test("preferences use a revision snapshot and config reads do not reveal credentials", async (t) => {
  const { client } = await setup(t);
  const before = await client.request(ext("preferences/read"), {
    keys: ["gooseThinkingEffort"],
  });
  assert.ok(Number.isSafeInteger(before.revision));
  await client.request(ext("preferences/save"), {
    expectedRevision: before.revision,
    values: [{ key: "gooseThinkingEffort", value: "high" }],
  });
  const after = await client.request(ext("preferences/read"), {
    keys: ["gooseThinkingEffort"],
  });
  assert.ok(after.revision > before.revision);
  assert.equal(
    after.values.find((item) => item.key === "gooseThinkingEffort")?.value,
    "high",
  );
  await assert.rejects(
    client.request(ext("preferences/save"), {
      expectedRevision: before.revision,
      values: [{ key: "gooseThinkingEffort", value: "low" }],
    }),
    (error) => error.data?.code === "preference_revision_conflict",
  );
  await client.request(ext("config/upsert"), {
    key: "CONTRACT_API_KEY",
    value: "secret-fixture-123",
    isSecret: true,
  });
  const all = await client.request(ext("config/read-all"));
  assert.ok(Array.isArray(all.blockedMutationKeys));
  assert.equal(JSON.stringify(all).includes("secret-fixture-123"), false);
});

test("session rename, archive, search and provider removal preserve readable restart history", async (t) => {
  const fixture = await setup(t);
  const { client, dataDir } = fixture;
  const providerId = await configure(client);
  const sessionId = await newSession(client, dataDir);
  await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Persist history fixture" }],
  });
  await client.request(ext("session/rename"), {
    sessionId,
    title: "Named history fixture",
  });
  assert.equal(
    (
      await client.request("session/list", {
        _meta: { query: "named history" },
      })
    ).sessions.length,
    1,
  );
  assert.equal(
    (
      await client.request("session/list", {
        _meta: { query: "absent phrase" },
      })
    ).sessions.length,
    0,
  );
  await client.request(ext("session/archive"), { sessionId });
  assert.equal((await client.request("session/list")).sessions.length, 0);
  await client.request(ext("session/unarchive"), { sessionId });
  const refreshed = zRefreshProviderInventoryResponse_unstable.parse(
    await client.request(ext("providers/inventory/refresh"), {
      providerIds: [providerId],
    }),
  );
  assert.deepEqual(refreshed.started, [providerId]);
  zCustomProviderDeleteResponse_unstable.parse(
    await client.request(ext("providers/custom/delete"), { providerId }),
  );
  assert.deepEqual(await client.request(ext("defaults/read")), {
    providerId: null,
    modelId: null,
  });
  const reopened = await fixture.restart();
  const info = await reopened.request(ext("session/info"), { sessionId });
  assert.equal(info.session.title, "Named history fixture");
  assert.equal(info.session._meta.userSetName, true);
  await reopened.request("session/load", {
    sessionId,
    cwd: dataDir,
    mcpServers: [],
  });
  assert.ok(
    updates(reopened, sessionId).some(
      (update) => update.content?.text === "Persist history fixture",
    ),
  );
  await assert.rejects(
    reopened.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Deleted provider must not execute" }],
    }),
  );
  await reopened.request("session/delete", { sessionId });
  assert.equal((await reopened.request("session/list")).sessions.length, 0);
});

test('native mode selection changes during a prompt without a second product approval decision', async t => {
  const started = Promise.withResolvers(), resume = Promise.withResolvers(), decisions = [];
  const driver = controlledDriver(async (_id, _content, { onToolPolicy }) => {
    started.resolve(); await resume.promise;
    decisions.push(await onToolPolicy({ id: 'native-read', name: 'read', arguments: {}, nativeCapability: true, readOnly: true }));
    return { stopReason: 'end_turn' };
  });
  const { client, dataDir } = await setup(t, driver); await configure(client);
  const sessionId = await newSession(client, dataDir);
  await client.request('session/set_mode', { sessionId, modeId: 'danger-full-access' });
  const pending = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Hold the native turn while I change permissions' }] });
  await started.promise;
  await client.request('session/set_mode', { sessionId, modeId: 'read-only' });
  resume.resolve(); await pending;
  assert.deepEqual(decisions, [{ kind: 'allow' }], 'The native capability enforces its own sandbox; the product does not reinterpret readonly as chat-only');
  assert.equal((await client.request('session/load', { sessionId, cwd: dataDir, mcpServers: [] })).modes.currentModeId, 'read-only');
  assert.equal(client.notifications.filter(message => message.method === 'session/request_permission').length, 0);
});

async function confirmedPermissionSession(client, dataDir) {
  const cwd = path.join(dataDir, 'permission-project');
  const lease = await client.request(ext('workspace/lease/acquire'), {
    requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd),
  });
  const response = await client.request('session/new', {
    cwd: lease.workingDir, mcpServers: [],
    _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, enabledExtensions: ['developer'] },
  });
  return response.sessionId;
}

test('all three native presets preserve explicit tool restrictions through the DSH policy seam', async t => {
  let call, decision;
  const driver = controlledDriver(async (_id, _content, { onToolPolicy }) => {
    decision = await onToolPolicy(call);
    return { stopReason: 'end_turn' };
  });
  const { client, dataDir } = await setup(t, driver); await configure(client);
  const sessionId = await confirmedPermissionSession(client, dataDir);
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    await client.request('session/set_mode', { sessionId, modeId: mode });
    for (const [permission, expected] of [['never_allow', 'deny'], ['ask_before', 'ask'], ['always_allow', 'allow']]) {
      call = { id: mode + permission, name: 'write', arguments: {}, nativeCapability: true, sandboxMode: mode };
      await client.request(ext('tools/permissions/set'), { toolPermissions: [{ toolName: 'write', permission }] });
      await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Controlled tool policy observation' }] });
      assert.equal(decision.kind, expected);
    }
  }
  assert.equal(client.notifications.filter(message => message.method === 'session/request_permission').length, 0, 'Policy proposals alone never synthesize approval requests; DSH owns the ask');
});

test('all six native mode transitions round-trip the execution owner selection', async t => {
  const { client, dataDir } = await setup(t); await configure(client);
  const sessionId = await confirmedPermissionSession(client, dataDir);
  for (const from of ['read-only', 'workspace-write', 'danger-full-access']) {
    for (const to of ['read-only', 'workspace-write', 'danger-full-access']) {
      if (from === to) continue;
      await client.request('session/set_mode', { sessionId, modeId: from });
      await client.request('session/set_mode', { sessionId, modeId: to });
      const response = await client.request('session/load', { sessionId, cwd: dataDir, mcpServers: [] });
      assert.equal(response.modes.currentModeId, to);
    }
  }
});

test('internal delegation receipts stay out of main chat live and on replay', async t => {
  const driver=controlledDriver(async(_id,_content,{onEvent,onToolPolicy})=>{
    for(const [i,name] of ['subagent','send_message','list_agents','interrupt_agent'].entries()) {
      assert.equal((await onToolPolicy({id:`internal-${i}`,name,arguments:{},delegationControl:true})).kind,'allow');
      await onEvent({type:'tool_call',id:`internal-${i}`,name,arguments:{},internalControl:true});
      // Validation failures may lack receipt metadata; the call identity still hides the result.
      await onEvent({type:'tool_result',id:`internal-${i}`,result:[{type:'text',text:'Internal receipt'}],isError:false});
    }
    await onEvent({type:'tool_call',id:'ordinary',name:'send_message',arguments:{},internalControl:false});
    await onEvent({type:'tool_result',id:'ordinary',result:[{type:'text',text:'Ordinary registered tool'}],isError:false});
    await onEvent({type:'text_delta',text:'User-facing summary remains visible.'});
    return {stopReason:'end_turn'};
  });
  const {client,dataDir}=await setup(t,driver);await configure(client);
  const sessionId=await confirmedPermissionSession(client,dataDir);
  await client.request('session/prompt',{sessionId,prompt:[{type:'text',text:'Projection fixture'}]});
  const check=()=>{
    const transcript=updates(client,sessionId);
    assert.ok(!transcript.some(u=>u.toolCallId?.startsWith('internal-')));
    assert.ok(!transcript.some(u=>u.sessionUpdate==='status_message'&&u.status?.data?.tool_call_id?.startsWith('internal-')));
    assert.ok(transcript.some(u=>u.toolCallId==='ordinary'&&u.sessionUpdate==='tool_call'));
    assert.ok(transcript.some(u=>u.sessionUpdate==='agent_message_chunk'&&u.content.text.includes('User-facing summary')));
  };
  check();client.notifications.length=0;
  driver.callTool=async(_id,name,args,{onToolPolicy,onEvent})=>{
    assert.equal((await onToolPolicy({id:'internal-direct',name,arguments:args,readOnly:true})).kind,'allow');
    await onEvent({type:'tool_call',id:'internal-direct',name,arguments:args,internalControl:true});
    const result={content:[{type:'text',text:'Direct internal receipt'}],isError:false};
    await onEvent({type:'tool_result',id:'internal-direct',...result,result:result.content});
    return result;
  };
  await client.request(ext('tools/call'),{sessionId,name:'list_agents',arguments:{}});
  assert.ok(!updates(client,sessionId).some(u=>u.toolCallId==='internal-direct'));
  client.notifications.length=0;
  await client.request('session/load',{sessionId,cwd:dataDir,mcpServers:[]});check();
});

test('mode switching neither approves a pending question nor bypasses a later hard deny', async t => {
  const decisions = [];
  let turn = 0;
  const driver = controlledDriver(async (_id, _content, { onPermission, onToolPolicy }) => {
    const current = ++turn;
    decisions.push(await onPermission({ id: `pending-${current}`, name: 'write', arguments: {} }));
    if (current === 1) decisions.push((await onToolPolicy({ id: 'after-switch', name: 'write', arguments: {}, nativeCapability: true })).kind === 'allow');
    return { stopReason: 'end_turn' };
  });
  const { client, dataDir } = await setup(t, driver);
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  async function pendingTurn(mode) {
    const expectedId = `pending-${turn + 1}`;
    await client.request('session/set_mode', { sessionId, modeId: mode });
    const response = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Controlled pending approval' }] });
    const deadline = Date.now() + 3000;
    let question;
    while (!(question = client.notifications.find(message => message.method === 'session/request_permission' && message.params.toolCall.toolCallId === expectedId)) && Date.now() < deadline) await delay(5);
    assert.ok(question);
    return { response, question };
  }
  const first = await pendingTurn('workspace-write');
  await client.request('session/set_mode', { sessionId, modeId: 'danger-full-access' });
  assert.deepEqual(decisions, [], 'Changing mode must not answer an outstanding question');
  client.reply(first.question.id, { outcome: { outcome: 'selected', optionId: 'reject_once' } });
  await first.response;
  assert.deepEqual(decisions, [false, true], 'The subsequent tool uses the new full-access mode');
  const second = await pendingTurn('workspace-write');
  await client.request('session/set_mode', { sessionId, modeId: 'read-only' });
  await client.request(ext('tools/permissions/set'), { toolPermissions: [{ toolName: 'write', permission: 'never_allow' }] });
  client.reply(second.question.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
  await second.response;
  assert.deepEqual(decisions, [false, true, false], 'A stale approval cannot bypass an explicit tool prohibition');
});

test("tool permission waits for the original ACP outcome and preserves post-tool message ordering", async (t) => {
  let accepted = false;
  const driver = controlledDriver(
    async (_sessionId, _content, { onPermission, onEvent }) => {
      onEvent({ type: "assistant_start", attemptId: "attempt-1" });
      onEvent({ type: "text_delta", text: "Before tool." });
      accepted = await onPermission({
        id: "approval-tool",
        name: "read_file",
        arguments: { path: "fixture.txt" },
      });
      if (accepted) {
        onEvent({
          type: "tool_call",
          id: "approval-tool",
          name: "read_file",
          arguments: { path: "fixture.txt" },
        });
        onEvent({
          type: "tool_result",
          id: "approval-tool",
          result: [{ type: "text", text: "Actual fixture result" }],
          isError: false,
        });
        onEvent({ type: "assistant_start", attemptId: "attempt-2" });
        onEvent({ type: "text_delta", text: "After tool." });
      }
      return { stopReason: "end_turn" };
    },
  );
  const { client, dataDir } = await setup(t, driver);
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  const prompt = client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Read the fixture" }],
  });
  const deadline = Date.now() + 4000;
  while (
    !client.notifications.some(
      (message) => message.method === "session/request_permission",
    ) &&
    Date.now() < deadline
  )
    await delay(5);
  const request = client.notifications.find(
    (message) => message.method === "session/request_permission",
  );
  assert.ok(request);
  assert.equal(request.params.sessionId, sessionId);
  assert.equal(request.params.toolCall.toolCallId, "approval-tool");
  assert.equal(accepted, false);
  client.reply(request.id, {
    outcome: { outcome: "selected", optionId: "allow_once" },
  });
  await prompt;
  assert.equal(accepted, true);
  const messages = updates(client, sessionId);
  const text = messages.filter(
    (message) => message.sessionUpdate === "agent_message_chunk",
  );
  assert.notEqual(text[0].messageId, text[1].messageId);
  assert.match(text[0].messageId, /^harness-stream:[0-9a-f-]{36}:attempt-1$/);
  const result = messages.find(
    (message) => message.sessionUpdate === "tool_call_update",
  );
  assert.equal(result.content[0].content.text, "Actual fixture result");
});

test("tool permission waits without a deadline and still needs explicit approval", async (t) => {
  let executed = false;
  const driver = controlledDriver(async (_id, _content, { onPermission }) => {
    const approved = await onPermission({
      id: "expiring-approval",
      name: "read_file",
      arguments: { path: "fixture.txt" },
    });
    if (approved) executed = true;
    return { stopReason: "end_turn" };
  });
  const { client, dataDir } = await setup(t, driver);
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  const prompt = client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Read fixture only after approval" }],
  });
  let settled = false;
  const outcome = prompt.then(
    (value) => { settled = true; return { value }; },
    (error) => { settled = true; return { error }; },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const deadline = Date.now() + 4000;
    while (
      !client.notifications.some(
        (message) => message.method === "session/request_permission",
      ) &&
      Date.now() < deadline
    )
      await delay(5);
    assert.ok(
      client.notifications.some(
        (message) => message.method === "session/request_permission",
      ),
    );
    t.mock.timers.tick(300_001);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(executed, false);
  } finally {
    t.mock.timers.reset();
  }
  const request = client.notifications.find(message => message.method === 'session/request_permission');
  client.reply(request.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
  const result = await outcome;
  assert.equal(result.error, undefined);
  assert.equal(executed, true);
});

test("shutdown cancels an active prompt and flushes its partial transcript before restart", async (t) => {
  let started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const driver = controlledDriver(
    async (_sessionId, _content, { onEvent, signal }) => {
      onEvent({ type: "text_delta", text: "Persist this partial answer" });
      started();
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      return { stopReason: "cancelled" };
    },
  );
  const fixture = await setup(t, driver);
  const { client, dataDir } = fixture;
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  const pending = client
    .request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Controlled shutdown fixture" }],
    })
    .catch(() => null);
  await began;
  const reopened = await fixture.restart();
  await pending;
  await reopened.request("session/load", {
    sessionId,
    cwd: dataDir,
    mcpServers: [],
  });
  assert.ok(
    updates(reopened, sessionId).some(
      (message) => message.content?.text === "Persist this partial answer",
    ),
  );
});

test("frozen renderer receives the source user before first assistant delta and deduplicates local acceptance", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const driver = controlledDriver(
    async (_sessionId, _content, { onEvent, signal }) => {
      onEvent({ type: "assistant_start", attemptId: "first-attempt" });
      onEvent({ type: "thinking_delta", text: "Thinking fixture" });
      onEvent({ type: "text_delta", text: "Answer fixture" });
      await Promise.race([
        gate,
        new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        ),
      ]);
      return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
    },
  );
  const { client, dataDir } = await setup(t, driver);
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  const sourceId = "zz-source-user";
  const prompt = client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Question fixture" }],
    _meta: { "codeagentpro/source-message-id": sourceId },
  });
  try {
    const deadline = Date.now() + 4000;
    while (
      !updates(client, sessionId).some(
        (update) => update.sessionUpdate === "agent_message_chunk",
      ) &&
      Date.now() < deadline
    )
      await delay(5);
    const createAdapter = await originalRendererAdapter();
    const adapter = createAdapter();
    const live = updates(client, sessionId);
    for (const update of live) adapter.apply({ sessionId, update });
    assert.equal(live[0].sessionUpdate, "user_message_chunk");
    assert.deepEqual(
      adapter.getMessages().map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(adapter.getMessages()[0].id, sourceId);
    assert.equal(
      adapter.getMessages()[0].created,
      adapter.getMessages()[1].created,
    );
    assert.equal(adapter.getMessages()[1].content[0].type, "thinking");
    // useChatSession.onAccepted checks this same source id before local insertion.
    assert.equal(
      adapter.getMessages().filter((message) => message.id === sourceId).length,
      1,
    );
    adapter.apply({ sessionId, update: live[0] });
    assert.equal(adapter.getMessages()[0].content[0].text, "Question fixture");
    assert.equal(adapter.getMessages().length, 2);
  } finally {
    release();
  }
  await prompt;
});

test("legacy saved transcripts replay in stored order without rewriting ids or timestamps", async () => {
  const sessionId = "legacy-session";
  const legacyUpdates = [
    {
      sessionUpdate: "user_message_chunk",
      messageId: "odplno3k",
      content: { type: "text", text: "Legacy question" },
      _meta: { goose: { messageId: "odplno3k", created: 1791964529 } },
    },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "harness-stream:legacy-session:1",
      content: { type: "text", text: "Legacy answer" },
      _meta: {
        goose: {
          messageId: "harness-stream:legacy-session:1",
          created: 1791964529,
        },
      },
    },
  ];
  const state = {
    providers: [],
    sessions: [{ id: sessionId, cwd: process.cwd(), updates: legacyUpdates }],
  };
  const before = JSON.stringify(state);
  const store = {
    read: () => structuredClone(state),
    update: () => {
      throw new Error("Replay must not mutate persisted history");
    },
  };
  const notifications = [];
  await new Compat(store, { permissions: permissionDriver() }).request(
    "session/load",
    { sessionId, cwd: process.cwd(), mcpServers: [] },
    { notify: (method, params) => notifications.push({ method, params }) },
  );
  assert.deepEqual(
    notifications.filter((event) => event.params.update.sessionUpdate !== 'session_info_update').map((event) => event.params.update),
    legacyUpdates,
  );
  assert.equal(JSON.stringify(state), before);
  const createAdapter = await originalRendererAdapter();
  const adapter = createAdapter();
  for (const event of notifications) adapter.apply(event.params);
  assert.deepEqual(
    adapter.getMessages().map((message) => [message.role, message.id]),
    [
      ["user", "odplno3k"],
      ["assistant", "harness-stream:legacy-session:1"],
    ],
  );
});

test("reused Harness attempt ids remain distinct across live turns and server restart in the frozen renderer", async (t) => {
  const driver = controlledDriver(async (_sessionId, content, { onEvent }) => {
    onEvent({ type: "assistant_start", attemptId: "same-session:1" });
    onEvent({ type: "thinking_delta", text: `Thinking ${content[0].text}` });
    onEvent({ type: "text_delta", text: `Answer ${content[0].text}` });
    onEvent({ type: "usage", inputTokens: 3, outputTokens: 2 });
    return { stopReason: "end_turn" };
  });
  const fixture = await setup(t, driver);
  const { client, dataDir } = fixture;
  await configure(client);
  const sessionId = await newSession(client, dataDir);
  for (const text of ["first", "second"])
    await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
      _meta: { "codeagentpro/source-message-id": `source-${text}` },
    });
  const createAdapter = await originalRendererAdapter();
  const liveAdapter = createAdapter();
  for (const event of client.notifications) {
    if (event.method === "session/update") liveAdapter.apply(event.params);
    if (event.method === ext("session/update"))
      liveAdapter.applyGoose(event.params);
  }
  const live = liveAdapter.getMessages();
  assert.deepEqual(
    live.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.notEqual(live[1].id, live[3].id);
  assert.match(live[1].id, /:same-session:1$/);
  assert.match(live[3].id, /:same-session:1$/);
  assert.equal(
    live[1].content.find((item) => item.type === "text").text,
    "Answer first",
  );
  assert.equal(
    live[3].content.find((item) => item.type === "text").text,
    "Answer second",
  );
  const reopened = await fixture.restart();
  await reopened.request("session/load", {
    sessionId,
    cwd: dataDir,
    mcpServers: [],
  });
  const replayAdapter = createAdapter();
  for (const event of reopened.notifications) {
    if (event.method === "session/update") replayAdapter.apply(event.params);
    if (event.method === ext("session/update"))
      replayAdapter.applyGoose(event.params, true);
  }
  assert.deepEqual(replayAdapter.getMessages(), live);
});

test("legacy cross-turn assistant collisions replay as separate messages with stable ids and matched usage without changing saved history", async () => {
  const sessionId = "legacy-collision-session";
  const assistantId = `harness-stream:${sessionId}:1`;
  const updates = ["first", "second"].flatMap((label, index) => {
    const created = 1791964529 + index * 400;
    return [
      {
        sessionUpdate: "user_message_chunk",
        messageId: `source-${label}`,
        content: { type: "text", text: `${label} question` },
        _meta: { goose: { messageId: `source-${label}`, created } },
      },
      ...["agent_thought_chunk", "agent_message_chunk"].map(
        (sessionUpdate) => ({
          sessionUpdate,
          messageId: assistantId,
          content: {
            type: "text",
            text: `${label} ${sessionUpdate === "agent_thought_chunk" ? "thought" : "answer"}`,
          },
          _meta: { goose: { messageId: assistantId, created } },
        }),
      ),
    ];
  });
  const state = {
    providers: [],
    sessions: [
      {
        id: sessionId,
        cwd: process.cwd(),
        updates,
        usageUpdates: [10, 20].map((inputTokens) => ({
          sessionUpdate: "message_usage",
          messageId: assistantId,
          usage: { inputTokens, outputTokens: 5 },
        })),
      },
    ],
  };
  const before = JSON.stringify(state);
  const compat = new Compat(
    {
      read: () => structuredClone(state),
      update: () => {
        throw new Error("Replay must not mutate persisted history");
      },
    },
    { permissions: permissionDriver() },
  );
  const replay = async () => {
    const notifications = [];
    await compat.request(
      "session/load",
      { sessionId },
      {
        notify: (method, params) => notifications.push({ method, params }),
      },
    );
    return notifications;
  };
  const notifications = await replay();
  assert.deepEqual(await replay(), notifications);
  assert.equal(JSON.stringify(state), before);
  const createAdapter = await originalRendererAdapter();
  const adapter = createAdapter();
  for (const event of notifications) {
    if (event.method === "session/update") adapter.apply(event.params);
    else adapter.applyGoose(event.params, true);
  }
  const messages = adapter.getMessages();
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(messages[1].id, assistantId);
  assert.match(messages[3].id, /^harness-replay:[0-9a-f]{64}$/);
  assert.equal(
    messages[1].content.find((item) => item.type === "text").text,
    "first answer",
  );
  assert.equal(
    messages[3].content.find((item) => item.type === "text").text,
    "second answer",
  );
  const usage = notifications.filter(
    (event) => event.method === ext("session/update"),
  );
  assert.deepEqual(
    usage.map((event) => [
      event.params.update.messageId,
      event.params.update.usage.inputTokens,
    ]),
    [
      [messages[1].id, 10],
      [messages[3].id, 20],
    ],
  );
  const replayedContent = notifications.filter(event => event.method === 'session/update' && event.params.update.sessionUpdate !== 'session_info_update');
  for (let index = 0; index < updates.length; index += 1) {
    const update = replayedContent[index].params.update;
    assert.equal(
      update._meta.goose.created,
      updates[index]._meta.goose.created,
    );
    assert.equal(update.messageId, update._meta.goose.messageId);
  }
  // A foreign transcript with incomplete usage has no reliable per-turn match.
  state.sessions[0].usageUpdates.pop();
  const ambiguous = await replay();
  assert.equal(
    ambiguous.filter((event) => event.method === ext("session/update")).length,
    0,
  );
});

test('canonical capacity resolves the selected model while inventory listing stays local', async t => {
  const {client}=await setup(t);
  const providerId=await configure(client);
  const result=await client.request(ext('providers/canonical-model-info'),{provider:providerId,model:'contract-model'});
  assert.equal(result.modelInfo.provider,providerId);
  assert.equal(result.modelInfo.model,'contract-model');
  assert.equal(result.modelInfo.contextLimit,262144);
  await client.request(ext('providers/config/save'),{providerId,fields:[{key:'contextWindow:contract-model',value:'65536'}]});
  assert.equal((await client.request(ext('providers/canonical-model-info'),{provider:providerId,model:'contract-model'})).modelInfo.contextLimit,65536);
  await assert.rejects(client.request(ext('providers/canonical-model-info'),{provider:providerId,model:'other-model'}),/Unknown model/);
});
