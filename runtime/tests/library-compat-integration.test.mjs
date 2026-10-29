import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCompatServer } from "../server.mjs";
import { permissionDriver } from './fixtures/permission-driver.mjs';
import { workspaceIdentity } from "../workspaces.mjs";
import { codeproInstructions } from "../task-tools.mjs";
import * as schemas from "../../ui/sdk/dist/generated/zod.gen.js";

const secret = "isolated-library-acp-test-secret";
const method = (name) => `_goose/unstable/${name}`;

async function connect(
  url,
  onRequest = async () => {
    throw new Error("Unexpected reverse ACP request");
  },
) {
  const socket = new WebSocket(
    `${url.replace(/^http/u, "ws")}/acp?token=${secret}`,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const notifications = [];
  const reverseRequests = [];
  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method && Object.hasOwn(message, "id")) {
      reverseRequests.push(message);
      try {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: await onRequest(message.method, message.params),
          }),
        );
      } catch (error) {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: error.message },
          }),
        );
      }
    } else if (pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error)
        waiter.reject(
          Object.assign(new Error(message.error.message), message.error),
        );
      else waiter.resolve(message.result);
    } else if (message.method) notifications.push(message);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("ACP closed"));
    }
    pending.clear();
  });
  return {
    notifications,
    reverseRequests,
    request(name, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP timed out: ${name}`));
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(
          JSON.stringify({ jsonrpc: "2.0", id, method: name, params }),
        );
      });
    },
    close() {
      socket.close();
    },
  };
}

async function fixture(
  t,
  { realHarness = false, onRequest, onModelRequest } = {},
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-library-acp-")),
  );
  const dataDir = path.join(root, "data");
  const modelRequests = [];
  const model = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ id: "library-model" }, { id: "recipe-model" }],
        }),
      );
      return;
    }
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    modelRequests.push(input);
    if (input.stream) await onModelRequest?.(input);
    if (!input.stream) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "library-completion", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: { role: "assistant", content: "Official Harness recipe execution complete." }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "library-completion", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const driver = {
    permissions: permissionDriver(),
    created: [],
    prompts: [],
    async createSession(input) {
      this.created.push(input);
      return { sessionId: input.sessionId };
    },
    async prompt(sessionId, content, options) {
      this.prompts.push({ sessionId, content });
      await options.onEvent({
        type: "text_delta",
        text: "Controlled contract driver result",
      });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
    async close() {},
    async refreshSkills() {},
  };
  const previousWorkspaceRoot = process.env.CODEBUDDY_WORKSPACE_ROOT;
  process.env.CODEBUDDY_WORKSPACE_ROOT = path.join(
    root,
    "scheduled-workspaces",
  );
  const app = await createCompatServer({
    dataDir,
    secret,
    ...(realHarness ? {} : { driver }),
  });
  const client = await connect(await app.listen(0, "127.0.0.1"), onRequest);
  t.after(async () => {
    client.close();
    await app.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    if (previousWorkspaceRoot === undefined)
      delete process.env.CODEBUDDY_WORKSPACE_ROOT;
    else process.env.CODEBUDDY_WORKSPACE_ROOT = previousWorkspaceRoot;
    assert.ok(path.basename(root).startsWith("codebuddy-library-acp-"));
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "library-contract", version: "1.0.0" },
    clientCapabilities: {
      _meta: {
        goose: { customNotifications: true, recipeParameterRequests: true },
      },
    },
  });
  const configured = await client.request(method("providers/custom/create"), {
    engine: "openai_compatible",
    displayName: "Isolated library provider",
    apiUrl: `http://127.0.0.1:${model.address().port}`,
    requiresAuth: false,
    models: ["library-model", "recipe-model"],
    supportsStreaming: true,
    headers: {},
  });
  await client.request(method("defaults/save"), {
    providerId: configured.providerId,
    modelId: "library-model",
  });
  return {
    root,
    dataDir,
    app,
    client,
    driver,
    modelRequests,
    providerId: configured.providerId,
  };
}

test('automatic follow-ups reuse the real Harness chat, model, context and ordinary session identity', async t => {
  const { client, root, modelRequests, dataDir } = await fixture(t, { realHarness: true });
  const session = await client.request('session/new', { cwd: root, mcpServers: [] });
  await client.request('session/prompt', { sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'Remember the marker PRIOR_CONTEXT_FOR_FOLLOWUP.' }] });
  const count = (await client.request('session/list')).sessions.length;
  const created = await client.request(method('schedules/create'), {
    id: 'follow-current', cron: '* * * * *', executionMode: 'current_session',
    targetSessionId: session.sessionId,
    recipe: { title: 'Check progress', description: '', prompt: 'Report the next milestone.' },
  });
  for (let i = 0; i < 2; i++) {
    const result = await client.request(method('schedules/run-now'), { scheduleId: created.job.id });
    assert.equal(result.sessionId, session.sessionId);
    assert.equal(result.status, 'completed');
  }
  const request = modelRequests.findLast(entry => entry.stream);
  assert.equal(request.model, 'library-model');
  assert.match(JSON.stringify(request.messages), /PRIOR_CONTEXT_FOR_FOLLOWUP/);
  assert.match(JSON.stringify(request.messages), /Report the next milestone/);
  assert.equal((await client.request('session/list')).sessions.length, count);
  const info = await client.request(method('session/info'), { sessionId: session.sessionId });
  assert.notEqual(info.session._meta.sessionType, 'scheduled');
  const state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(state.sessions.find(s => s.id === session.sessionId).scheduleId, undefined);
  assert.equal(state.schedules[0].attempts.length, 2);
  await client.request('session/delete', { sessionId: session.sessionId });
  const job = (await client.request(method('schedules/list'))).jobs[0];
  assert.equal(job.paused, true);
  assert.equal(job.tested, false);
  await assert.rejects(client.request(method('schedules/run-now'), { scheduleId: job.id }));
});

for (const workspaceMode of ["code", "codepro"])
test(`actual ACP recipe startup renders task instructions and parameters, selects model/tools and protects secrets (${workspaceMode})`, async (t) => {
  const context = await fixture(t, {
    onRequest: async (name, params) => {
      assert.equal(name, method("session/recipe/request-params"));
      schemas.zRequestRecipeParams_unstable.parse(params);
      return { action: "submit", values: { name: "Multi module" } };
    },
  });
  const recipe = {
    title: "Fixture recipe",
    description: "Render a real parameter request",
    prompt: "Build {{name}}",
    instructions: "Recipe instructions for {{name}}",
    parameters: [
      {
        key: "name",
        input_type: "string",
        requirement: "required",
        description: "Name",
      },
    ],
    settings: {
      goose_provider: context.providerId,
      goose_model: "recipe-model",
      temperature: 0.2,
      max_turns: 7,
    },
    extensions: [
      {
        type: "streamable_http",
        name: "private-fixture",
        uri: "http://127.0.0.1:${PORT}/mcp",
        envs: { PORT: "1", TOKEN: "isolated-recipe-extension-secret" },
        headers: { Authorization: "Bearer ${ TOKEN }" },
      },
    ],
  };
  const { deeplink } = await context.client.request(method("recipes/encode"), {
    recipe,
  });
  const cwd = workspaceMode === "codepro" ? path.join(context.root, "recipe-workspace") : context.root;
  const lease = workspaceMode === "codepro"
    ? await context.client.request(method("workspace/lease/acquire"), {
        requestedPath: cwd,
        expectedState: "missing",
        expectedIdentity: workspaceIdentity(cwd),
      })
    : null;
  const created = await context.client.request("session/new", {
    cwd,
    mcpServers: [],
    _meta: {
      workspaceMode,
      ...(lease ? { workspaceLeaseId: lease.leaseId } : {}),
      recipeDeeplink: deeplink,
      enabledExtensions: [{ type: "builtin", name: "developer" }],
    },
  });
  assert.equal(context.client.reverseRequests.length, 1);
  assert.equal(created._meta.recipe.prompt, "Build Multi module");
  assert.equal(created._meta.userRecipeValues.name, "Multi module");
  assert.equal(context.driver.created.length, 0);
  await context.client.request(method("tools/list"), {
    sessionId: created.sessionId,
  });
  const loaded = context.driver.created.find(
    (entry) => entry.sessionId === created.sessionId,
  );
  assert.equal(loaded.model, "recipe-model");
  assert.equal(loaded.options.temperature, 0.2);
  assert.equal(loaded.options.maxTurns, 7);
  assert.equal(loaded.options.mcpServers[0].url, "http://127.0.0.1:1/mcp");
  assert.match(
    loaded.options.systemPrompt,
    /## Current task instructions\nRecipe instructions for Multi module/u,
  );
  if (workspaceMode === "codepro") assert.ok(loaded.options.systemPrompt.includes(codeproInstructions));
  assert.equal(
    loaded.options.mcpServers[0].headers.Authorization,
    "Bearer isolated-recipe-extension-secret",
  );
  const persisted = await readFile(
    path.join(context.dataDir, "state.json"),
    "utf8",
  );
  assert.ok(
    !persisted.includes("isolated-recipe-extension-secret"),
    "Session recipe projections must not duplicate sealed extension secrets",
  );
  assert.ok(persisted.includes(process.platform === "darwin" ? "macos-keychain-aesgcm-v1" : "windows-dpapi"));
  assert.equal(
    (
      await context.client.request("session/prompt", {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: created._meta.recipe.prompt }],
      })
    ).stopReason,
    "end_turn",
  );
  assert.equal(context.driver.prompts.length, 1);
  const beforeReplay = context.client.notifications.length;
  const reloaded = await context.client.request("session/load", {
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  assert.equal(reloaded._meta.recipe.prompt, "Build Multi module");
  const replay = context.client.notifications.slice(beforeReplay).filter(n => n.method === 'session/update');
  assert.equal(replay[0].params.update._meta.goose.transcriptReplayStarted, true);
  assert.equal(replay[1].params.update.sessionUpdate, 'user_message_chunk');
  assert.equal(reloaded._meta.recipe.settings.max_turns, 7);
});

test("HTTP recipe environment reaches an actual MCP connection through official Harness without plaintext state", async (t) => {
  const expectedToken = "isolated-http-recipe-token";
  const observed = [];
  const mcp = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    observed.push({
      method: input.method,
      url: request.url,
      authorized: request.headers.authorization === `Bearer ${expectedToken}`,
    });
    if (!Object.hasOwn(input, "id")) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (input.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "recipe-http-env", version: "1" },
      };
    else if (input.method === "tools/list")
      result = {
        tools: [
          {
            name: "inspect",
            description: "Read isolated fixture status",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      };
    else if (input.method === "tools/call")
      result = {
        content: [{ type: "text", text: "Fixture HTTP connection accepted" }],
      };
    else {
      response.writeHead(400).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  await new Promise((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    mcp.closeAllConnections();
    await new Promise((resolve) => mcp.close(resolve));
  });
  const { client, root, dataDir, modelRequests } = await fixture(t, {
    realHarness: true,
    onRequest: async (name) => {
      assert.equal(name, "session/request_permission");
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    },
  });
  const { deeplink } = await client.request(method("recipes/encode"), {
    recipe: {
      title: "HTTP environment fixture",
      description: "Actual MCP header and URL interpolation",
      prompt: "Inspect the fixture.",
      settings: { max_turns: 3 },
      extensions: [
        {
          type: "streamable_http",
          name: "recipe-http-env",
          uri: "http://127.0.0.1:${MCP_PORT}/$ROUTE",
          envs: {
            MCP_PORT: String(mcp.address().port),
            ROUTE: "mcp",
            TOKEN: expectedToken,
          },
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      ],
    },
  });
  const { sessionId } = await client.request("session/new", {
    cwd: root,
    mcpServers: [],
    _meta: { workspaceMode: "code", recipeDeeplink: deeplink },
  });
  const tools = await client.request(method("tools/list"), {
    sessionId,
    extensionName: "recipe-http-env",
  });
  assert.ok(
    tools.tools.some((tool) => tool.name === "recipe-http-env__inspect"),
  );
  const called = schemas.zGooseToolCallResponse_unstable.parse(
    await client.request(method("tools/call"), {
      sessionId,
      name: "recipe-http-env__inspect",
      arguments: {},
    }),
  );
  assert.equal(called.isError, false);
  assert.ok(observed.some((entry) => entry.method === "tools/call"));
  assert.ok(
    observed.every((entry) => entry.authorized && entry.url === "/mcp"),
  );
  assert.ok(
    !(await readFile(path.join(dataDir, "state.json"), "utf8")).includes(
      expectedToken,
    ),
  );
  assert.equal(modelRequests.filter((request) => request.stream).length, 0);
});

test("original cancel reply does not create a session or invoke the driver", async (t) => {
  const { client, root, driver } = await fixture(t, {
    onRequest: async () => ({ action: "cancel" }),
  });
  const { id } = await client.request(method("recipes/save"), {
    recipe: {
      title: "Cancel fixture",
      description: "Cancelled recipe",
      prompt: "{{name}}",
      parameters: [
        {
          key: "name",
          input_type: "string",
          requirement: "required",
          description: "Name",
        },
      ],
    },
  });
  await assert.rejects(
    client.request("session/new", {
      cwd: root,
      mcpServers: [],
      _meta: { recipeId: id },
    }),
    (error) => error.data.reason === "recipe_params_cancelled",
  );
  assert.equal(driver.created.length, 0);
  assert.equal((await client.request("session/list")).sessions.length, 0);
});

for (const workspaceMode of ["code", "codepro"])
  test(`recipe form remains answerable past the permission and workspace deadlines (${workspaceMode})`, async (t) => {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    let answer;
    let arrived;
    const requested = new Promise((resolve) => {
      arrived = resolve;
    });
    const context = await fixture(t, {
      onRequest: async (name) => {
        assert.equal(name, method("session/recipe/request-params"));
        arrived();
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const cwd =
      workspaceMode === "codepro"
        ? path.join(context.root, "delayed-workspace")
        : context.root;
    const lease =
      workspaceMode === "codepro"
        ? await context.client.request(method("workspace/lease/acquire"), {
            requestedPath: cwd,
            expectedState: "missing",
            expectedIdentity: workspaceIdentity(cwd),
          })
        : null;
    const creation = context.client.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: {
        workspaceMode,
        ...(lease ? { workspaceLeaseId: lease.leaseId } : {}),
        recipe: {
          title: "Long parameter form",
          description: "Explicit human input",
          prompt: "Use {{name}}",
          parameters: [
            {
              key: "name",
              description: "Name",
              input_type: "string",
              requirement: "required",
            },
          ],
        },
      },
    });
    // The client's own transport watchdog is already a real timer. Advance only
    // timers subsequently installed by the server while it waits for the form.
    const outcome = creation.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await requested;
      clock += 300_001;
      t.mock.timers.tick(300_001);
      await new Promise(setImmediate);
    } finally {
      t.mock.timers.reset();
    }
    answer({
      action: "submit",
      values: { name: "user selected after five minutes" },
    });
    const result = await outcome;
    assert.ifError(result.error);
    assert.ok(result.value.sessionId);
    const loaded = await context.client.request("session/load", {
      sessionId: result.value.sessionId,
      cwd,
      mcpServers: [],
    });
    assert.ok(loaded);
    assert.equal(context.driver.prompts.length, 0);
  });

for (const update of [false, true])
test(`closing an unanswered recipe form leaves no session or model work (update: ${update})`, async (t) => {
  let arrived;
  const requested = new Promise((resolve) => {
    arrived = resolve;
  });
  const context = await fixture(t, {
    onRequest: async () => {
      arrived();
      return new Promise(() => {});
    },
  });
  const initialModelRequests = context.modelRequests.length;
  const cwd = path.join(context.root, "disconnected-form");
  const lease = await context.client.request(
    method("workspace/lease/acquire"),
    {
      requestedPath: cwd,
      expectedState: "missing",
      expectedIdentity: workspaceIdentity(cwd),
    },
  );
  const creation = context.client.request("session/new", {
    cwd,
    mcpServers: [],
    _meta: {
      workspaceMode: "codepro",
      workspaceLeaseId: lease.leaseId,
      recipe: {
        title: "Abandoned form",
        description: "Disconnect while asking",
        prompt: "Use {{name}}",
        parameters: [
          {
            key: "name",
            description: "Name",
            input_type: "string",
            requirement: "required",
          },
        ],
      },
    },
  });
  const rejected = assert.rejects(creation, /ACP closed/);
  await requested;
  if (!update) context.client.close();
  const closing = update ? context.app.closeForUpdate({ stopTasks: true }) : context.app.close();
  await rejected;
  await closing;
  assert.equal(context.driver.created.length, 0);
  assert.equal(context.modelRequests.length, initialModelRequests);
  const persisted = JSON.parse(
    await readFile(path.join(context.dataDir, "state.json"), "utf8"),
  );
  assert.equal(persisted.sessions.length, 0);
  await assert.rejects(readFile(cwd), (error) => error.code === "ENOENT");
});

test("cancelling a CodePro recipe reclaims only its empty new allocation", async (t) => {
  const context = await fixture(t, {
    onRequest: async () => ({ action: "cancel" }),
  });
  const cwd = path.join(context.root, "cancelled-form");
  const lease = await context.client.request(
    method("workspace/lease/acquire"),
    {
      requestedPath: cwd,
      expectedState: "missing",
      expectedIdentity: workspaceIdentity(cwd),
    },
  );
  await assert.rejects(
    context.client.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: {
        workspaceMode: "codepro",
        workspaceLeaseId: lease.leaseId,
        recipe: {
          title: "Cancel",
          description: "Cancel a live form",
          prompt: "Use {{name}}",
          parameters: [
            {
              key: "name",
              description: "Name",
              input_type: "string",
              requirement: "required",
            },
          ],
        },
      },
    }),
    (error) => error.data?.reason === "recipe_params_cancelled",
  );
  await assert.rejects(readFile(cwd), (error) => error.code === "ENOENT");
  assert.equal(
    (await context.client.request("session/list")).sessions.length,
    0,
  );
  assert.equal(context.driver.created.length, 0);
});

test("a workspace changed during recipe input is rejected without losing the new file", async (t) => {
  let cwd;
  const context = await fixture(t, {
    onRequest: async () => {
      await writeFile(path.join(cwd, "user.txt"), "Keep this external edit");
      return { action: "submit", values: { name: "project" } };
    },
  });
  cwd = path.join(context.root, "changed-during-form");
  const lease = await context.client.request(
    method("workspace/lease/acquire"),
    {
      requestedPath: cwd,
      expectedState: "missing",
      expectedIdentity: workspaceIdentity(cwd),
    },
  );
  await assert.rejects(
    context.client.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: {
        workspaceMode: "codepro",
        workspaceLeaseId: lease.leaseId,
        recipe: {
          title: "Changed workspace",
          description: "Recheck after human input",
          prompt: "Use {{name}}",
          parameters: [
            {
              key: "name",
              description: "Name",
              input_type: "string",
              requirement: "required",
            },
          ],
        },
      },
    }),
    /Workspace contents changed since confirmation/,
  );
  assert.equal(
    await readFile(path.join(cwd, "user.txt"), "utf8"),
    "Keep this external edit",
  );
  assert.equal(
    (await context.client.request("session/list")).sessions.length,
    0,
  );
  assert.equal(context.driver.created.length, 0);
});

test("native skill loads update toolbox usage without counting discovery, rejection or history replay", async (t) => {
  let allow = true;
  const { client, root } = await fixture(t, {
    realHarness: true,
    onRequest: async (name) => {
      assert.equal(name, "session/request_permission");
      return {
        outcome: {
          outcome: "selected",
          optionId: allow ? "allow_once" : "reject_once",
        },
      };
    },
  });
  await client.request(method("sources/create"), {
    type: "skill",
    name: "usage-proof",
    description: "Usage fixture",
    content: "Reply with the requested result without tools.",
    target: { scope: "global" },
  });
  const session = await client.request("session/new", {
    cwd: root,
    mcpServers: [],
  });
  const usage = async () =>
    (await client.request(method("capability-usage/list"))).records.filter(
      (r) => r.kind === "skill" && r.capabilityId === "usage-proof",
    );
  assert.deepEqual(await usage(), []);
  await client.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "/usage-proof Run this skill." }],
  });
  assert.equal(
    (await usage())[0]?.successCount,
    1,
    "official explicit invocation is counted once",
  );
  await client.request("session/load", {
    sessionId: session.sessionId,
    cwd: root,
    mcpServers: [],
  });
  assert.equal(
    (await usage())[0].successCount,
    1,
    "replay is not another skill load",
  );
  const result = await client.request(method("tools/call"), {
    sessionId: session.sessionId,
    name: "skill",
    arguments: { name: "usage-proof" },
  });
  assert.equal(result.isError, false);
  assert.equal(
    (await usage())[0].successCount,
    2,
    "official skill tool receipt is counted",
  );
  assert.equal((await usage())[0].recentResult, "instructions loaded");
  await client.request(method("tools/permissions/set"), { toolPermissions: [{ toolName: "developer__skill", permission: "never_allow" }] });
  allow = false;
  const denied = await client.request(method("tools/call"), {
    sessionId: session.sessionId,
    name: "skill",
    arguments: { name: "usage-proof" },
  });
  assert.equal(denied.isError, true);
  await client.request(method("tools/permissions/set"), { toolPermissions: [{ toolName: "developer__skill", permission: "ask_before" }] });
  allow = true;
  await client.request(method("tools/call"), {
    sessionId: session.sessionId,
    name: "skill",
    arguments: { name: "missing-skill" },
  });
  assert.equal(
    (await usage())[0].successCount,
    2,
    "denied and failed loads do not count",
  );
});

test("projectId source targets resolve the workspace owner and never fall back to global storage", async (t) => {
  const { client, root } = await fixture(t);
  const projectDir = path.join(root, "actual-project");
  await mkdir(projectDir);
  const project = await client.request(
    method("sources/create"),
    schemas.zCreateSourceRequest_unstable.parse({
      type: "project",
      name: "actual-project",
      description: "Fixture project",
      content: "",
      target: { scope: "global" },
      properties: { workingDirs: [projectDir] },
    }),
  );
  const sourceInput = {
    type: "skill",
    name: "project-skill",
    description: "Project workflow",
    content: "Use this project.",
    target: { scope: "projectId", projectId: project.source.name },
  };
  const created = schemas.zCreateSourceResponse_unstable.parse(
    await client.request(
      method("sources/create"),
      schemas.zCreateSourceRequest_unstable.parse(sourceInput),
    ),
  );
  assert.equal(created.source.global, false);
  assert.ok(
    created.source.path.startsWith(path.join(projectDir, ".agents", "skills")),
  );
  const exported = await client.request(method("sources/export"), {
    type: "skill",
    path: created.source.path,
    projectDir,
  });
  const imported = await client.request(method("sources/import"), {
    data: exported.json,
    target: { scope: "projectId", projectId: "actual-project" },
  });
  assert.equal(imported.sources[0].global, false);
  const agent = await client.request(method("sources/create"), {
    type: "agent",
    name: "Project reviewer",
    description: "Review project",
    content: "Check the project tests.",
    target: sourceInput.target,
  });
  assert.ok(
    agent.source.path.startsWith(path.join(projectDir, ".agents", "agents")),
  );
  await assert.rejects(
    client.request(method("sources/create"), {
      ...sourceInput,
      name: "missing-project-skill",
      target: { scope: "projectId", projectId: "missing" },
    }),
    /Project source was not found/u,
  );
  assert.equal(
    (await client.request(method("sources/list"), { type: "skill" })).sources
      .length,
    0,
  );
  await client.request(method("sources/create"), {
    type: "project",
    name: "ambiguous-project",
    description: "Multiple folders",
    content: "",
    target: { scope: "global" },
    properties: { workingDirs: [root, projectDir] },
  });
  await assert.rejects(
    client.request(method("sources/create"), {
      ...sourceInput,
      name: "ambiguous-skill",
      target: { scope: "projectId", projectId: "ambiguous-project" },
    }),
    /Choose a directory/u,
  );
});

for (const workspaceMode of ["code", "codepro"])
  test(`concurrent background schedules deliver each update once without forwarding to each other (${workspaceMode})`, async (t) => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted;
    const started = new Promise((resolve) => {
      firstStarted = resolve;
    });
    let requests = 0;
    const { client } = await fixture(t, {
      realHarness: true,
      onModelRequest: async () => {
        if (++requests === 1) {
          firstStarted();
          await firstGate;
        } else releaseFirst();
      },
    });
    for (const id of ["concurrent-a", "concurrent-b"])
      await client.request(method("schedules/create"), {
        id,
        cron: "0 0 14 * * *",
        paused: true,
        workspaceMode,
        recipe: {
          title: id,
          description: "Concurrent fixture",
          prompt: "Reply with a short result",
        },
      });
    const first = client.request(method("schedules/run-now"), {
      scheduleId: "concurrent-a",
    });
    await started;
    const second = client
      .request(method("schedules/run-now"), { scheduleId: "concurrent-b" })
      .finally(() => releaseFirst());
    const results = await Promise.allSettled([first, second]);
    for (const result of results)
      assert.equal(result.status, "fulfilled", String(result.reason));
    for (const { value } of results) {
      assert.equal(value.status, "completed");
      const chunks = client.notifications.filter(
        (n) =>
          n.method === "session/update" &&
          n.params.sessionId === value.sessionId &&
          n.params.update.sessionUpdate === "agent_message_chunk",
      );
      assert.equal(chunks.length, 1);
    }
  });

for (const workspaceMode of ["code", "codepro"])
  test(`scheduler run-now reaches the official Harness prompt path and records one persisted completed session (${workspaceMode})`, async (t) => {
    const { client, dataDir, modelRequests } = await fixture(t, {
      realHarness: true,
    });
    const created = schemas.zCreateScheduleResponse_unstable.parse(
      await client.request(method("schedules/create"), {
        id: "Harness scheduled recipe",
        cron: "0 0 14 * * *",
        paused: true,
        tested: false,
        workspaceMode,
        recipe: {
          title: "Harness schedule",
          description: "Real official Harness loop",
          instructions: "Use the isolated Harness recipe fixture.",
          prompt: "Scheduled {{name}}",
          parameters: [
            {
              key: "name",
              input_type: "string",
              requirement: "optional",
              description: "Name",
              default: "library fixture",
            },
          ],
          settings: { goose_model: "recipe-model", temperature: 0.4 },
        },
      }),
    );
    const result = schemas.zRunScheduleNowResponse_unstable.parse(
      await client.request(method("schedules/run-now"), {
        scheduleId: created.job.id,
      }),
    );
    assert.equal(result.status, "completed");
    assert.ok(result.sessionId);
    const actual = modelRequests.findLast((entry) => entry.stream);
    assert.equal(actual.model, "recipe-model");
    assert.equal(actual.temperature, 0.4);
    assert.match(JSON.stringify(actual.messages), /Scheduled library fixture/u);
    assert.match(
      JSON.stringify(actual.messages),
      /isolated Harness recipe fixture/u,
    );
    assert.ok(actual.tools.some((tool) => tool.function.name === "search_mcp_tools"));
    const rows = (await client.request(method("schedules/list"))).jobs;
    assert.equal(rows[0].tested, true);
    assert.equal(rows[0].paused, true);
    const history = schemas.zListScheduleSessionsResponse_unstable.parse(
      await client.request(method("schedules/sessions/list"), {
        scheduleId: created.job.id,
        limit: 10,
      }),
    );
    assert.equal(history.sessions[0].sessionId, result.sessionId);
    assert.equal(history.sessions[0]._meta.sessionType, "scheduled");
    const loadedInfo = await client.request(method("session/info"), {
      sessionId: result.sessionId,
    });
    assert.equal(loadedInfo.session._meta.sessionType, "scheduled");
    const state = JSON.parse(
      await readFile(path.join(dataDir, "state.json"), "utf8"),
    );
    assert.equal(state.schedules[0].attempts[0].status, "completed");
    assert.equal(state.schedules[0].attempts[0].sessionId, result.sessionId);
    assert.equal(
      state.sessions.filter((session) => session.id === result.sessionId)
        .length,
      1,
    );
    assert.equal(
      state.sessions.find((session) => session.id === result.sessionId)
        .scheduleId,
      created.job.id,
    );
    assert.equal(
      state.sessions.find((session) => session.id === result.sessionId).type,
      workspaceMode === "codepro" ? "code_pro" : "user",
    );
    await client.request("session/delete", { sessionId: result.sessionId });
    const afterDeletion = await client.request(
      method("schedules/sessions/list"),
      { scheduleId: created.job.id, limit: 10 },
    );
    assert.deepEqual(afterDeletion.sessions, []);
    const nextRun = await client.request(method("schedules/run-now"), {
      scheduleId: created.job.id,
    });
    const remainingHistory = await client.request(
      method("schedules/sessions/list"),
      { scheduleId: created.job.id, limit: 10 },
    );
    assert.deepEqual(
      remainingHistory.sessions.map((session) => session.sessionId),
      [nextRun.sessionId],
    );
    await client.request(method("schedules/delete"), {
      scheduleId: created.job.id,
    });
    const retainedInfo = await client.request(method("session/info"), {
      sessionId: nextRun.sessionId,
    });
    assert.equal(retainedInfo.session._meta.sessionType, "scheduled");
  });
