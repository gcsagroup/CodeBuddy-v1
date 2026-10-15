import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHarnessDriver } from "../runtime/harness/index.mjs";
import { builtinMcp } from "../runtime/builtin-extensions.mjs";

const root = await mkdtemp(
  path.resolve(".preview-evidence", "builtin-execution-"),
);
const cwd = path.join(root, "workspace");
await mkdir(cwd);
const driver = await createHarnessDriver({
  dataDir: path.join(root, "harness"),
  cwd,
});
const receipt = {
  root,
  startedAt: new Date().toISOString(),
  status: "running",
  calls: [],
};
try {
  const mcpServers = [];
  for (const name of ["qwen_computer", "computercontroller", "autovisualiser"])
    mcpServers.push(
      await builtinMcp({ type: "builtin", name }, { cwd, dataDir: root }),
    );
  await driver.createSession({
    sessionId: "toolbox-fixture",
    cwd,
    provider: {
      id: "unused-model",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "",
      protocol: "openai-completions",
    },
    model: "unused",
    options: { mcpServers },
  });
  assert.ok(
    driver
      .extensionStatus("toolbox-fixture")
      .every((s) => s.status === "ready"),
  );
  async function call(name, args) {
    const result = await driver.callTool("toolbox-fixture", name, args, {
      onPermission: () => true,
    });
    receipt.calls.push({
      name,
      isError: Boolean(result.isError),
      contentTypes: result.content?.map((c) => c.type),
    });
    assert.equal(Boolean(result.isError), false, JSON.stringify(result));
    return result;
  }
  // Read-only physical desktop discovery. No focus, mouse or keyboard action.
  const apps = await call("mcp__qwen_computer__list_apps", {});
  assert.ok(apps.content?.length);
  const document = path.join(cwd, "toolbox-fixture.docx");
  await call("mcp__computercontroller__docx_tool", {
    operation: "update_doc",
    path: document,
    content: "CODEBUDDY_TOOLBOX_DOCUMENT_OK",
  });
  assert.ok((await stat(document)).size > 0);
  const extracted = await call("mcp__computercontroller__docx_tool", {
    operation: "extract_text",
    path: document,
  });
  assert.match(JSON.stringify(extracted), /CODEBUDDY_TOOLBOX_DOCUMENT_OK/);
  await call("mcp__computercontroller__cache", { command: "list" });
  const chart = await call("mcp__autovisualiser__render_mermaid", {
    mermaid_code: "graph LR\n A[Money module] --> B[Invoice module]",
  });
  assert.ok(
    chart.content?.some((c) => c.type === "resource" || c.type === "text"),
  );
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  await driver.close();
  receipt.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(root, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  await writeFile(
    path.resolve(".preview-evidence", "builtin-execution-latest.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
}
