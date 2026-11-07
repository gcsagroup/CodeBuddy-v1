"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { startPreview } = require("./start-harness-preview.cjs");
const root = path.resolve(__dirname, "..");
const legacyControlPanel = process.argv.includes("--legacy-control-panel");
const { chromium } = require(
  require.resolve("playwright", { paths: [path.join(root, "ui", "desktop")] }),
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
async function until(check, timeout = 45000, description = "condition") {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(150);
  }
  throw Error(`Timed out waiting for ${description}`);
}
function lastGoal(body) {
  for (const message of [...body.messages].reverse()) {
    if (message.role !== "tool") continue;
    try {
      const value = JSON.parse(
        typeof message.content === "string"
          ? message.content
          : message.content.map((item) => item.text ?? "").join(""),
      );
      if (value.goal?.id) return value.goal;
    } catch {}
  }
  throw Error("Expected official Harness native goal result");
}

(async () => {
  const profile = fs.mkdtempSync(
    path.join(root, ".preview-evidence", "controlled-ui-resume-"),
  );
  const { openStore } = await import("../runtime/store.mjs");
  const { saveProvider } = await import("../runtime/providers.mjs");
  const { CodeProRuns } = await import("../runtime/codepro.mjs");
  const receipt = {
    status: "running",
    startedAt: new Date().toISOString(),
    profile,
    devtoolsPort: 9393,
    type: "real Electron stop, restart, same-chat continue; controlled loopback model, official Harness goal/todo/native tools",
    controlSurface: legacyControlPanel
      ? "legacy pause/resume panel"
      : "current composer stop and subsequent continue prompt",
    pageErrors: [],
    consoleErrors: [],
    routes: [],
    actions: [],
    launches: [],
    models: [],
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
  const session = () => state().sessions.find((row) => row.type === "code_pro");
  const facts = () => {
    const data = state(),
      s = data.sessions.find((row) => row.type === "code_pro"),
      run = data.codeproRuns.find((row) => row.sessionId === s.id);
    return {
      run,
      context: new CodeProRuns({ read: () => data }).context({
        sessionId: s.id,
        runId: run.runId,
      }),
    };
  };
  const scriptSteps = { initial: 0, resumed: 0 };
  let checkpointReady = false,
    activeLaunch,
    browser,
    page,
    launchResult;
  const failures = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "desktop-resume-fixture" }] }));
      return;
    }
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" } }],
          }),
        );
        return;
      }
      const { run } = facts();
      const phase =
        run.events.filter((event) => event.eventType === "attempt_started")
          .length > 1
          ? "resumed"
          : "initial";
      const step = scriptSteps[phase]++,
        cwd = session().cwd;
      const todos = (foundation, modules, verification) => ({
        name: "todo_write",
        args: {
          todos: [
            {
              content: "Save arithmetic module before restart",
              status: foundation,
            },
            {
              content: "Finish invoice and test modules after restart",
              status: modules,
            },
            { content: "Run actual Node tests", status: verification },
          ],
        },
      });
      const updateGoal = (action) => {
        const goal = lastGoal(body);
        return {
          name: "update_goal",
          args: { goal_id: goal.id, revision: goal.revision, action },
        };
      };
      const first = [
        () => ({
          name: "create_goal",
          args: {
            objective:
              "Implement the independent math and invoice project, stop, restart, continue and verify actual tests",
            max_goal_rounds: 12,
          },
        }),
        () => todos("in_progress", "pending", "pending"),
        () => ({
          name: "write",
          args: {
            file_path: path.join(cwd, "math.mjs"),
            content: "export const add = (left, right) => left + right;\n",
          },
        }),
        () => todos("completed", "pending", "pending"),
        () => ({
          text: "Arithmetic module is saved. Remaining modules and verification are unfinished.",
        }),
        () => ({ hold: true }),
      ];
      const next = [
        () => ({ name: "get_goal", args: {} }),
        () => {
          assert.equal(lastGoal(body).phase, "active");
          assert.match(
            JSON.stringify(body.messages),
            /Arithmetic module is saved/,
          );
          return updateGoal("resume");
        },
        () => todos("completed", "in_progress", "pending"),
        () => ({
          name: "write",
          args: {
            file_path: path.join(cwd, "invoice.mjs"),
            content:
              "import {add} from './math.mjs'; export const total = items => items.reduce(add, 0);\n",
          },
        }),
        () => ({
          name: "write",
          args: {
            file_path: path.join(cwd, "project.test.mjs"),
            content:
              "import test from 'node:test'; import assert from 'node:assert/strict'; import {total} from './invoice.mjs'; test('empty',()=>assert.equal(total([]),0)); test('positive cross-module values',()=>assert.equal(total([4,8]),12)); test('negative cross-module values',()=>assert.equal(total([4,-8]),-4));\n",
          },
        }),
        () => todos("completed", "completed", "in_progress"),
        () => ({
          name: "pwsh",
          args: {
            description: "Run isolated multi-module Node tests",
            workdir: cwd,
            command: `& '${process.execPath.replaceAll("'", "''")}' --test project.test.mjs`,
          },
        }),
        () => todos("completed", "completed", "completed"),
        () => ({ name: "get_goal", args: {} }),
        () => updateGoal("complete"),
        () => ({ text: "CONTROLLED_UI_RESTART_COMPLETED" }),
      ];
      const terminalFollowup =
        phase === "resumed" &&
        step >= next.length &&
        step < next.length + 4 &&
        facts().context.state === "completed";
      const action =
        (phase === "initial" ? first : next)[step] ??
        (terminalFollowup
          ? () => ({ text: "CONTROLLED_UI_RESTART_COMPLETED" })
          : null);
      assert.ok(action, "Fixture model sequence exceeded its finite plan");
      assert.ok(
        !body.tools?.some((tool) => tool.function.name === "codebuddy_task"),
        "Native Harness must own execution without the retired controller tool",
      );
      const result = action();
      receipt.models.push({
        phase,
        step,
        tool:
          result.name ??
          (result.hold
            ? "hold_response"
            : terminalFollowup
              ? "terminal_followup_text"
              : "final_text"),
        hasTaskTool: false,
      });
      save();
      if (result.hold) {
        checkpointReady = true;
        console.log(JSON.stringify({ checkpointReady: true, profile }));
        return;
      }
      if (result.name)
        assert.ok(
          body.tools.some((tool) => tool.function.name === result.name),
        );
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (result.name) {
        emit({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: {
                name: result.name,
                arguments: JSON.stringify(result.args),
              },
            },
          ],
        });
        emit({}, "tool_calls");
      } else {
        emit({ role: "assistant", content: result.text });
        emit({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error.message);
      if (!res.headersSent)
        res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  async function launch() {
    launchResult = null;
    activeLaunch = startPreview({
      dataDirectory: profile,
      env: {
        ...process.env,
        CODEBUDDY_PREVIEW_DEVTOOLS_PORT: "9393",
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
          throw Error(`Launcher ended early: ${JSON.stringify(launchResult)}`);
        try {
          return (
            await fetch("http://127.0.0.1:9393/json/version", {
              signal: AbortSignal.timeout(500),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      90000,
      "isolated Electron CDP",
    );
    browser = await chromium.connectOverCDP("http://127.0.0.1:9393");
    page = await until(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((item) => item.url().startsWith("http://localhost:")),
      30000,
      "Electron renderer",
    );
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => receipt.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        receipt.consoleErrors.push(message.text());
    });
    await page.getByRole("button", { name: "新任务", exact: true }).waitFor();
    const launchReceipt = JSON.parse(
      fs.readFileSync(path.join(profile, "logs", "preview", "launch.json")),
    );
    const cdp = await browser.newBrowserCDPSession();
    const processes = await cdp.send("SystemInfo.getProcessInfo");
    await cdp.detach();
    receipt.launches.push({
      ...launchReceipt,
      electronProcesses: processes.processInfo.map((item) => ({
        id: item.id,
        type: item.type,
      })),
    });
    receipt.routes.push(page.url());
    save();
  }
  async function shot(name) {
    const target = path.join(profile, name + ".png");
    await page.screenshot({ path: target });
    receipt.screenshots.push(target);
    save();
  }
  async function closeWindow() {
    await page.close();
    await browser.close();
    browser = null;
    page = null;
    const code = await Promise.race([
      activeLaunch,
      delay(30000).then(() => {
        throw Error("Launcher did not reap the closed fixture window");
      }),
    ]);
    assert.equal(code, 0);
    const ended = JSON.parse(
      fs.readFileSync(path.join(profile, "logs", "preview", "launch.json")),
    );
    assert.equal(ended.status, "stopped");
    const pids = [
      ended.runtimePid,
      ended.desktopPid,
      ...receipt.launches.at(-1).electronProcesses.map((item) => item.id),
    ];
    await until(
      () => pids.every((pid) => !alive(pid)),
      12000,
      "all owned runtime/Electron processes to exit",
    );
    receipt.launches.at(-1).shutdown = { ...ended, reapedPids: pids };
    activeLaunch = null;
    save();
  }
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = await openStore(path.join(profile, "backend"));
    const configured = await saveProvider(store, {
      engine: "openai_compatible",
      displayName: "Isolated desktop resume fixture",
      apiUrl: `http://127.0.0.1:${server.address().port}`,
      requiresAuth: false,
      models: ["desktop-resume-fixture"],
      supportsStreaming: true,
      headers: {},
    });
    await store.update((data) => {
      data.defaults = {
        providerId: configured.providerId,
        modelId: "desktop-resume-fixture",
      };
      data.preferences = { gooseMode: "auto", gooseMaxTurns: 30 };
    });
    save();
    console.log(JSON.stringify({ status: "starting", profile }));
    await launch();
    await page.getByRole("button", { name: "新任务", exact: true }).click();
    await page
      .locator("#dynamic-textarea")
      .fill(
        "CONTROLLED_UI_RESUME：在此独立目录实现 math 与 invoice 模块及三个 Node 测试，验证暂停、关闭应用、重启后从原任务继续。",
      );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    receipt.actions.push({ action: "new_task_and_send", route: page.url() });
    await until(
      () => checkpointReady,
      60000,
      "persisted first module and waiting model response",
    );
    receipt.sessionId = session().id;
    receipt.cwd = session().cwd;
    receipt.runId = facts().run.runId;
    await page
      .getByRole("button", {
        name: legacyControlPanel ? "暂停" : "停止",
        exact: true,
      })
      .waitFor();
    await shot("01-running-before-pause");
    await page
      .getByRole("button", {
        name: legacyControlPanel ? "暂停" : "停止",
        exact: true,
      })
      .click();
    receipt.actions.push({
      action: legacyControlPanel
        ? "clicked_pause_button"
        : "clicked_composer_stop_button",
      route: page.url(),
    });
    const checkpoint = await until(
      () => {
        const value = facts();
        return value.context.state === "paused" && !value.context.activeAttempt
          ? value
          : false;
      },
      30000,
      "quiescent paused run",
    );
    assert.equal(checkpoint.context.recovery.pendingEffects, 0);
    assert.equal(checkpoint.context.recovery.uncertainEffects, 0);
    await page.locator("#dynamic-textarea").waitFor();
    const originalFile = path.join(session().cwd, "math.mjs");
    const original = {
      sha256: createHash("sha256")
        .update(fs.readFileSync(originalFile))
        .digest("hex"),
      mtimeMs: fs.statSync(originalFile).mtimeMs,
    };
    receipt.checkpoint = checkpoint.context;
    receipt.routes.push(page.url());
    await shot("02-paused");
    await closeWindow();
    receipt.actions.push({ action: "closed_window_and_reaped_children" });
    await launch();
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    await page
      .getByRole("heading", { name: session().title, exact: true })
      .first()
      .click();
    await page.waitForURL((url) => url.href.includes(receipt.sessionId));
    await shot("03-reopened-workspace-confirmation");
    await page.getByRole("button", { name: "确认并开始", exact: true }).click();
    receipt.actions.push({
      action: "opened_history_and_confirmed_workspace",
      route: page.url(),
    });
    await page.locator("#dynamic-textarea").waitFor();
    const restored = facts();
    assert.deepEqual(restored.run.events, checkpoint.run.events);
    await shot("04-replayed-paused-run");
    if (legacyControlPanel)
      await page.getByRole("button", { name: "恢复", exact: true }).click();
    else {
      await page
        .locator("#dynamic-textarea")
        .fill(
          "继续现有任务，从已保存的计划和回执完成剩余模块及验证，保留已完成 math 模块。",
        );
      await page.getByRole("button", { name: "发送", exact: true }).click();
    }
    receipt.actions.push({
      action: legacyControlPanel
        ? "clicked_resume_button"
        : "sent_continue_in_same_chat",
      route: page.url(),
    });
    await until(
      () => {
        const current = facts().context;
        return current.state === "completed" && !current.activeAttempt;
      },
      60000,
      "resumed run completion",
    );
    await page
      .getByText("CONTROLLED_UI_RESTART_COMPLETED", { exact: true })
      .first()
      .waitFor();
    receipt.visibleCompletion = ["CONTROLLED_UI_RESTART_COMPLETED"];
    const finished = facts();
    assert.equal(finished.context.completionKind, "harness_goal");
    assert.equal(finished.context.nativeGoal.phase, "complete");
    assert.equal(finished.context.executionOwner, "harness");
    assert.equal(
      finished.context.tasks.filter((task) => task.state === "succeeded")
        .length,
      3,
    );
    assert.equal(
      finished.context.receipts.filter(
        (item) => item.kind === "command" && item.exitCode === 0,
      ).length,
      1,
    );
    assert.equal(finished.run.runId, checkpoint.run.runId);
    assert.deepEqual(
      finished.run.events.slice(0, checkpoint.run.events.length),
      checkpoint.run.events,
    );
    assert.deepEqual(
      {
        sha256: createHash("sha256")
          .update(fs.readFileSync(originalFile))
          .digest("hex"),
        mtimeMs: fs.statSync(originalFile).mtimeMs,
      },
      original,
    );
    assert.equal(
      finished.context.receipts.filter(
        (item) => item.kind === "write" && item.path === originalFile,
      ).length,
      1,
    );
    assert.equal(finished.context.recovery.pendingEffects, 0);
    assert.equal(finished.context.recovery.uncertainEffects, 0);
    const result = spawnSync(process.execPath, ["--test", "project.test.mjs"], {
      cwd: session().cwd,
      windowsHide: true,
      encoding: "utf8",
      timeout: 30000,
    });
    fs.writeFileSync(
      path.join(profile, "independent-tests.log"),
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    assert.equal(result.status, 0);
    receipt.finalContext = finished.context;
    receipt.independentTestsExit = result.status;
    receipt.stateSequence = finished.run.events.map((event) => ({
      sequence: event.sequence,
      type: event.eventType,
    }));
    receipt.sameRunAndOriginalFilePreserved = true;
    assert.deepEqual(receipt.pageErrors, []);
    assert.deepEqual(failures, []);
    await shot("05-completed");
    await closeWindow();
    receipt.status = "passed";
  } catch (error) {
    receipt.status = "incomplete";
    receipt.error = error.message;
    if (page && !page.isClosed()) {
      receipt.lastVisibleBody = (await page.locator("body").innerText()).slice(
        -14000,
      );
      await shot("failure").catch(() => {});
    }
  } finally {
    if (page && !page.isClosed())
      await closeWindow().catch((error) => {
        receipt.cleanupError = error.message;
      });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    receipt.modelFailures = failures;
    receipt.finishedAt = new Date().toISOString();
    save();
    console.log(
      JSON.stringify({
        status: receipt.status,
        profile,
        sessionId: receipt.sessionId,
        runId: receipt.runId,
        error: receipt.error,
        cleanupError: receipt.cleanupError,
        pageErrors: receipt.pageErrors,
      }),
    );
    if (receipt.status !== "passed") process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
