import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { openStore } from "./store.mjs";
import { createConversationDriver } from "./conversation-driver.mjs";
import { createMcpAppProxy } from "./mcp-app-proxy.mjs";
import { acquireProfileLock } from "./profile-lock.mjs";
import { createSourceStatus } from './source-status.mjs';
import { clientDisconnectedError } from './session-connection.mjs';
import { publicRpcError } from './error-presentation.mjs';

const previewSource = process.env.CODEBUDDY_HARNESS_PREVIEW === '1'
  ? createSourceStatus(path.dirname(fileURLToPath(import.meta.url))).catch(() => undefined)
  : Promise.resolve(undefined);

const equal = (a, b) => {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function createCompatServer({ dataDir, secret, driver, defaultModel, onRuntimeLoaded }) {
  const startupStarted = performance.now();
  const traceStartup = phase => console.info('[Runtime startup timing]', JSON.stringify({
    phase, elapsedMs: Math.round(performance.now() - startupStarted), at_ms: Date.now(),
  }));
  if (typeof secret !== "string" || secret.length < 16)
    throw Error("A local server secret of at least 16 characters is required");
  const profileLock = await acquireProfileLock(path.resolve(dataDir));
  let compat, appProxy;
  try {
    // Keep the lease until both startup operations settle, including on failure.
    const [runtime, profile] = await Promise.allSettled([
      import("./compat.mjs").then(module => {
        onRuntimeLoaded?.();
        return module;
      }),
      openStore(profileLock.directory, {
        defaultModel,
        onTiming: timing => console.info(`[Store ${timing.operation ?? 'commit'} timing]`, JSON.stringify(timing)),
      }),
    ]);
    if (runtime.status === 'rejected') throw runtime.reason;
    if (profile.status === 'rejected') throw profile.reason;
    const { Compat } = runtime.value;
    const store = profile.value;
    traceStartup('profile-and-imports-ready');
    let warmup;
    if (!driver) {
      let loaded;
      const get = () =>
        (loaded ??= import("./harness/index.mjs").then((m) =>
          m.createHarnessDriver({
            dataDir: path.join(dataDir, "harness"),
            projectFolders: { writeAccess: (cwd, target) => compat.workspaces.linkedWriteAccess(cwd, target) },
            instructionsHome: path.dirname(dataDir),
            managedWorkspaceRoot: process.env.CODEBUDDY_WORKSPACE_ROOT ?? path.join(dataDir, 'workspaces'),
          }),
        ));
      // Boot the official Host while the desktop is opening, not on Send.
      // Model metadata and remote MCP prewarming check desktop consent separately.
      warmup = () => {
        const started = performance.now();
        void get().then(() => console.info('[Harness host ready]', JSON.stringify({ elapsedMs: Math.round(performance.now() - started) })))
          .catch(() => console.error('[Harness host startup failed]'));
        void compat.prepareStartup().catch(() => console.error('[Harness startup preparation failed]'));
      };
      driver = Object.fromEntries(
        [
          "createSession",
          "startNativeSchedules",
          "nativeScheduleRequest",
          "warmMcpServers",
          "configureSession",
          "permissions",
          "prompt",
          "cancel",
          "close",
          "listTools",
          "callTool",
          "steer",
          "mainAgentProfile",
          "mainAgentUnavailable",
          "agentInputIds",
          "questions",
          "lastUserStop",
          "userTurnTerminals",
          "answerQuestion",
          "getGoal",
          "controlGoal",
          "getPlanMode",
          "setPlanMode",
          "compact",
          "contextUsage",
          "exportSessionLog",
          "listSkills",
          "listBuiltinSkills",
          "skillCatalog",
          "setSharedSkillEnabled",
          "refreshSkills",
          "upload",
          "testExtension",
          "extensionStatus",
          "fork",
          "forkWorkingDirectory",
          "releaseNativeSessionCapabilities",
          "history",
          "presentationContent",
          "referenceImageFiles",
          "listSubagentChildren",
          "listSessions",
          "rename",
          "generateTitle",
          "readResource",
          "listResources",
          "invalidateMcpServers",
        ].map((name) => [
          name,
          async (...args) => {
              if (name === 'extensionStatus' && !loaded) return [];
            if (
              ["close", "releaseNativeSessionCapabilities", "invalidateMcpServers"].includes(name) &&
              !loaded
            )
              return;
            return (await get())[name](...args);
          },
        ]),
      );
      // Unlike request methods, follow returns an AsyncIterable, not a Promise.
      driver.followSubagent = async function* (...args) {
        yield* (await get()).followSubagent(...args);
      };
      driver.memory = Object.fromEntries(
        ["get", "list", "set", "delete"].map((name) => [
          name,
          async (...args) => (await get()).memory[name](...args),
        ]),
      );
    }
    compat = new Compat(store, createConversationDriver(driver, store));
    const sourceStatus = await previewSource;
    const runtimeIdentity = sourceStatus ? await sourceStatus() : undefined;
    traceStartup('source-identity-ready');
    compat.runtimeStatus = async () => ({
      ...(sourceStatus ? await sourceStatus() : {}),
      activeTurns: compat.active.size,
    });
    await compat.initialize();
    traceStartup('compat-ready');
    appProxy = await createMcpAppProxy({ secret });
    let stopping = false;
    let pendingRequests = 0;
    let shutdownRequestError;
    const requestDrain = new Set();
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
        const d = store.read(['defaults']).defaults;
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
            hasActiveTasks: compat.active.size > 0 || (compat.schedules?.active.size ?? 0) > 0,
            runtime: runtimeIdentity,
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
      let connected = true;
      const pending = new Map();
      let initialized = false;
      const send = (message) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(message));
      };
      const connection = {
        notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
        ask: (method, params, signal) =>
          new Promise((resolve, reject) => {
            if (!connected) return reject(clientDisconnectedError());
            if (signal?.aborted) return reject(new DOMException("Cancelled", "AbortError"));
            const id = "server-" + randomUUID();
            const done = (error, result) => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", abort);
              pending.delete(id);
              error ? reject(error) : resolve(result);
            };
            const abort = () => done(new DOMException("Cancelled", "AbortError"));
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
          !Array.isArray(msg) &&
          msg.jsonrpc === "2.0" &&
          !Object.hasOwn(msg, 'method') &&
          Object.hasOwn(msg, 'id') &&
          (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))
        ) {
          // Cancellation may settle the wait before the client's reply arrives.
          // Responses never become new requests or receive another response.
          pending.get(msg.id)?.(
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
          if (stopping) throw Object.assign(Error('Runtime is preparing to update'), { code: -32000 });
          if (!initialized && msg.method !== "initialize")
            throw Object.assign(Error("Initialize the ACP connection first"), {
              code: -32002,
            });
          let result;
          pendingRequests++;
          try {
            result = await compat.request(msg.method, msg.params ?? {}, connection);
          } catch (error) {
            // In-flight finalizers can fail while persisting their last result.
            // A disconnected renderer cannot report that failure to the updater.
            const abandonedSetup = msg.method === 'session/new' && error.code === 'ACP_CLIENT_DISCONNECTED';
            if (stopping && !abandonedSetup && error.name !== 'AbortError') shutdownRequestError ??= error;
            throw error;
          } finally {
            pendingRequests--;
            if (!pendingRequests) {
              for (const resolve of requestDrain) resolve();
              requestDrain.clear();
            }
          }
          if (msg.method === "initialize") initialized = true;
          if (Object.hasOwn(msg, "id"))
            send({ jsonrpc: "2.0", id: msg.id, result });
        } catch (error) {
          if (Object.hasOwn(msg, "id"))
            send({
              jsonrpc: "2.0",
              id: msg.id,
              error: publicRpcError(error, msg.method),
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
        connected = false;
        compat.disconnect(connection);
        for (const done of [...pending.values()])
          done(clientDisconnectedError());
      });
    });
    let closePromise;
    const service = {
      async closeForUpdate({ stopTasks = false } = {}) {
        // Only the main-process confirmation may request interruption. Keep the
        // idle-only path for callers which have not obtained that consent.
        if (stopTasks) {
          await service.close();
          return true;
        }
        const reserved = await compat.schedules.reserveShutdownIfIdle(() => {
          if (stopping || pendingRequests || compat.active.size || compat.initializing.size ||
            compat.routing.size || compat.sessionMutations.size || compat.reviewExecutions.size ||
            compat.schedules?.active.size) return false;
          // Request admission and scheduler admission close in one synchronous
          // step, after any already admitted schedule has finished starting.
          stopping = true;
          return true;
        });
        if (!reserved) return false;
        await service.close();
        return true;
      },
      async listen(port = 0, host = "127.0.0.1") {
        if (host !== "127.0.0.1" && host !== "::1")
          throw Error("Preview backend must bind to loopback");
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, resolve);
        });
        warmup?.();
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
            await compat.close({ drainRequests: async () => {
              if (pendingRequests) await new Promise(resolve => requestDrain.add(resolve));
              if (shutdownRequestError) throw shutdownRequestError;
            } });
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
    return service;
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
    defaultModel: (await import('./default-model.json', { with: { type: 'json' } })).default,
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
