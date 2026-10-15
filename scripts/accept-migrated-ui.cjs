"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "..");
const { chromium } = require(
  require.resolve("playwright", { paths: [path.join(root, "ui", "desktop")] }),
);
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9387");
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("http://localhost:"));
  assert.ok(page);
  page.setDefaultTimeout(20000);
  await page.bringToFront();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const action = process.argv[2] ?? "inspect";
  try {
    if (action === "history" || action === "verify")
      await page.getByRole("button", { name: "历史记录", exact: true }).click();
    if (action === "verify") {
      const dataDir = path.join(root, ".preview-data", "backend");
      const state = JSON.parse(
        fs.readFileSync(path.join(dataDir, "state.json")),
      );
      const { loadLegacyConversation } = await import(
        pathToFileURL(path.join(root, "runtime", "legacy-migration.mjs"))
      );
      const candidates = state.sessions
        .filter(
          (s) =>
            s.legacyHistory &&
            !s.archivedAt &&
            s.type === "code_pro" &&
            s.messageCount > 0 &&
            s.messageCount < 100,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const session = candidates[0];
      assert.ok(session);
      const history = await loadLegacyConversation(
        dataDir,
        session.legacyHistory,
      );
      const source = history.find(
        (m) =>
          m.role === "user" &&
          m.metadata?.userVisible !== false &&
          m.content.some((c) => c.type === "text" && c.text.trim()),
      );
      assert.ok(source);
      const text = source.content
        .find((c) => c.type === "text" && c.text.trim())
        .text.trim();
      await page
        .getByRole("button", { name: "导入会话", exact: true })
        .waitFor();
      await page.keyboard.press("Control+f");
      const input = page.getByRole("textbox").first();
      await input.fill(session.title);
      const heading = page.getByRole("heading", {
        name: session.title,
        exact: true,
      });
      await heading.first().click();
      await page.waitForURL((url) => url.href.includes(session.id));
      await page
        .getByText(text.slice(0, Math.min(50, text.length)), { exact: false })
        .first()
        .waitFor();
      assert.equal(
        await page.getByText("重新确认工作区", { exact: true }).count(),
        0,
      );
      const baseline = JSON.parse(
        fs.readFileSync(
          path.join(
            root,
            ".preview-evidence",
            "real-codepro-ws8w7o",
            "backend",
            "state.json",
          ),
        ),
      );
      assert.deepEqual(state.defaults, baseline.defaults);
      assert.deepEqual(
        state.providers.find((p) => p.id === state.defaults.providerId),
        baseline.providers.find((p) => p.id === baseline.defaults.providerId),
      );
      const receipt = {
        status: "passed",
        finishedAt: new Date().toISOString(),
        type: "actual Electron UI opens migrated readonly CodePro history without workspace reconfirmation",
        sessionId: session.id,
        messageCount: history.length,
        visibleOriginalText: true,
        currentModelPreserved: true,
        importedHistoryCount: state.sessions.filter((s) => s.legacyHistory)
          .length,
        errors,
      };
      assert.deepEqual(errors, []);
      fs.writeFileSync(
        path.join(root, ".preview-evidence", "migrated-history-ui.json"),
        JSON.stringify(receipt, null, 2),
      );
      console.log(JSON.stringify(receipt));
      await page.screenshot({
        path: path.join(root, ".preview-evidence", "migrated-history-ui.png"),
      });
    }
    if (action === "new")
      await page.getByRole("button", { name: "新任务", exact: true }).click();
    console.log(
      JSON.stringify({
        url: page.url(),
        inputs: await page
          .getByRole("textbox")
          .evaluateAll((nodes) =>
            nodes.map((n) => ({
              placeholder: n.getAttribute("placeholder"),
              id: n.id,
            })),
          ),
        visibleButtons: await page.getByRole("button").evaluateAll((nodes) =>
          nodes
            .filter(
              (n) =>
                n.getBoundingClientRect().width &&
                n.getBoundingClientRect().height,
            )
            .map((n) => n.getAttribute("aria-label") || n.innerText)
            .slice(-30),
        ),
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
