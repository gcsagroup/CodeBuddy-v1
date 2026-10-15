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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(root, ".preview-evidence/controlled-fixture.json"),
      ),
    );
    await page.getByTestId("add-custom-provider-card").click();
    await page.locator("#display-name").fill("Controlled Harness E2E");
    await page.locator("#api-url").fill(fixture.endpoint);
    await page
      .getByRole("button", { name: /^(加载模型|Load models)$/ })
      .click();
    await page
      .getByRole("button", { name: /^(创建提供商|Create Provider)$/ })
      .click();
    console.log(await page.locator("body").innerText());
    await page.screenshot({
      path: path.join(root, ".preview-evidence/desktop-configured.png"),
    });
    console.log(JSON.stringify({ pageErrors: errors }));
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
