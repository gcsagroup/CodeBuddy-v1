"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
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
  page.setDefaultTimeout(20000);
  await page.bringToFront();
  const receiptPath = path.join(
    root,
    ".preview-evidence",
    "real-codepro-ui.json",
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const action = process.argv[2] || "inspect";
    if (action === "start") {
      assert.ok(
        page.url().includes("/codepro"),
        "Latest CodePro UI must be the startup route",
      );
      await page.getByRole("button", { name: "新任务", exact: true }).click();
      const prompt = `在此自动创建的独立工作区做一个很小的真实开发验收。创建 hello.mjs 导出 add(a,b)，创建 hello.test.mjs 使用 node:test 覆盖正数、负数和零，然后通过 pwsh 执行 & '${process.execPath}' --test hello.test.mjs。只操作当前工作区，不安装依赖、不联网、不操作 Git、不创建子 Agent。请用 codebuddy_task 规划 implementation 与 verification 两个步骤，先 start_task 再执行工具，用 inspect 中真实 evidenceIds 提交 task_result，测试通过后 propose_finish。最后回复 CODEPRO_UI_REAL_TOOLS_OK。所有文件和命令操作将由我逐项批准。`;
      await page.locator("#dynamic-textarea").fill(prompt);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      fs.writeFileSync(
        receiptPath,
        JSON.stringify(
          {
            status: "running",
            startedAt: new Date().toISOString(),
            model: "kimi-k3",
            type: "real Electron CodePro UI -> ACP -> official Harness -> configured provider and native tools",
            approvals: [],
            errors,
          },
          null,
          2,
        ),
      );
    } else if (action === "approve") {
      const label = process.argv[3];
      assert.ok(label, "Use an observed approval button label");
      await page.getByRole("button", { name: label, exact: true }).click();
      const receipt = JSON.parse(fs.readFileSync(receiptPath));
      receipt.approvals.push({ at: new Date().toISOString(), label });
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    } else if (action === "close") {
      await page.close();
      return;
    } else if (action === "verify") {
      const state = JSON.parse(
        fs.readFileSync(
          path.join(root, ".preview-data", "backend", "state.json"),
        ),
      );
      const session = state.sessions.findLast(
        (s) => s.type === "code_pro" && s.title.includes("独立工作区"),
      );
      assert.ok(session);
      const run = state.codeproRuns.findLast((r) => r.sessionId === session.id);
      assert.ok(run.events.some((e) => e.eventType === "run_completed"));
      const { spawnSync } = require("node:child_process");
      const result = spawnSync(process.execPath, ["--test", "hello.test.mjs"], {
        cwd: session.cwd,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const receipt = JSON.parse(fs.readFileSync(receiptPath));
      Object.assign(receipt, {
        status: "passed",
        finishedAt: new Date().toISOString(),
        sessionId: session.id,
        cwd: session.cwd,
        independentTestsExit: result.status,
        testsOutput: result.stdout,
        runId: run.runId,
        errors,
      });
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
      console.log(JSON.stringify(receipt));
    }
    console.log((await page.locator("body").innerText()).slice(-13000));
    console.log(
      JSON.stringify(
        await page
          .getByRole("button")
          .evaluateAll((nodes) =>
            nodes
              .filter(
                (n) =>
                  n.getBoundingClientRect().width &&
                  n.getBoundingClientRect().height,
              )
              .map((n) => ({
                name: n.getAttribute("aria-label"),
                text: n.innerText.slice(0, 110),
              })),
          ),
      ),
    );
    await page.screenshot({
      path: path.join(root, ".preview-evidence", "real-codepro-ui-current.png"),
    });
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
