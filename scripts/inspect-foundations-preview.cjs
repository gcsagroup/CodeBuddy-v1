"use strict";
// Read-only evidence for the already running preview; no model request or UI state injection.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const { chromium } = require(
  require.resolve("playwright", { paths: [path.join(root, "ui")] }),
);

(async () => {
  const launch = JSON.parse(
    fs.readFileSync(path.join(root, ".preview-data/logs/preview/launch.json")),
  );
  assert.equal(launch.status, "running");
  assert.equal(launch.repoRoot, root);
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9387");
  try {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("http://localhost:"));
    assert.ok(page, "Current Electron renderer must be present");
    await page.getByText("欢迎使用 CodeBuddy", { exact: true }).waitFor();
    await page.locator("#dynamic-textarea:visible").first().waitFor();
    const session = await browser.newBrowserCDPSession();
    const processes = await session.send("SystemInfo.getProcessInfo");
    await session.detach();
    const state = JSON.parse(
      fs.readFileSync(path.join(root, ".preview-data/backend/state.json")),
    );
    const migrated = state.sessions.filter((item) => item.legacyHistory);
    assert.equal(
      migrated.length,
      616,
      "Imported empty histories must survive original UI startup cleanup",
    );
    assert.equal(state.schedules.length, 1);
    assert.equal(state.schedules[0].paused, true);
    assert.equal(state.schedules[0].tested, false);
    const reference = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          ".preview-evidence/real-codepro-ws8w7o/backend/state.json",
        ),
      ),
    );
    assert.deepEqual(state.defaults, reference.defaults);
    assert.deepEqual(
      state.providers.find((item) => item.id === state.defaults.providerId),
      reference.providers.find(
        (item) => item.id === reference.defaults.providerId,
      ),
    );
    const body = await page.locator("body").innerText();
    assert.ok(body.includes("欢迎使用 CodeBuddy"));
    assert.ok(!body.includes("无法在所选工作区中启动 CodePro"));
    assert.equal(launch.defaultWorkspaceRoot, "D:\\CodeBuddy-Workspace");
    assert.ok(fs.statSync(launch.defaultWorkspaceRoot).isDirectory());
    const files = [
      "runtime/server.mjs",
      "runtime/compat.mjs",
      "runtime/codepro.mjs",
      "runtime/harness/index.mjs",
      "runtime/recipe-execution.mjs",
      "runtime/git-extension.mjs",
      "ui/desktop/src/main.ts",
      "scripts/start-harness-preview.cjs",
    ];
    const sourceSha256 = Object.fromEntries(
      files.map((file) => [
        file,
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(root, file)))
          .digest("hex"),
      ]),
    );
    const receipt = {
      status: "passed",
      verifiedAt: new Date().toISOString(),
      title: await page.title(),
      url: page.url(),
      launch,
      electronProcesses: processes.processInfo.map((item) => ({
        pid: item.id,
        type: item.type,
      })),
      importedHistoriesRetained: migrated.length,
      importedSchedulesPaused: 1,
      existingKimiConfigurationPreserved: true,
      defaultWorkspaceRootExists: true,
      newTaskPageWithoutStartupError: true,
      sourceSha256,
      evidenceBoundary:
        "Current launch, visible original new-task page and persisted imported state; earlier task execution receipts are separate. This inspection submits no model requests.",
    };
    const evidence = path.join(root, ".preview-evidence");
    await page.screenshot({
      path: path.join(evidence, "foundations-preview.png"),
    });
    fs.writeFileSync(
      path.join(evidence, "foundations-preview.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
