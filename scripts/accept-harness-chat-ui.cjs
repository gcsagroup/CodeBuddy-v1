"use strict";
// Real renderer acceptance. Only this script's isolated profile/window is owned.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { startPreview } = require("./start-harness-preview.cjs");
const root = path.resolve(__dirname, "..");
const { chromium } = require(
  require.resolve("playwright", { paths: [path.join(root, "ui", "desktop")] }),
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 60000, label = "condition") {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw Error(`Timed out waiting for ${label}`);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

(async () => {
  const profile = fs.mkdtempSync(
    path.join(root, ".preview-evidence", "real-chat-ui-"),
  );
  const port = 9393;
  const receipt = {
    status: "running",
    startedAt: new Date().toISOString(),
    profile,
    devtoolsPort: port,
    type: "real Electron original renderer, saved provider, isolated profile, ordinary two-turn chat",
    pageErrors: [],
    consoleErrors: [],
    timing: [],
    frames: [],
    turns: [],
    screenshots: [],
  };
  const save = () =>
    fs.writeFileSync(
      path.join(profile, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
  const state = () =>
    JSON.parse(
      fs.readFileSync(path.join(profile, "backend", "state.json"), "utf8"),
    );
  let browser, page, activeLaunch, launchResult;
  async function shot(name) {
    const target = path.join(profile, `${name}.png`);
    await page.screenshot({ path: target });
    receipt.screenshots.push(target);
    save();
  }
  async function closeWindow() {
    await page.close();
    await browser.close();
    page = null;
    browser = null;
    const code = await Promise.race([
      activeLaunch,
      delay(30000).then(() => {
        throw Error("Owned launcher did not close");
      }),
    ]);
    assert.equal(code, 0);
    const ended = JSON.parse(
      fs.readFileSync(path.join(profile, "logs", "preview", "launch.json")),
    );
    const pids = [
      ended.runtimePid,
      ended.desktopPid,
      ...receipt.launch.electronProcesses.map((row) => row.id),
    ];
    await until(
      () => pids.every((pid) => !alive(pid)),
      12000,
      "owned processes to exit",
    );
    receipt.shutdown = {
      status: ended.status,
      stoppedAt: ended.stoppedAt,
      reapedPids: pids,
    };
    save();
  }
  try {
    // Read-only encrypted configuration copy; no schedules, history, memory, or credentials are logged.
    const source = JSON.parse(
      fs.readFileSync(
        path.join(root, ".preview-data", "backend", "state.json"),
        "utf8",
      ),
    );
    const provider = source.providers.find(
      (row) =>
        row.id === source.defaults.providerId ||
        row.providerId === source.defaults.providerId,
    );
    assert.ok(provider, "The saved default provider must exist");
    const { openStore } = await import("../runtime/store.mjs");
    const store = await openStore(path.join(profile, "backend"));
    await store.update((data) => {
      data.providers = [provider];
      data.defaults = source.defaults;
      data.preferences = source.preferences;
      data.extensions = source.extensions.filter((row) =>
        ["developer", "projectmemory", "git", "todo"].includes(
          row.extension?.name,
        ),
      );
    });
    receipt.configuration = {
      model: source.defaults.modelId,
      providerId: source.defaults.providerId,
      copiedExtensionNames: store
        .read()
        .extensions.map((row) => row.extension.name),
      excludesUserSchedulesAndHistory: true,
    };
    save();
    console.log(JSON.stringify({ status: "starting", profile, port }));
    activeLaunch = startPreview({
      dataDirectory: profile,
      env: {
        ...process.env,
        CODEBUDDY_PREVIEW_DEVTOOLS_PORT: String(port),
        CODEPRO_UNIFIED_MODE: "true",
        CODEBUDDY_WORKSPACE_ROOT: path.join(profile, "workspaces"),
      },
    });
    activeLaunch
      .then((code) => {
        launchResult = { code };
      })
      .catch((error) => {
        launchResult = { error: error.message };
      });
    await until(
      async () => {
        if (launchResult)
          throw Error(`Launcher ended: ${JSON.stringify(launchResult)}`);
        try {
          return (
            await fetch(`http://127.0.0.1:${port}/json/version`, {
              signal: AbortSignal.timeout(500),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      90000,
      "isolated CDP",
    );
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = await until(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((item) => item.url().startsWith("http://localhost:")),
      30000,
      "renderer",
    );
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => receipt.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        receipt.consoleErrors.push(message.text());
      const text = message.text();
      const start = text.indexOf("{");
      if (start < 0) return;
      try {
        const value = JSON.parse(text.slice(start));
        if (value.tag === "stream_timing")
          receipt.timing.push({ observedAt: Date.now(), ...value });
      } catch {}
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    // Store only event metadata and text lengths, never request headers/configuration.
    cdp.on("Network.webSocketFrameReceived", (event) => {
      try {
        const value = JSON.parse(event.response.payloadData);
        if (value.method !== "session/update") return;
        const update = value.params?.update;
        receipt.frames.push({
          at: Date.now(),
          sessionId: value.params?.sessionId,
          type: update?.sessionUpdate,
          textLength: update?.content?.text?.length,
          status: update?.status,
          meta: update?._meta,
        });
      } catch {}
    });
    const processCdp = await browser.newBrowserCDPSession();
    const processes = await processCdp.send("SystemInfo.getProcessInfo");
    await processCdp.detach();
    receipt.launch = {
      ...JSON.parse(
        fs.readFileSync(path.join(profile, "logs", "preview", "launch.json")),
      ),
      electronProcesses: processes.processInfo.map((row) => ({
        id: row.id,
        type: row.type,
      })),
    };
    await page.getByRole("button", { name: "新任务", exact: true }).waitFor();
    await page.getByRole("button", { name: "新任务", exact: true }).click();
    await shot("00-new-task-default-workspace");
    const prompts = [
      "你好",
      "请用三个自然段介绍你能如何帮助开发项目，每段两三句话。无需调用工具。",
    ];
    const { CodeProRuns } = await import("../runtime/codepro.mjs");
    for (let index = 0; index < prompts.length; index++) {
      await page.locator("#dynamic-textarea").fill(prompts[index]);
      const started = Date.now();
      const beforeRuns = state().codeproRuns?.length ?? 0;
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const current = await until(
        () => {
          const data = state();
          return data.sessions.find((row) => row.type === "code_pro");
        },
        15000,
        "persisted chat",
      );
      await page.waitForURL((url) => url.href.includes(current.id));
      const routeAt = Date.now();
      assert.ok(
        current.cwd.startsWith(path.join(profile, "workspaces") + path.sep),
        "Default workspace must be an isolated auto-created child",
      );
      let capturedStream = false;
      const run = await until(
        async () => {
          const submissionError = page.getByText(/^Submit error:/);
          if (await submissionError.count())
            throw Error(await submissionError.first().innerText());
          if (
            !capturedStream &&
            receipt.frames.filter(
              (row) => row.at >= started && row.type === "agent_message_chunk",
            ).length > 1
          ) {
            capturedStream = true;
            await shot(`0${index + 1}-streaming`);
          }
          const data = state();
          if ((data.codeproRuns?.length ?? 0) <= beforeRuns) return false;
          const row = data.codeproRuns.at(-1);
          const context = new CodeProRuns({ read: () => data }).context({
            sessionId: current.id,
            runId: row.runId,
          });
          if (["failed", "paused"].includes(context.state))
            throw Error(
              `Unexpected ordinary-chat terminal state: ${context.state}: ${context.lastReason}`,
            );
          return context.state === "completed" && !context.activeAttempt
            ? { row, context }
            : false;
        },
        120000,
        "completed chat turn",
      );
      await until(
        async () =>
          (await page
            .getByRole("button", { name: "停止", exact: true })
            .count()) === 0,
        30000,
        "composer to finish",
      );
      const settledSession = state().sessions.find(
        (row) => row.id === current.id,
      );
      const assistantUpdates = settledSession.updates.filter(
        (row) => row.sessionUpdate === "agent_message_chunk",
      );
      const messageId = assistantUpdates.at(-1)?.messageId;
      const expectedAnswer = assistantUpdates
        .filter((row) => row.messageId === messageId)
        .map((row) => row.content?.text ?? "")
        .join("");
      const normalizeVisible = (value) =>
        value
          .replace(/^\s*[-+*]\s+/gm, "")
          .replace(/[*_`#]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const expectedVisibleAnswer = normalizeVisible(expectedAnswer);
      assert.ok(expectedVisibleAnswer.length > 0);
      await until(
        async () =>
          normalizeVisible(await page.locator("body").innerText()).includes(
            expectedVisibleAnswer,
          ),
        20000,
        "all streamed text to finish rendering",
      );
      await delay(150);
      const finishedAt = Date.now();
      const chunks = receipt.frames.filter(
        (row) => row.at >= started && row.type === "agent_message_chunk",
      );
      receipt.timing = fs
        .readFileSync(receipt.launch.desktopLog, "utf8")
        .split(/\r?\n/)
        .flatMap((line) => {
          const offset = line.indexOf('{"tag":"stream_timing"');
          if (offset < 0) return [];
          try {
            return [JSON.parse(line.slice(offset))];
          } catch {
            return [];
          }
        });
      const commits = receipt.timing.filter(
        (row) => row.at_ms >= started && row.stage === "ui_text_committed",
      );
      receipt.turns.push({
        index: index + 1,
        prompt: prompts[index],
        sessionId: current.id,
        cwd: current.cwd,
        route: page.url(),
        sessionVisibleMs: routeAt - started,
        totalMs: finishedAt - started,
        firstChunkMs: chunks[0] ? chunks[0].at - started : null,
        chunkCount: chunks.length,
        renderedCommitCount: commits.length,
        chunks: chunks.map((row) => ({
          elapsedMs: row.at - started,
          textLength: row.textLength,
        })),
        completionKind: run.context.completionKind,
        state: run.context.state,
        executionOwner: run.context.executionOwner,
        nativeGoal: run.context.nativeGoal,
        fullVisibleAnswerMatched: true,
        fullAnswerLength: expectedAnswer.length,
        terminal: current.updates
          ?.filter((row) => row.update?.sessionUpdate === "turn_terminal")
          .at(-1),
      });
      assert.equal(run.context.completionKind, "harness_turn");
      assert.equal(run.context.executionOwner, "harness");
      assert.ok(chunks.length > 0, "ACP must stream assistant text");
      assert.equal(
        run.context.receipts.length,
        0,
        "Ordinary chat has no tool receipts",
      );
      assert.equal(
        run.context.tasks.length,
        0,
        "Ordinary chat has no synthetic task list",
      );
      assert.equal(
        run.context.nativeWorkers.length,
        0,
        "Ordinary chat has no worker execution",
      );
      const visibleTurn = await page.locator("body").innerText();
      assert.doesNotMatch(
        visibleTurn,
        /未运行动态验证/,
        "Ordinary chat must not display a validation report card",
      );
      assert.doesNotMatch(
        visibleTurn,
        /(?:已完成|已记录)\s*\d+\s*项操作/,
        "Ordinary chat must not display invented operation counters",
      );
      receipt.turns.at(-1).noSyntheticReportOrOperations = true;
      await shot(`0${index + 1}-turn-completed`);
      console.log(
        JSON.stringify({
          status: "turn_completed",
          ...receipt.turns.at(-1),
          chunks: undefined,
          terminal: undefined,
        }),
      );
    }
    assert.ok(
      receipt.turns[1].chunkCount > 1,
      "Longer second answer should have multiple actual text chunks",
    );
    assert.deepEqual(receipt.pageErrors, []);
    receipt.visibleBody = (await page.locator("body").innerText()).slice(
      -18000,
    );
    receipt.noDirectoryPickerRequired = true;
    await closeWindow();
    receipt.status = "passed";
  } catch (error) {
    receipt.status = "incomplete";
    receipt.error = error.message;
    if (page && !page.isClosed()) {
      receipt.visibleBody = (await page.locator("body").innerText()).slice(
        -18000,
      );
      await shot("failure").catch(() => {});
    }
  } finally {
    if (page && !page.isClosed())
      await closeWindow().catch((error) => {
        receipt.cleanupError = error.message;
      });
    receipt.finishedAt = new Date().toISOString();
    save();
    console.log(
      JSON.stringify({
        status: receipt.status,
        profile,
        error: receipt.error,
        cleanupError: receipt.cleanupError,
        pageErrors: receipt.pageErrors,
        consoleErrorCount: receipt.consoleErrors.length,
      }),
    );
    if (receipt.status !== "passed") process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
