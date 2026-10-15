"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const { chromium } = require(
  require.resolve("playwright", { paths: [path.join(root, "ui", "desktop")] }),
);
(async () => {
  const receiptPath = path.join(root, ".preview-evidence/real-model-ui.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9387");
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("http://localhost:"));
  try {
    const address = new URL(page.url());
    address.hash =
      "/pair?resumeSessionId=" + encodeURIComponent(receipt.sessionId);
    await page.goto(address.toString());
    await page
      .locator(".assistant")
      .getByText("CODEBUDDY_HARNESS_REAL_OK", { exact: true })
      .first()
      .waitFor();
    const roles = () =>
      page
        .getByTestId("message-container")
        .evaluateAll((nodes) =>
          nodes.map((n) =>
            n.classList.contains("user")
              ? "user"
              : n.classList.contains("assistant")
                ? "assistant"
                : "tool",
          ),
        );
    const readSession = () =>
      JSON.parse(
        fs.readFileSync(path.join(root, ".preview-data/backend/state.json")),
      ).sessions.find((s) => s.id === receipt.sessionId);
    const expectedRoles = (session) =>
      session.updates
        .filter((u) => u.sessionUpdate === "user_message_chunk")
        .flatMap(() => ["user", "assistant"]);
    const verifyRoles = async (expected) => {
      const deadline = Date.now() + 10000;
      let actual;
      do {
        actual = await roles();
        if (JSON.stringify(actual) === JSON.stringify(expected)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.deepEqual(actual, expected);
    };
    await verifyRoles(expectedRoles(readSession()));
    const marker = "CODEBUDDY_HARNESS_ORDER_OK";
    const alreadySent = readSession().updates.some(
      (u) =>
        u.sessionUpdate === "user_message_chunk" &&
        u.content.text.includes(marker),
    );
    if (!alreadySent) {
      await page
        .getByTestId("chat-input")
        .fill(
          "这是消息顺序修复后的续聊验证。只回复 " +
            marker +
            "，不调用任何工具。",
        );
      await page.getByTestId("chat-input").press("Enter");
    }
    await page
      .locator(".assistant")
      .getByText(marker, { exact: true })
      .first()
      .waitFor({ timeout: 90000 });
    const deadline = Date.now() + 15000;
    let session;
    while (Date.now() < deadline) {
      const state = JSON.parse(
        fs.readFileSync(path.join(root, ".preview-data/backend/state.json")),
      );
      session = state.sessions.find((s) => s.id === receipt.sessionId);
      const text = session.updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content.text)
        .join("");
      if (text.includes(marker)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(
      session.updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content.text)
        .join(""),
      new RegExp(marker),
    );
    await verifyRoles(expectedRoles(session));
    assert.equal(
      session.updates.filter((u) => u.sessionUpdate === "tool_call").length,
      0,
    );
    await page.screenshot({
      path: path.join(root, ".preview-evidence/real-model-restarted.png"),
    });
    Object.assign(receipt, {
      verifiedAt: new Date().toISOString(),
      restartReply: "CODEBUDDY_HARNESS_RESTART_OK",
      orderingReply: marker,
      liveOrdering: "passed",
      historyReplay: "passed",
      realTurns: session.updates.filter(
        (u) => u.sessionUpdate === "user_message_chunk",
      ).length,
      messageRoles: await roles(),
      dataDirectory: path.join(root, ".preview-data"),
      evidence: "real-model-restarted.png",
    });
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
