import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { openStore } from "./store.mjs";
import { Compat } from "./compat.mjs";
import { createConversationDriver } from "./conversation-driver.mjs";
import { createMcpAppProxy } from "./mcp-app-proxy.mjs";
import { acquireProfileLock } from "./profile-lock.mjs";

const equal = (a, b) => {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function createCompatServer({ dataDir, secret, driver }) {
  if (typeof secret !== "string" || secret.length < 16)
    throw Error("A local server secret of at least 16 characters is required");
  const profileLock = await acquireProfileLock(path.resolve(dataDir));
  let compat, appProxy;
  try {
    const store = await openStore(profileLock.directory);
    let warmup;
    if (!driver) {
      let loaded;
      const get = () =>
        (loaded ??= import("./harness/index.mjs").then((m) =>
          m.createHarnessDriver({
            dataDir: path.join(dataDir, "harness"),
            instructionsHome: path.dirname(dataDir),
          }),
        ));
      // Boot the official Host while the desktop is opening, not on Send.
      // No session, model generation or MCP action is started by this warmup.
      warmup = () => {
        const started = performance.now();
        void get().then(() => console.info('[Harness host ready]', JSON.stringify({ elapsedMs: Math.round(performance.now() - started) })))
          .catch(() => console.error('[Harness host startup failed]'));
        void compat.prepareStartup().catch(() => console.error('[Harness startup preparation failed]'));
      };
      driver = Object.fromEntries(
        [
          "createSession",
          "warmMcpServers",
          "configureSession",
          "permissions",
          "prompt",
          "cancel",
          "close",
          "listTools",
          "callTool",
          "steer",
          "questions",
          "answerQuestion",
          "getGoal",
          "controlGoal",
          "compact",
          "contextUsage",
          "listSkills",
          "listBuiltinSkills",
          "refreshSkills",
          "upload",
          "testExtension",
          "extensionStatus",
          "fork",
          "forkWorkingDirectory",
          "releaseNativeSessionCapabilities",
          "history",
          "listSubagentChildren",
          "listSessions",
          "rename",
          "readResource",
          "listResources",
          "invalidateMcpServers",
        ].map((name) => [
          name,
          async (...args) => {
            if (
              ["close", "releaseNativeSessionCapabilities", "invalidateMcpServers"].includes(name) &&
              !loaded
            )
              return;
            return (await get())[name](...args);
          },
        ]),
      );
      driver.memory = Object.fromEntries(
        ["get", "list", "set", "delete"].map((name) => [
          name,
          async (...args) => (await get()).memory[name](...args),
        ]),
      );
    }
    compat = new Compat(store, createConversationDriver(driver, store));
    await compat.initialize();
    appProxy = await createMcpAppProxy({ secret });
    let stopping = false;
    const server = http.createServer((req, res) => {
      if (stopping) {
        res.writeHead(503, { Connection: 'close' });
        return res.end('Runtime is shutting down');
      }
      if (appProxy.handles(req)) {
        void appProxy.handle(req, res);
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      const authorized = equal(
        url.pathname === "/acp"
          ? url.searchParams.get("token")
          : req.headers["x-secret-key"],
        secret,
      );
      if (!authorized) {
        res.writeHead(401);
        return res.end("Authentication required");
      }
      if (url.pathname === "/acp") {
        res.writeHead(406);
        return res.end("Use the authenticated WebSocket transport");
      }
      if (url.pathname === "/status" || url.pathname === "/health") {
        const d = store.read().defaults;
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        return res.end(
          JSON.stringify({
            status: "ok",
            engine: "deepseek-harness",
            preview: true,
            modelConfigured: Boolean(d.providerId && d.modelId),
          }),
        );
      }
      res.writeHead(404);
      res.end("Not found");
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 48 * 1024 * 1024,
    });
    server.on("upgrade", (req, socket, head) => {
      if (stopping) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (
        url.pathname !== "/acp" ||
        !equal(url.searchParams.get("token"), secret)
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req),
      );
    });
    wss.on("connection", (ws) => {
      ws.on("error", () => {});
      const pending = new Map();
      let initialized = false;
      const send = (message) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(message));
      };
      const connection = {
        notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
        ask: (method, params, signal) =>
          new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(Error("Cancelled"));
            const id = "server-" + randomUUID();
            const done = (error, result) => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", abort);
              pending.delete(id);
              error ? reject(error) : resolve(result);
            };
            const abort = () => done(Error("Cancelled"));
            // Human decisions do not expire into consent or rejection. Native
            // question waits cancel their own signal; approval waits for the
            // user, an explicit stop, or connection teardown.
            const timer =
              ["session/request_permission", "_goose/unstable/session/recipe/request-params", "elicitation/create"].includes(method)
                ? undefined
                : setTimeout(
                    () => done(Error("Permission request timed out")),
                    300000,
                  );
            pending.set(id, (error, result) => done(error, result));
            signal?.addEventListener("abort", abort, { once: true });
            send({ jsonrpc: "2.0", id, method, params });
          }),
      };
      ws.on("message", async (bytes) => {
        let msg;
        try {
          msg = JSON.parse(bytes.toString());
        } catch {
          send({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Invalid JSON" },
          });
          return;
        }
        if (
          msg &&
          typeof msg === "object" &&
          !msg.method &&
          pending.has(msg.id)
        ) {
          pending.get(msg.id)(
            msg.error ? Error(msg.error.message) : null,
            msg.result,
          );
          return;
        }
        if (
          !msg ||
          Array.isArray(msg) ||
          msg.jsonrpc !== "2.0" ||
          typeof msg.method !== "string"
        ) {
          send({
            jsonrpc: "2.0",
            id: msg?.id ?? null,
            error: { code: -32600, message: "Invalid JSON-RPC request" },
          });
          return;
        }
        try {
          if (!initialized && msg.method !== "initialize")
            throw Object.assign(Error("Initialize the ACP connection first"), {
              code: -32002,
            });
          const result = await compat.request(
            msg.method,
            msg.params ?? {},
            connection,
          );
          if (msg.method === "initialize") initialized = true;
          if (Object.hasOwn(msg, "id"))
            send({ jsonrpc: "2.0", id: msg.id, result });
        } catch (error) {
          if (Object.hasOwn(msg, "id"))
            send({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: Number.isInteger(error.code) ? error.code : -32603,
                message: error.message,
                data: error.data,
              },
            });
          // Log method and code only; parameters can contain model credentials or user prompts.
          console.error(
            "[compat]",
            msg.method,
            Number.isInteger(error.code) ? error.code : -32603,
          );
        }
      });
      ws.on("close", () => {
        compat.disconnect(connection);
        for (const done of [...pending.values()])
          done(Error("Client disconnected"));
        for (const active of compat.active.values())
          if (active.connection === connection) active.controller.abort();
      });
    });
    let closePromise;
    return {
      async listen(port = 0, host = "127.0.0.1") {
        if (host !== "127.0.0.1" && host !== "::1")
          throw Error("Preview backend must bind to loopback");
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, resolve);
        });
        if (store.read(["defaults"]).defaults?.providerId) warmup?.();
        warmup = undefined;
        const address = server.address();
        return `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
      },
      close() {
        return (closePromise ??= (async () => {
          // Reconnecting clients must not create new sockets while owners drain.
          stopping = true;
          for (const ws of wss.clients) ws.terminate();
          try {
            await compat.close();
          } finally {
            try {
              await appProxy.close();
            } finally {
              try {
                await new Promise((resolve) => wss.close(resolve));
                if (server.listening)
                  await new Promise((resolve) => server.close(resolve));
              } finally {
                profileLock.close();
              }
            }
          }
        })());
      },
    };
  } catch (error) {
    try {
      await compat?.close();
    } catch {
      /* Preserve the startup failure. */
    }
    try {
      await appProxy?.close();
    } finally {
      profileLock.close();
    }
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const at = args.indexOf(name);
    return at < 0 ? fallback : args[at + 1];
  };
  const service = await createCompatServer({
    dataDir: path.resolve(arg("--data-dir", ".preview-data/backend")),
    secret: process.env.CODEBUDDY_SERVER__SECRET_KEY,
  });
  const url = await service.listen(
    Number(arg("--port", "39127")),
    arg("--host", "127.0.0.1"),
  );
  console.log(
    JSON.stringify({
      ready: true,
      url,
      engine: "deepseek-harness",
      pid: process.pid,
    }),
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
