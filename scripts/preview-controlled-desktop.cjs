// Local HTTP model fixture for exercising the real Electron -> ACP -> Harness path.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { startPreview } = require("./start-harness-preview.cjs");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.join(root, ".preview-evidence"), { recursive: true });
const dataDirectory = fs.mkdtempSync(path.join(root, ".preview-evidence", "controlled-profile-"));
const requests = [];
const server = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400).end();
    return;
  }
  requests.push({
    path: req.url,
    model: body.model,
    stream: body.stream,
    messages: body.messages,
  });
  fs.writeFileSync(
    path.join(dataDirectory, "model-requests.json"),
    JSON.stringify(requests, null, 2),
  );
  if (!body.stream) {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    return;
  }
  const lastUser = body.messages.findLastIndex((m) => m.role === "user");
  const prompt = JSON.stringify(body.messages[lastUser]?.content);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "desktop-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (prompt.includes("fixture_slow")) {
    emit({ content: "DESKTOP_CANCEL_STARTED" });
    const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 30000);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  if (
    prompt.includes("fixture_write") &&
    !body.messages.slice(lastUser + 1).some((m) => m.role === "tool")
  ) {
    emit({
      tool_calls: [
        {
          index: 0,
          id: "desktop-write",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({
              file_path: path.join(dataDirectory, "approved.txt"),
              content: "DESKTOP_APPROVAL_OK\n",
            }),
          },
        },
      ],
    });
    emit({}, "tool_calls");
  } else {
    emit({ reasoning_content: "Controlled desktop fixture reasoning." });
    emit({ content: "DESKTOP_HARNESS_OK" });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1", async () => {
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(
    path.join(dataDirectory, "fixture.json"),
    JSON.stringify({ endpoint, dataDirectory, devtoolsPort: 9387 }, null, 2),
  );
  console.log(`Controlled fixture ready: ${endpoint}`);
  fs.writeFileSync(path.join(root, ".preview-evidence", "controlled-fixture.json"),
    JSON.stringify({ endpoint, dataDirectory, devtoolsPort: 9387 }, null, 2));
  try {
    process.exitCode = await startPreview({
      dataDirectory,
      // Test the existing ordinary-chat mode; the delivered preview retains CodePro defaults.
      env: {
        ...process.env,
        CODEBUDDY_PREVIEW_DEVTOOLS_PORT: "9387",
      },
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
