"use strict";
const fs = require("node:fs");
const path = require("node:path");
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const action = process.argv[2] || "inspect";
    if (action === "close") {
      await page.close();
      return;
    }
    if (action === "back")
      await page.getByRole("button", { name: /^(返回|Back)$/ }).click();
    if (action === "home") {
      const close = page.getByRole("button", { name: /^(关闭|Close)$/ });
      if (await close.isVisible()) await close.click();
      await page.getByRole("button", { name: /^(聊天|Chat)$/ }).click();
    }
    if (action === "send") {
      await page
        .getByTestId("chat-input")
        .fill("只回复 CODEBUDDY_HARNESS_REAL_OK，不调用任何工具。");
      await page.getByTestId("chat-input").press("Enter");
      await page
        .getByText("CODEBUDDY_HARNESS_REAL_OK", { exact: true })
        .first()
        .waitFor({ timeout: 90000 });
      fs.writeFileSync(
        path.join(root, ".preview-evidence/real-model-ui.json"),
        JSON.stringify(
          {
            verifiedAt: new Date().toISOString(),
            model: "kimi-k3",
            endpoint: "https://ollama.com",
            path: "Electron ordinary-chat UI -> ACP -> official Harness -> configured provider",
            reply: "CODEBUDDY_HARNESS_REAL_OK",
            pageErrors: errors,
          },
          null,
          2,
        ),
      );
    }
    console.log(await page.locator("body").innerText());
    console.log(
      await page
        .locator("input,textarea,button,select,[contenteditable=true]")
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            tag: n.tagName,
            id: n.id,
            label: n.getAttribute("aria-label"),
            placeholder: n.getAttribute("placeholder"),
            text: n.innerText?.slice(0, 90),
          })),
        ),
    );
    await page.screenshot({
      path: path.join(root, ".preview-evidence", "desktop-" + action + ".png"),
    });
  } catch (error) {
    console.log(await page.locator("body").innerText());
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
