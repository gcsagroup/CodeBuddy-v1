import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHarnessDriver } from "../harness/index.mjs";
import { Compat } from "../compat.mjs";
import { openStore } from "../store.mjs";
import { harnessMcpServer } from "../session-extensions.mjs";

test(
  "custom HTTP and stdio modules share one grant and invalidate only affected configuration",
  { timeout: 30000 },
  async () => {
    const directory = tmpdir();
    const root = await mkdtemp(join(directory, "fixture-"));
    const toolNames = ["search", "read_detail", "write_note"];
    function resultFor(message) {
      if (message.method === "initialize")
        return {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "custom-module-fixture", version: "1" },
        };
      if (message.method === "tools/list")
        return {
          tools: toolNames.map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
          })),
        };
      return {
        content: [
          { type: "text", text: "Isolated receipt, no external side effect" },
        ],
      };
    }
    const http = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
    if (replyToNoActionReview(message, res)) return;
      if (!("id" in message)) {
        res.writeHead(202).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: resultFor(message),
          }),
        );
    });
    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    const script = join(root, "stdio.mjs");
    await writeFile(
      script,
      `import {createInterface} from 'node:readline';
const toolNames=${JSON.stringify(toolNames)};
${resultFor.toString()}
createInterface({input:process.stdin}).on('line', line=>{const msg=JSON.parse(line); if('id' in msg) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:resultFor(msg)})+'\\n')});`,
    );
    const driver = await createHarnessDriver({
      dataDir: join(root, "native"),
      cwd: root,
    });
    const store = await openStore(join(root, "host"));
    const host = new Compat(store, driver);
    const liveCalls = [];
    try {
      for (const transport of ["http", "stdio"]) {
        const name = "custom_" + transport;
        const server = {
          name,
          ...(transport === "http"
            ? {
                type: "http",
                url: `http://127.0.0.1:${http.address().port}/mcp`,
                headers: [],
              }
            : { command: process.execPath, args: [script], env: [] }),
        };
        const extension = { type: "mcp", server };
        const config = await harnessMcpServer(extension, { config: {} }, root);
        const s = { id: randomUUID(), cwd: root, mcpServers: [server] };
        await store.update((state) => {
          state.sessions.push(s);
          state.extensions.push({ configKey: name, enabled: true, extension });
          state.extensions.push({
            configKey: name + "_unrelated",
            enabled: false,
            extension: { type: "platform", name: name + "_unrelated" },
          });
        });
        await driver.createSession({
          sessionId: s.id,
          cwd: root,
          provider: {
            id: "offline",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "fixture",
          },
          model: "offline",
          options: { mcpServers: [config] },
        });
        const questions = [],
          contexts = [],
          observations = [];
        const invoke = async (rawName) => {
          const result = await driver.callTool(
            s.id,
            `mcp__${name}__${rawName}`,
            {},
            {
              onToolPolicy: (call) => {
                contexts.push(call);
                return host.toolPolicy(s, call, call.signal);
              },
              onPermission: (call) =>
                host.approveTool(
                  s,
                  call,
                  {
                    async ask(method, params) {
                      questions.push({
                        title: params.toolCall.title,
                        meta: params._meta,
                        options: params.options,
                      });
                      return {
                        outcome: {
                          outcome: "selected",
                          optionId: "allow_always",
                        },
                      };
                    },
                  },
                  call.signal,
                ),
            },
          );
          assert.equal(result.isError, false, JSON.stringify(result));
          observations.push({ tool: rawName, totalPrompts: questions.length });
        };
        for (const rawName of [
          "search",
          "search",
          "read_detail",
          "read_detail",
          "write_note",
          "write_note",
        ])
          await invoke(rawName);
        assert.deepEqual(
          observations.map((item) => item.totalPrompts),
          [1, 1, 1, 1, 1, 1],
        );
        const binding = contexts.at(-1).sessionApproval;
        assert.equal(binding.isCurrent(), true);
        const beforeSettings = host.toolGrant(contexts.at(-1)).allowed;
        await host.settings.request("config/extensions/set-enabled", {
          configKey: name + "_unrelated",
          enabled: true,
        });
        const afterSettings = host.toolGrant(contexts.at(-1)).allowed;
        assert.equal(
          binding.isCurrent(),
          true,
          "Unrelated setting did not replace this live connection",
        );
        assert.equal(beforeSettings, true);
        assert.equal(
          afterSettings,
          true,
          "Unrelated settings retain a live module grant",
        );
        await invoke("write_note");
        assert.equal(questions.length, 1);
        await host.settings.request("config/prompts/reset", { name: "system" });
        await driver.configureSession(s.id, {
          systemPrompt: "Updated unrelated prompt",
          mcpServers: [config],
        });
        await invoke("read_detail");
        assert.equal(
          questions.length,
          1,
          "Prompt settings and session refresh retain consent",
        );
        assert.equal(
          questions[0].meta.codepro.authorizationGroup,
          "mcp_module",
        );
        assert.equal(questions[0].meta.codepro.authorizationModule.name, name);
        // Even if no turn happens between disable and re-enable, old consent and
        // pending responses must not revive. Invalidate the real matching registry.
        const old = contexts.at(-1).sessionApproval;
        await host.settings.request("config/extensions/set-enabled", {
          configKey: name,
          enabled: false,
        });
        assert.equal(old.isCurrent(), false);
        for (const call of liveCalls)
          assert.equal(
            host.toolGrant(call)?.allowed,
            true,
            "A different module keeps its live grant",
          );
        await host.settings.request("config/extensions/set-enabled", {
          configKey: name,
          enabled: true,
        });
        await invoke("write_note");
        assert.equal(
          questions.length,
          2,
          "Matching settings revoke only this module",
        );
        liveCalls.push(contexts.at(-1));
        const selected = await harnessMcpServer({ ...extension, available_tools: ['search'] }, { config: {} }, root);
        const restricted = await driver.createSession({ cwd: root, provider: { id: 'offline', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'offline', options: { mcpServers: [selected] } });
        const names = (await driver.listTools(restricted.sessionId)).map(tool => tool.name);
        assert.ok(names.includes(`mcp__${name}__search`));
        assert.ok(!names.includes(`mcp__${name}__read_detail`), 'Unselected tools must not enter the live registry');
        const discovered = await driver.callTool(restricted.sessionId, 'search_mcp_tools', { names: [`mcp__${name}__read_detail`, `mcp__${name}__search`] }, { onPermission: async () => true });
        assert.ok(discovered.value.tools.some(tool => tool.name === `mcp__${name}__search`));
        assert.ok(!discovered.value.tools.some(tool => tool.name === `mcp__${name}__read_detail`));
        assert.equal((await driver.callTool(restricted.sessionId, `mcp__${name}__read_detail`, {}, { onPermission: async () => true })).isError, true);
        assert.equal((await driver.callTool(restricted.sessionId, `mcp__${name}__search`, {}, { onPermission: async () => true })).isError, false);
        await driver.configureSession(restricted.sessionId, { mcpServers: [{ ...selected, deniedTools: [`mcp__${name}__search`] }] });
        assert.ok(!(await driver.listTools(restricted.sessionId)).some(tool => tool.name === `mcp__${name}__search`), 'Role/tool filters must still narrow the selected catalog');
      }
    } finally {
      await driver.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
  },
);
