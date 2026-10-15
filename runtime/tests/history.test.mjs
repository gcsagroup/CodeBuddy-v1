import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../ui/node_modules/esbuild/lib/main.js";
import {
  zExportSessionResponse_unstable,
  zImportSessionResponse_unstable,
} from "../../ui/sdk/src/generated/zod.gen.ts";
import { openStore } from "../store.mjs";
import { HistoryService } from "../history.mjs";
import { Compat } from "../compat.mjs";

const created = 1791950400;
const metadata = { agentVisible: true, userVisible: true };
const message = (id, role, content, extra = {}) => ({
  id,
  role,
  created,
  metadata,
  content,
  ...extra,
});
const conversation = [
  message("u1", "user", [
    { type: "text", text: "开发多个模块" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ]),
  message("a1", "assistant", [
    { type: "thinking", thinking: "规划模块边界", signature: "" },
    { type: "text", text: "开始读取" },
    {
      type: "toolRequest",
      id: "read-1",
      toolCall: {
        status: "success",
        value: { name: "read_file", arguments: { path: "src/main.ts" } },
      },
    },
  ]),
  message("r1", "user", [
    {
      type: "toolResponse",
      id: "read-1",
      toolResult: {
        status: "success",
        value: {
          content: [{ type: "text", text: "export const total = 42;" }],
          structuredContent: { bytes: 24 },
        },
      },
    },
  ]),
  message("a2", "assistant", [{ type: "text", text: "历史中的结果" }]),
];
const exported = (overrides = {}) => ({
  id: "old-unfinished",
  name: "旧开发任务",
  working_dir: "Z:\\offline-project",
  session_type: "code_pro",
  created_at: "2026-10-14T04:00:00Z",
  updated_at: "2026-10-14T04:01:00Z",
  conversation,
  ...overrides,
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codebuddy-history-"));
  const store = await openStore(directory);
  return { directory, store, service: new HistoryService(store) };
}
let adapterFactory;
async function renderer(session) {
  if (!adapterFactory) {
    const bundle = await build({
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
    });
    adapterFactory = (
      await import(
        "data:text/javascript;base64," +
          Buffer.from(bundle.outputFiles[0].text).toString("base64")
      )
    ).createAcpSessionNotificationAdapter;
  }
  const adapter = adapterFactory();
  const changes = session.updates.flatMap((update) =>
    adapter.apply({ sessionId: session.id, update }),
  );
  return { messages: adapter.getMessages(), changes };
}

test("legacy Goose JSON replays in the actual renderer while old execution and credentials stay inert", async () => {
  const { store, service, directory } = await fixture();
  const imported = await service.request("session/import", {
    source: "json",
    input: JSON.stringify(
      exported({
        provider_name: "legacy",
        model_config: { apiKey: "DO_NOT_IMPORT" },
        extension_data: {
          activeRunId: "old-run",
          credentials: "DO_NOT_IMPORT",
        },
        recipe: { command: "side effect" },
        permissions: { all: "always" },
        codeproRuns: [{ status: "running" }],
      }),
    ),
  });
  assert.equal(
    zImportSessionResponse_unstable.safeParse(imported).success,
    true,
  );
  const session = store.read().sessions[0];
  assert.equal(new Compat(store, {}).info(session)._meta.readonlyHistory, true);
  assert.notEqual(imported.sessionId, "old-unfinished");
  assert.equal(session.readonlyHistory, true);
  assert.equal(session.type, "code_pro");
  assert.equal(
    session.cwd,
    "Z:\\offline-project",
    "viewing an archive must not require a current or writable project",
  );
  assert.equal(JSON.stringify(session).includes("DO_NOT_IMPORT"), false);
  for (const key of [
    "providerId",
    "modelId",
    "enabledExtensions",
    "mcpServers",
    "permissions",
    "recipe",
    "codeproRuns",
  ])
    assert.equal(key in session, false);
  const replay = await renderer(session);
  assert.deepEqual(
    replay.messages.map((item) => item.id),
    ["u1", "a1", "r1", "a2"],
  );
  assert.deepEqual(replay.messages[0].content, conversation[0].content);
  assert.equal(replay.messages[1].content[0].thinking, "规划模块边界");
  assert.equal(
    replay.messages[1].content[2].toolCall.value.arguments.path,
    "src/main.ts",
  );
  assert.equal(
    replay.messages[2].content[0].toolResult.value.structuredContent.bytes,
    24,
  );
  assert.equal(
    replay.changes.some(
      (item) => item.type === "sessionInfo" || item.type === "notification",
    ),
    false,
  );
  const fresh = new HistoryService(await openStore(directory));
  const result = await fresh.request("session/export", {
    sessionId: imported.sessionId,
  });
  assert.equal(zExportSessionResponse_unstable.safeParse(result).success, true);
  assert.deepEqual(
    JSON.parse(result.data).conversation,
    conversation,
    "the original conversation survives restart and re-export",
  );
});

test("current streamed messages and structured tool results round-trip through the frontend contract", async () => {
  const { store, service } = await fixture();
  const now = "2026-10-14T04:00:00Z";
  const meta = (messageId) => ({ goose: { messageId, created } });
  const updates = [
    {
      sessionUpdate: "user_message_chunk",
      messageId: "u1",
      content: { type: "text", text: "run tests" },
      _meta: meta("u1"),
    },
    {
      sessionUpdate: "agent_thought_chunk",
      messageId: "a1",
      content: { type: "text", text: "check" },
      _meta: meta("a1"),
    },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "a1",
      content: { type: "text", text: "Testing " },
      _meta: meta("a1"),
    },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "a1",
      content: { type: "text", text: "now" },
      _meta: meta("a1"),
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "shell-1",
      title: "powershell",
      rawInput: { command: "node --test" },
      _meta: meta("a1"),
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "shell-1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "1 passed" } },
      ],
      rawOutput: { exitCode: 0, aborted: false },
      _meta: meta("r1"),
    },
  ];
  await store.update((state) =>
    state.sessions.push({
      id: "new-session",
      title: "测试",
      type: "user",
      cwd: directoryPlaceholder,
      createdAt: now,
      updatedAt: now,
      updates,
      providerId: "PRIVATE",
      enabledExtensions: [{ env: { TOKEN: "PRIVATE" } }],
    }),
  );
  const result = await service.request("session/export", {
    sessionId: "new-session",
  });
  assert.equal(result.data.includes("PRIVATE"), false);
  const value = JSON.parse(result.data);
  assert.equal(value.conversation.length, 3);
  assert.equal(value.conversation[1].content[1].text, "Testing now");
  const imported = await service.request("session/import", {
    source: "auto",
    input: result.data,
  });
  const replay = await renderer(
    store.read().sessions.find((item) => item.id === imported.sessionId),
  );
  assert.equal(
    replay.messages[2].content[0].toolResult.value.structuredContent.exitCode,
    0,
  );
  assert.equal(replay.messages[1].content[2].toolCall.value.name, "powershell");
});
const directoryPlaceholder = "C:\\fixture-project";

test("old approval, client action, and hidden messages do not become live UI controls", async () => {
  const { store, service } = await fixture();
  const contents = [
    message(
      "hidden",
      "assistant",
      [{ type: "text", text: "hidden old context" }],
      { metadata: { userVisible: false, agentVisible: true } },
    ),
    message("control", "assistant", [
      {
        type: "actionRequired",
        data: { id: "old-approval", toolName: "delete", arguments: {} },
      },
      {
        type: "frontendToolRequest",
        id: "old-client-tool",
        toolCall: { name: "computer_click" },
      },
    ]),
    message("unfinished", "assistant", [
      {
        type: "toolRequest",
        id: "no-result",
        toolCall: {
          status: "success",
          value: { name: "powershell", arguments: { command: "node --test" } },
        },
      },
    ]),
  ];
  await service.request("session/import", {
    input: JSON.stringify(exported({ conversation: contents })),
  });
  const session = store.read().sessions[0];
  assert.ok(
    session.updates.every((update) =>
      ["agent_message_chunk", "tool_call"].includes(update.sessionUpdate),
    ),
  );
  assert.equal(
    session.updates.at(-1).status,
    "pending",
    "an unfinished historical call has no completed execution receipt",
  );
  assert.equal(
    session.updates.some((update) =>
      update.content?.text.includes("hidden old context"),
    ),
    false,
  );
  const replay = await renderer(session);
  assert.equal(replay.messages.length, 2);
  assert.ok(replay.messages[0].content.every((block) => block.type === "text"));
  assert.equal(
    replay.changes.some((change) => change.type === "notification"),
    false,
  );
  assert.deepEqual(
    JSON.parse(
      (await service.request("session/export", { sessionId: session.id })).data,
    ).conversation,
    contents,
  );
});

test("invalid or network history inputs fail without partially inserting records", async () => {
  const { store, service } = await fixture();
  for (const input of [
    "{",
    "[]",
    "{}",
    JSON.stringify(exported({ conversation: [message("bad", "system", [])] })),
    JSON.stringify(
      exported({
        conversation: [message("bad", "user", [{ type: "text", text: 42 }])],
      }),
    ),
    " ".repeat(32 * 1024 * 1024) + "{}",
  ]) {
    await assert.rejects(
      service.request("session/import", { source: "json", input }),
      (error) => error.code === -32602,
    );
  }
  await assert.rejects(
    service.request("session/import", {
      source: "nostr",
      input: "nostr:fixture",
    }),
    (error) => error.code === -32601,
  );
  await assert.rejects(
    service.request("session/export", { sessionId: "missing" }),
    (error) => error.code === -32602,
  );
  assert.equal(store.read().sessions.length, 0);
});

test("explicit empty imported histories survive the frozen desktop startup placeholder cleanup contract", async () => {
  const { store, service } = await fixture();
  const imported = await service.request("session/import", {
    input: JSON.stringify(
      exported({
        conversation: [],
        name: "Retained empty history",
        session_type: "user",
      }),
    ),
  });
  const compat = new Compat(store, {});
  const info = compat.info(
    store.read().sessions.find((s) => s.id === imported.sessionId),
  );
  assert.equal(info._meta.messageCount, 0);
  assert.equal(
    info._meta.userSetName,
    true,
    "App startup only deletes unnamed empty placeholders; imported records are retained",
  );
  assert.equal(
    compat.info({ id: "placeholder", updates: [], messageCount: 0 })._meta
      .userSetName,
    false,
  );
  assert.deepEqual(
    JSON.parse(
      (
        await service.request("session/export", {
          sessionId: imported.sessionId,
        })
      ).data,
    ).conversation,
    [],
  );
});
