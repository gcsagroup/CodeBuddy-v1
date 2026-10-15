"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const { chromium } = require(
  require.resolve("playwright", { paths: [path.join(root, "ui", "desktop")] }),
);
(async () => {
  const browser = await chromium.connectOverCDP(
    "http://127.0.0.1:" + (process.argv[2] || "9387"),
  );
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    console.log(JSON.stringify(pages.map((p) => ({ url: p.url() }))));
    const page =
      pages.find((p) => p.url().startsWith("http://localhost:")) || pages[0];
    await page.waitForLoadState("domcontentloaded");
    console.log((await page.locator("body").innerText()).slice(0, 12000));
    const out = path.join(root, ".preview-evidence", "desktop-current.png");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    console.log("SCREENSHOT " + out);
    console.log(
      await page
        .locator("input,textarea,button,select,[contenteditable=true]")
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            tag: n.tagName,
            id: n.id,
            type: n.type,
            label: n.getAttribute("aria-label"),
            placeholder: n.getAttribute("placeholder"),
            text: n.innerText?.slice(0, 100),
          })),
        ),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
