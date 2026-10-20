import { closeMediaStreams } from './comfyui-live.mjs';
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { contextUpdates, unfinishedCompactions, recoveredCompactionUpdates } from "./context-updates.mjs";
import { workStatusUpdates } from "./work-status.mjs";
import {
  invalid,
  requireString,
  inventory,
  resolvedModelInfo,
  discover,
  saveProvider,
  driverProvider,
  providerStatus,
  readProvider,
  thinkingProfile,
} from "./providers.mjs";
import { protectSecret, revealSecret } from "./secrets.mjs";
import {
  RuntimeSettings,
  validatePreference,
  DEFAULT_SYSTEM_PROMPT,
} from "./settings.mjs";
import { WorkspaceService } from "./workspaces.mjs";
import { CodeProRuns } from "./codepro.mjs";
import { SUBAGENT_TEMPLATES_KEY, validateSubagentTemplates, resolveSubagentModels } from './subagent-templates.mjs';
import { codeproInstructions } from "./task-tools.mjs";
import { openTranscriptJournal } from "./transcripts.mjs";
import { ProjectMemory } from "./memory.mjs";
import {
  publicToolName,
  harnessToolName,
  toolEnabled,
} from "./tool-policy.mjs";
import { prepareRecipe } from "./recipe-execution.mjs";
import { ScheduleService } from "./schedules.mjs";
import { workspaceIdentity } from "./workspaces.mjs";
import { harnessPrompt } from "./prompt-content.mjs";
import { applyModelThinking, modelThinkingPreference } from "./model-settings.mjs";
import { HistoryService, updatesFromConversation } from "./history.mjs";
import { loadLegacyConversation } from "./legacy-migration.mjs";
import {
  builtinMcp,
  isBuiltinMcp,
  listAvailableBuiltins,
} from "./builtin-extensions.mjs";
import { gitTools, GIT_READ_TOOL_NAMES } from "./git-extension.mjs";
import { COMMON_QUERY_KEY, validateQuerySettings, commonQueryMetadata } from "./common-query-settings.mjs";
import { CodeProReviews, reviewInstructions } from "./codepro-review.mjs";
import { TranscriptionService } from "./transcription.mjs";
import { SafetyPolicy } from "./safety-policy.mjs";
import { ConversationEditing } from "./conversation-editing.mjs";
import { listSubagentCatalog, readSubagentConversation } from "./subagent-conversations.mjs";
import { McpApps } from "./mcp-apps.mjs";
import { VisionRouting } from "./vision-routing.mjs";
import { LibraryService } from "./library.mjs";
import { desktopPetTool, PET_TOOL_NAME } from "./desktop-pet-tool.mjs";
import { comfyuiTool, IMAGE_TOOL_NAME } from "./comfyui-tool.mjs";
import { comfyuiVideoTool, VIDEO_TOOL_NAME } from "./comfyui-video-tool.mjs";
import {
  sealSessionExtensions,
  selectedExtensions,
  activeMcpServers,
  sessionMcpServers,
  harnessMcpServer,
  extensionName,
  extensionConfigKey,
  resolveSessionExtensions,
  extensionSnapshotChanged,
  isExtensionSnapshotChanged,
} from "./session-extensions.mjs";

const prefix = "_goose/unstable/";

// Both model calls and direct UI calls project the original MCP receipt.
function toolResultUpdate(event, metadata) {
  const blocks = Array.isArray(event.mcpResult?.content)
    ? event.mcpResult.content
    : Array.isArray(event.result)
      ? event.result
      : Array.isArray(event.result?.content)
        ? event.result.content
        : [];
  const content = blocks
    .filter((item) => ["text", "image", "audio", "resource", "resource_link"].includes(item?.type))
    .map((item) => ({
      type: "content",
      content: item.type === "image"
        ? { ...item, mimeType: item.mimeType ?? item.mediaType }
        : item,
    }));
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: event.id,
    status: event.isError ? "failed" : "completed",
    content: content.length ? content : [{ type: "content", content: {
      type: "text",
      text: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
    } }],
    rawOutput: event.mcpResult ? event.mcpResult.structuredContent : event.structuredContent ?? event.result,
    _meta: { goose: { ...metadata, ...(event.mcpApp ? { mcpApp: event.mcpApp } : {}) } },
  };
}

const preferenceKeys = [
  "comfyuiBaseUrl",
  "autoCompactThreshold",
  "gooseMode",
  "gooseThinkingEffort",
  "gooseMaxTurns",
  "personalizedMemoryEnabled",
  "voiceAutoSubmitPhrases",
  "voiceDictationProvider",
  "voiceDictationPreferredMic",
];
const modes = {
  currentModeId: "approve",
  availableModes: [
    { id: "approve", name: "Approve" },
    { id: "auto", name: "Auto" },
    { id: "smart_approve", name: "Smart approve" },
    { id: "chat", name: "Chat only" },
  ],
};
const unsupported = (method) =>
  Object.assign(
    Error("This preview has not connected this capability: " + method),
    { code: -32601 },
  );

// Early preview versions used Harness attempt ids directly. Those ids restart
// for each prompt, so later turns can collide in the desktop's message map.
// Project only colliding assistant ids on replay; never rewrite saved records.
function replayTranscript(session) {
  const byMessage = new Map();
  let turn = 0;
  let userId;
  let previousWasUser = false;
  const updates = session.updates.map((update) => {
    const id = update.messageId ?? update._meta?.goose?.messageId;
    if (update.sessionUpdate === "user_message_chunk") {
      if (!previousWasUser || id !== userId) turn += 1;
      userId = id;
      previousWasUser = true;
      return update;
    }
    previousWasUser = false;
    if (
      typeof id !== "string" ||
      !["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(
        update.sessionUpdate,
      )
    )
      return update;
    let occurrences = byMessage.get(id);
    if (!occurrences) {
      occurrences = new Map();
      byMessage.set(id, occurrences);
    }
    if (!occurrences.has(turn)) {
      const projectedId = occurrences.size
        ? `harness-replay:${createHash("sha256")
            .update(JSON.stringify([session.id, turn, userId, id]))
            .digest("hex")}`
        : id;
      occurrences.set(turn, projectedId);
    }
    const projectedId = occurrences.get(turn);
    if (projectedId === id) return update;
    return {
      ...update,
      ...(update.messageId != null ? { messageId: projectedId } : {}),
      ...(update._meta?.goose?.messageId != null
        ? {
            _meta: {
              ...update._meta,
              goose: { ...update._meta.goose, messageId: projectedId },
            },
          }
        : {}),
    };
  });
  const usageCounts = new Map();
  for (const update of session.usageUpdates ?? [])
    if (update.sessionUpdate === "message_usage")
      usageCounts.set(
        update.messageId,
        (usageCounts.get(update.messageId) ?? 0) + 1,
      );
  const usageOffsets = new Map();
  const usageUpdates = (session.usageUpdates ?? []).flatMap((update) => {
    const occurrences = byMessage.get(update.messageId);
    if (
      update.sessionUpdate !== "message_usage" ||
      !occurrences ||
      occurrences.size < 2
    )
      return [update];
    // The old official driver stored one final usage per assistant attempt.
    // If a foreign transcript has ambiguous counts, omit that attribution
    // rather than assign another turn's token count to the wrong message.
    if (usageCounts.get(update.messageId) !== occurrences.size) return [];
    const offset = usageOffsets.get(update.messageId) ?? 0;
    usageOffsets.set(update.messageId, offset + 1);
    return [{ ...update, messageId: [...occurrences.values()][offset] }];
  });
  return { updates, usageUpdates };
}

export class Compat {
  constructor(store, driver) {
    this.store = store;
    this.driver = driver;
    this.sessionToolApprovals = new WeakMap();
    this.active = new Map();
    this.initialized = new Set();
    this.initializing = new Map();
    this.configurationRevision = 0;
    this.routing = new Map();
    this.thinking = new Map();
    this.sessionMutations = new Map();
    this.connections = new Set();
    this.workspaces = new WorkspaceService(store);
    this.memory = new ProjectMemory(driver);
    this.history = new HistoryService(store);
    this.transcription = new TranscriptionService(store);
    this.safety = new SafetyPolicy(store, {
      modelMapping: process.env.SECURITY_ML_MODEL_MAPPING,
      overrides: {
        promptEnabled: process.env.SECURITY_PROMPT_ENABLED_OVERRIDE,
        commandEnabled:
          process.env.SECURITY_COMMAND_CLASSIFIER_ENABLED_OVERRIDE,
      },
    });
    this.reviewExecutions = new Map();
    this.reviews = new CodeProReviews(store, {
      resolveContext: (id) => this.reviewContext(id),
      runReview: (options) => this.runReview(options),
    });
    this.apps = new McpApps(store, {
      resolveContext: (id) => this.appContext(id),
    });
    this.library = store.directory
      ? new LibraryService(store, { driver, workspaces: this.workspaces })
      : null;
    this.settings = new RuntimeSettings(store, {
      changed: async (change) => {
        this.configurationRevision += 1;
        this.initialized.clear();
        if (change?.extensionConfigKeys) await this.driver.invalidateMcpServers?.(change.extensionConfigKeys);
        if (change?.kind !== 'model-thinking') this.sessionToolApprovals = new WeakMap();
      },
      testExtension: (p) => this.testExtension(p),
      checkProviderMutation: (id) => this.checkProviderMutation(id),
    });
    this.vision = new VisionRouting(driver, {
      resolveCapability: (selection) =>
        this.settings.request("model-capabilities/resolve", selection),
    });
    this.schedules = store.directory
      ? new ScheduleService(store, {
          run: (job, callbacks) => this.runSchedule(job, callbacks),
          stop: (sessionId) => this.request("session/cancel", { sessionId }),
          sessionInfo: async (sessionId) => {
            const state = this.store.read();
            const session = state.sessions.find((entry) => entry.id === sessionId);
            return session ? this.info(session, state) : null;
          },
          getRecipe: (id) => this.library.getRecipe(id),
        })
      : null;
    this.runs = new CodeProRuns(store, {
      onUpdate: ({ snapshot, notifications }) => {
        for (const c of this.connections) {
          if (c.background) continue;
          c.notify("session/update", {
            sessionId: snapshot.sessionId,
            update: {
              sessionUpdate: "session_info_update",
              _meta: { goose: { activeRunId: snapshot.runId } },
            },
          });
          c.notify(prefix + "codepro/run/update", { snapshot });
          for (const notification of notifications)
            c.notify(prefix + "session/update", notification);
          c.notify(prefix + "session/update", {
            sessionId: snapshot.sessionId,
            update: {
              sessionUpdate: "status_message",
              status: {
                type: "progress",
                message: "Task plan",
                data: this.runs.planContext(snapshot),
              },
            },
          });
        }
      },
      onCancel: async ({ sessionId }) => {
        const active = this.active.get(sessionId);
        if (active) {
          active.controller.abort();
          await this.driver.cancel(sessionId);
          await active.done;
        }
      },
      onResume: async ({ sessionId, runId }) => {
        const connection = [...this.connections].find((c) =>
          c.sessionIds?.has(sessionId),
        );
        if (!connection) throw invalid("Open this session before resuming");
        await this.prompt(
          {
            sessionId,
            prompt: [
              {
                type: "text",
                text: "Continue the existing task from its saved plan and verified receipts. Inspect current workspace state before acting; do not repeat completed or uncertain effects.",
              },
            ],
            _meta: { resumeRunId: runId },
          },
          connection,
        );
      },
    });
    this.conversations = new ConversationEditing(store, driver, {
      isActive: (id) => this.active.has(id),
      onChanged: (id) => this.initialized.delete(id),
      beforeTruncate: async (s) => {
        const run = this.runs.latest(s.id);
        if (
          run &&
          !["completed", "cancelled", "failed", "fatal", "exhausted"].includes(
            run.state,
          )
        )
          await this.runs.control({
            schemaVersion: 1,
            sessionId: s.id,
            runId: run.runId,
            commandId: randomUUID(),
            expectedSequence: run.lastSequence,
            action: {
              type: "emergency_stop",
              reason:
                "Conversation edited; workspace changes remain and a new task will inspect them",
            },
          });
      },
    });
  }
  async initialize() {
    await this.settings.initialize();
    if (this.store.directory)
      this.journal = await openTranscriptJournal(this.store);
    await this.runs.initialize();
    await this.reviews.initialize();
    await this.schedules?.start();
  }
  async reviewContext(sessionId) {
    const s = this.session(sessionId);
    if (s.readonlyHistory || s.type !== "code_pro")
      throw invalid("Review requires an active CodePro workspace");
    await this.workspaces.validateSession(s.id, s.cwd);
    await this.sessionModel(s);
    return {
      cwd: s.cwd,
      model: { provider: s.providerId, model: s.modelId },
    };
  }
  async appContext(sessionId) {
    const s = this.session(sessionId);
    await this.ensureSession(s);
    const selected = await selectedExtensions(s, this.settings);
    const names = new Set(selected.map((e) => extensionName(e.extension)));
    for (const server of await activeMcpServers(s, this.settings))
      names.add(server.name);
    const extensions = (await this.driver.extensionStatus(s.id))
      .filter((e) => e.status === "ready" && names.has(e.serverName))
      .map((e) => e.serverName);
    const permission = (extension) => ({
      onPermission: (call) =>
        ["read_mcp_resource", "list_mcp_resources"].includes(call.name) &&
        call.arguments?.server === extension &&
        extensions.includes(extension),
    });
    return {
      extensions,
      listResources: (extension, cursor) => {
        this.assertSessionAvailable(s.id);
        return this.driver.listResources(
          s.id,
          extension,
          cursor,
          permission(extension),
        );
      },
      readResource: (extension, uri) => {
        this.assertSessionAvailable(s.id);
        return this.driver.readResource(
          s.id,
          extension,
          uri,
          permission(extension),
        );
      },
    };
  }
  async recordCapabilityUsage(s, event) {
    if (event.type === "tool_result" && !event.isError && !event.error && event.mcpSource) {
      // This identity comes from the bound MCP invocation, never from its prose
      // or from splitting a normalized/hashed public tool name.
      const { extensionName: server, toolName: tool } = event.mcpSource;
      await this.settings.request("capability-usage/record-success", {
        eventId: `mcp:${event.sessionId ?? s.id}:${event.messageId ?? event.id}`,
        kind: "external",
        capabilityId: extensionConfigKey(server),
        recentResult: `tool completed: ${tool}`,
        reference: `mcp:${server}:${tool}`,
      });
      return;
    }
    const invoked = event.type === "skill_loaded";
    const loaded = event.type === "tool_result" && event.name === "skill" && !event.isError && !event.error;
    const name = invoked ? event.name : loaded ? event.structuredContent?.name : undefined;
    if (!name) return;
    // Native load evidence only; this is not a verdict on the resulting task.
    await this.settings.request("capability-usage/record-success", {
      eventId: `skill:${event.sessionId ?? s.id}:${invoked ? `invocation:${event.seq}` : `tool:${event.messageId ?? event.id}`}`,
      kind: "skill",
      capabilityId: name,
      recentResult: "instructions loaded",
      reference: `skill:${name}`,
    });
  }
  async runReview({ sessionId, reviewId, snapshot, signal, tool }) {
    const s = this.session(sessionId);
    const configured = this.provider(snapshot.model.provider);
    const profile = await driverProvider(configured, snapshot.model.model);
    const selected = applyModelThinking(profile, modelThinkingPreference(thinkingProfile(configured, snapshot.model.model),
      configured.thinkingEfforts?.[snapshot.model.model], this.store.read(['preferences']).preferences.gooseThinkingEffort));
    const id = `review-${reviewId}`;
    this.reviewExecutions.set(id, snapshot.model.provider);
    const cancel = () => {
      void this.driver.cancel(id);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      await this.driver.createSession({
        sessionId: id,
        cwd: s.cwd,
        provider: selected.provider,
        model: snapshot.model.model,
        options: {
          systemPrompt: reviewInstructions,
          tools: [tool],
          toolFilter: { allow: [] },
          mcpServers: [],
          maxTurns: 8,
          autoCompact: false,
          ...(selected.thinkingEffort
            ? { thinkingEffort: selected.thinkingEffort }
            : {}),
        },
      });
      signal.throwIfAborted();
      const result = await this.driver.prompt(
        id,
        [{ type: "text", text: JSON.stringify(snapshot) }],
        { signal, onPermission: (call) => call.name === tool.name },
      );
      if (result.stopReason !== "end_turn")
        throw invalid("Review did not finish: " + result.stopReason);
    } finally {
      signal.removeEventListener("abort", cancel);
      this.reviewExecutions.delete(id);
    }
  }
  async runSchedule(job, { signal, onSession }) {
    const root =
      process.env.CODEBUDDY_WORKSPACE_ROOT ??
      path.join(this.store.directory, "workspaces");
    await mkdir(root, { recursive: true });
    const cwd = path.join(root, `scheduled-${randomUUID()}`);
    const connection = {
      sessionIds: new Set(),
      notify: (method, params) => {
        for (const c of this.connections)
          if (!c.background) c.notify(method, params);
      },
      ask: async (method, params, requestSignal) => {
        const client = [...this.connections].find(
          (c) => c !== connection && !c.background,
        );
        if (!client)
          throw invalid(
            "Open CodeBuddy to answer this task permission request",
          );
        return client.ask(method, params, requestSignal);
      },
      background: true,
    };
    let sessionId;
    const cancel = () => {
      if (sessionId)
        void this.request("session/cancel", { sessionId }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const lease = await this.workspaces.acquire(
        {
          requestedPath: cwd,
          expectedState: "missing",
          expectedIdentity: workspaceIdentity(cwd),
        },
        connection,
      );
      const created = await this.request(
        "session/new",
        {
          cwd,
          mcpServers: [],
          _meta: {
            workspaceMode: job.workspaceMode,
            workspaceLeaseId: lease.leaseId,
            recipe: job.recipe,
            recipeInteractive: false,
          },
        },
        connection,
      );
      sessionId = created.sessionId;
      await this.store.update((state) => {
        state.sessions.find((session) => session.id === sessionId).scheduleId = job.id;
      });
      await onSession(sessionId);
      signal.throwIfAborted();
      const s = this.session(sessionId);
      const result = await this.prompt(
        {
          sessionId,
          prompt: [
            {
              type: "text",
              text: s.recipe.prompt?.trim() || s.recipe.instructions,
            },
          ],
        },
        connection,
      );
      if (result.stopReason === "cancelled")
        return { status: "cancelled", sessionId };
      if (
        s.type === "code_pro" &&
        this.runs.latest(sessionId)?.state !== "completed"
      )
        throw invalid(
          "Automatic task requires continuation or verification; inspect its session before enabling the schedule",
        );
      if (result.stopReason !== "end_turn")
        throw invalid(
          "Automatic task ended before completion: " + result.stopReason,
        );
      return { status: "completed", sessionId };
    } finally {
      signal.removeEventListener("abort", cancel);
      this.disconnect(connection);
    }
  }
  disconnect(connection) {
    this.transcription.disconnect(connection);
    this.connections.delete(connection);
    this.workspaces.disconnect(connection).catch(() => {});
    this.library?.disconnect?.(connection);
  }
  session(id) {
    const s = this.store.readSession
      ? this.store.readSession(id)
      : this.store.read(["sessions"]).sessions.find((s) => s.id === id);
    if (!s) throw invalid("Session not found");
    return s;
  }
  assertSessionAvailable(id) {
    const session = this.session(id);
    if (this.sessionMutations.has(id))
      throw invalid("Wait for the session change to finish");
    return session;
  }
  async mutateSession(id, operation) {
    this.assertSessionAvailable(id);
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    this.sessionMutations.set(id, { done });
    try {
      return await operation();
    } finally {
      this.sessionMutations.delete(id);
      finish();
    }
  }
  async releaseSession(s) {
    await this.driver.releaseNativeSessionCapabilities?.(
      s.nativeSessionId ?? s.id,
    );
    this.initialized.delete(s.id);
    this.routing.delete(s.id);
    this.thinking.delete(s.id);
    await this.workspaces.releaseSession(s.id);
  }
  checkProviderMutation(id) {
    if (this.vision.activeProviderIds().includes(id))
      throw invalid(
        "Stop the active image interpretation before editing its provider",
      );
    if ([...this.reviewExecutions.values()].includes(id))
      throw invalid("Stop the active review before editing its model provider");
    for (const sessionId of this.active.keys()) {
      const route = this.routing.get(sessionId);
      if (
        this.session(sessionId).providerId === id ||
        route?.main?.provider?.id === id
      )
        throw invalid(
          "Stop active sessions before editing or removing their model provider",
        );
    }
  }
  provider(id) {
    const p = this.store.read(["providers"]).providers.find((p) => p.id === id);
    if (!p)
      throw invalid(
        "Configure a model provider before starting a conversation",
      );
    return p;
  }
  async sessionModel(s) {
    const provider = this.provider(s.providerId);
    if (!provider.models.includes(s.modelId) || !providerStatus(provider).isConfigured)
      throw invalid("Configure the current session model first");
    return { provider: await driverProvider(provider, s.modelId), model: s.modelId };
  }
  info(s, state = this.store.read()) {
    // Scheduled origin is a UI contract, independent of the native execution
    // mode. Older sessions can recover it from the persisted schedule history.
    const scheduled = s.scheduleId || state.schedules?.some((job) => job.sessions?.includes(s.id));
    return {
      sessionId: s.id,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt,
      _meta: {
        createdAt: s.createdAt,
        messageCount: s.messageCount,
        providerId: s.providerId,
        modelId: s.modelId,
        sessionType: scheduled ? "scheduled" : s.type,
        workspaceBinding: s.workspaceBinding,
        projectId: s.projectId,
        activeRunId: this.runs.latest(s.id, state)?.runId,
        // Explicitly imported histories are retained records, including empty
        // ones. The frozen UI otherwise treats unnamed empty sessions as
        // disposable startup placeholders and automatically deletes them.
        userSetName: s.readonlyHistory ? true : (s.userSetName ?? false),
        archivedAt: s.archivedAt ?? undefined,
        readonlyHistory: s.readonlyHistory === true ? true : undefined,
        lastMessageAt: s.updatedAt,
      },
    };
  }
  options(s) {
    const p = this.store.read(["providers"]).providers.find((p) => p.id === s.providerId);
    if (!p) return [];
    return [
      {
        id: "provider",
        name: "Provider",
        type: "select",
        currentValue: p.id,
        options: this.store
          .read(["providers"])
          .providers.map((p) => ({ value: p.id, name: p.displayName })),
      },
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: s.modelId,
        options: p.models.map((m) => ({ value: m, name: m })),
      },
    ];
  }
  async sessionOptions(s, prepared = {}) {
    const state = this.store.read(["preferences", "prompts", "config", "providers"]);
    const instructions = Object.values(s.instructions ?? {});
    const basePrompt =
      instructions.filter((x) => x.mode === "set" && x.text).at(-1)?.text ??
      state.prompts?.system ??
      DEFAULT_SYSTEM_PROMPT;
    const preferences = state.preferences;
    const resolvedExtensions = prepared.extensions ?? await resolveSessionExtensions(s, this.settings);
    const extensions = resolvedExtensions.selected;
    const mcpServers = await Promise.all(
      extensions
        .filter((e) => e.extension.type === "mcp")
        .map((e) => harnessMcpServer(e.extension, state, s.cwd)),
    );
    for (const entry of extensions)
      if (isBuiltinMcp(entry.extension))
        mcpServers.push(
          await builtinMcp(entry.extension, {
            cwd: s.cwd,
            dataDir: this.store.directory,
          }),
        );
    for (const server of resolvedExtensions.mcpServers)
      if (!mcpServers.some((e) => e.serverName === server.name))
        mcpServers.push(
          await harnessMcpServer({ type: "mcp", server }, state, s.cwd),
        );
    const memoryInstructions =
      this.driver.memory &&
      extensions.some((e) => e.configKey === "projectmemory")
        ? await this.memory.sessionInstructions(s, {
            personalizedMemoryEnabled:
              preferences.personalizedMemoryEnabled === true,
          })
        : "";
    const nativeAllowed = [];
    for (const tool of prepared.tools ?? (await this.driver.listTools?.()) ?? [])
      if (await toolEnabled(s, this.settings, tool.name, resolvedExtensions))
        nativeAllowed.push(tool.name);
    resolvedExtensions.assertCurrent(s);
    const petEnabled = Boolean(process.env.CODEBUDDY_PET_DIRECTORY) && await toolEnabled(s, this.settings, PET_TOOL_NAME, resolvedExtensions);
    const imageEnabled = await toolEnabled(s, this.settings, IMAGE_TOOL_NAME, resolvedExtensions);
    const videoEnabled = await toolEnabled(s, this.settings, VIDEO_TOOL_NAME, resolvedExtensions);
    return {
      mcpRequestMetadata: (serverName) => serverName === "commonqueries" && extensions.some(e => isBuiltinMcp(e.extension) && e.extension.name === "commonqueries") ? commonQueryMetadata(this.store) : undefined,
      systemPrompt: [
        basePrompt,
        ...instructions.filter((x) => x.mode !== "set").map((x) => x.text),
        ...(memoryInstructions ? [memoryInstructions] : []),
        ...(s.recipe?.instructions ? [s.recipe.instructions] : []),
        ...(s.type === "code_pro" ? [codeproInstructions] : []),
      ].join("\n\n"),
      ...(s.temperature != null ? { temperature: s.temperature } : {}),
      ...((s.recipe?.settings?.max_turns ?? preferences.gooseMaxTurns) != null
        ? {
            maxTurns:
              s.recipe?.settings?.max_turns ?? preferences.gooseMaxTurns,
          }
        : {}),
      ...(this.thinking.get(s.id) != null
        ? { thinkingEffort: this.thinking.get(s.id) }
        : {}),
      ...(preferences.autoCompactThreshold != null
        ? { autoCompactThreshold: preferences.autoCompactThreshold }
        : {}),
      mcpServers,
      mcpImageFallback: async (content, { signal, toolName }) => {
        const state = this.store.read(["modelRouting", "providers"]);
        return this.vision.prepareToolContent({
          sessionId: s.id, cwd: s.cwd, signal,
          routing: state.modelRouting, providers: state.providers,
          content, toolName,
        });
      },
      subagentModels: await resolveSubagentModels(state.config, state.providers,
        (providerId, modelId) => this.settings.request('model-capabilities/resolve', { providerId, modelId })),
      restoreSubagentProvider: async (model, matches) => {
        for (const provider of this.store.read(['providers']).providers) {
          try {
            const candidate = await driverProvider(provider, model);
            if (matches(candidate)) return candidate;
            const capability = await this.settings.request('model-capabilities/resolve', { providerId: provider.id, modelId: model });
            const withCapabilities = value => capability.imageInput === 'supported' ? { ...value, inputModalities: ['text', 'image'] } : value;
            const selected = withCapabilities(candidate);
            if (matches(selected)) return selected;
            try {
              const inherited = withCapabilities(applyModelThinking(candidate, modelThinkingPreference(candidate, provider.thinkingEfforts?.[model], this.store.read(['preferences']).preferences.gooseThinkingEffort)).provider);
              if (matches(inherited)) return inherited;
            } catch { /* A stale preference cannot prevent an exact historical route from restoring. */ }
            // Pre-migration children retain their recorded native route. This
            // candidate is accepted only when its complete connection identity matches.
            const legacy = await driverProvider(provider, model, { legacyThinking: true });
            if (matches(legacy)) return legacy;
            const historical = withCapabilities(applyModelThinking(legacy, this.store.read(['preferences']).preferences.gooseThinkingEffort).provider);
            if (matches(historical)) return historical;
          }
          catch { /* A different or unavailable connection cannot replace this native route. */ }
        }
      },
      toolFilter: { allow: nativeAllowed },
      tools: [
        ...(imageEnabled ? [comfyuiTool({ cwd: s.cwd, dataDir: this.store.directory, sessionId: s.id, baseUrl: preferences.comfyuiBaseUrl ?? undefined })] : []),
        ...(videoEnabled ? [comfyuiVideoTool({ cwd: s.cwd, dataDir: this.store.directory, sessionId: s.id, baseUrl: preferences.comfyuiBaseUrl ?? undefined })] : []),
        ...(petEnabled ? [desktopPetTool({ cwd: s.cwd })] : []),
        ...(extensions.some((e) => e.configKey === "projectmemory")
          ? this.memory.tools(s)
          : []),
        ...(extensions.some((e) => extensionName(e.extension) === "git")
          ? gitTools(s.cwd)
          : []),
      ],
    };
  }
  async extensionResults(s) {
    if (!this.driver.extensionStatus || s.readonlyHistory) return [];
    const statuses = await this.driver.extensionStatus(s.id);
    return statuses.map((item) => ({
      name: item.serverName,
      success: item.status === "ready",
      ...(item.status === "ready"
        ? {}
        : { error: item.error ?? "Extension did not connect" }),
    }));
  }
  async approveTool(s, tool, connection, signal, directToolCall = false) {
    if (!(await toolEnabled(s, this.settings, tool.name))) return false;
    if (["read_mcp_resource", "list_mcp_resources"].includes(tool.name)) {
      const names = [
        ...(await selectedExtensions(s, this.settings)).map((e) =>
          extensionName(e.extension),
        ),
        ...(await activeMcpServers(s, this.settings)).map(
          (server) => server.name,
        ),
      ];
      if (!names.includes(tool.arguments?.server)) return false;
    }
    // Read the owner at each authorization boundary, including after an async
    // safety check or a pending human decision. Child calls use this same root
    // conversation id; they do not retain an independent mode snapshot.
    const currentPolicy = () => {
      // Rechecking a permission must not clone every chat and tool receipt.
      const state = this.store.read(['toolPermissions', 'preferences']);
      const session = this.store.readSession(s.id);
      return {
        mode: session?.mode ?? state.preferences.gooseMode ?? "approve",
        permission: state.toolPermissions?.[publicToolName(tool.name)] ?? state.toolPermissions?.[tool.name],
        missing: !session,
        confirmedProject: session?.type === 'code_pro' && session.workspaceBinding === 'writable_project',
      };
    };
    const blocked = ({ mode, permission, missing }) => missing || permission === "never_allow" || mode === "chat";
    if (blocked(currentPolicy())) return false;
    const userMessages =
      this.active.get(s.id)?.userMessages ??
      (s.updates ?? [])
        .filter(
          (u) =>
            u.sessionUpdate === "user_message_chunk" &&
            u.content?.type === "text",
        )
        .map((u) => u.content.text);
    const safety = await this.safety.inspect({ tool, userMessages, signal });
    signal?.throwIfAborted();
    // Safety classification can await a remote model. Recheck capability and
    // binding before automatic grants, just as after a human decision.
    if (!(await toolEnabled(s, this.settings, tool.name))) return false;
    const policy = currentPolicy();
    if (blocked(policy)) return false;
    const approval = tool.sessionApproval;
    if (approval && !approval.isCurrent()) return false;
    let grant;
    if (approval?.isCurrent?.() === true) {
      this.sessionToolApprovals ??= new WeakMap();
      let tools = this.sessionToolApprovals.get(approval.owner);
      if (!tools) { tools = new WeakMap(); this.sessionToolApprovals.set(approval.owner, tools); }
      grant = tools.get(approval.tool);
      if (!grant) { grant = { allowed: false, pending: null }; tools.set(approval.tool, grant); }
    }
    if (
      !safety.requiresApproval &&
      (grant?.allowed === true || policy.permission === "always_allow" || policy.mode === "auto" ||
        ((policy.mode === "approve" || policy.mode === "smart_approve") && (tool.readOnly === true || tool.delegationControl === true)) ||
        (policy.mode === "smart_approve" && policy.confirmedProject && tool.confinedFileWrite === true))
    )
      return true;
    // Native delegated agents run unattended inside the parent's current grant.
    // Reuse DSH's tool-denial result and completion delivery instead of opening
    // a human approval RPC from a child. The parent can handle the limitation.
    // This flag is supplied by the live native owner, never model arguments.
    if (tool.delegated === true) return false;

    // Parallel calls wait for the same tool's explicit choice, then recheck the
    // owner. Allow-once still requires each later call to ask for itself.
    if (grant?.pending && !safety.requiresApproval) {
      let cancel;
      try {
        await Promise.race([grant.pending, new Promise((_, reject) => {
          cancel = () => reject(signal.reason);
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) cancel();
        })]);
      } finally { if (cancel) signal?.removeEventListener('abort', cancel); }
      return this.approveTool(s, tool, connection, signal, directToolCall);
    }
    const reusable = Boolean(grant && !safety.requiresApproval);
    const decision = reusable ? Promise.withResolvers() : null;
    if (decision) grant.pending = decision.promise;
    try {
      const reply = await connection.ask(
        "session/request_permission",
        {
          sessionId: s.id,
          _meta: {
            ...(directToolCall ? { goose: { directToolCall: true } } : {}),
            ...(reusable ? { codepro: { authorizationScope: 'session', extensionSource: approval.extensionSource, ...(approval.targetOrigin ? { permissionClass: 'read_only' } : {}) } } : {}),
          },
          toolCall: {
            toolCallId: tool.id ?? randomUUID(),
            title: tool.name,
            status: "pending",
            kind: "execute",
            rawInput: tool.arguments,
            ...(safety.requiresApproval || approval?.targetOrigin
              ? {
                  content: [
                    {
                      type: "content",
                      content: { type: "text", text: [
                        ...(safety.requiresApproval ? [safety.explanation] : []),
                        ...(approval?.targetOrigin
                          ? [`允许本会话访问 ${approval.targetOrigin}（匿名网页读取，仅此站点；不包括其他站点、登录或提交）。`]
                          : []),
                      ].join('\n') },
                    },
                  ],
                }
              : {}),
          },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            ...(reusable
              ? [
                  {
                    optionId: "allow_always",
                    name: approval.targetOrigin
                      ? `Allow ${approval.targetOrigin} for this session`
                      : "Allow this tool for this session",
                    kind: "allow_always",
                  },
                ]
              : []),
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        },
        signal,
      );
      signal?.throwIfAborted();
      // Changing mode does not answer a pending question. A later explicit
      // decision still cannot bypass a newly disabled tool or a hard deny.
      if (!(await toolEnabled(s, this.settings, tool.name)) || blocked(currentPolicy())) return false;
      const option =
        reply?.outcome?.outcome === "selected" ? reply.outcome.optionId : null;
      if (approval && !approval.isCurrent()) return false;
      if (option === "allow_always" && reusable) grant.allowed = true;
      return (
        option === "allow_once" ||
        (option === "allow_always" && reusable)
      );
    } finally {
      if (decision) { grant.pending = null; decision.resolve(); }
    }
  }
  async testExtension(p) {
    if (p.extension?.name === "git")
      return {
        tools: gitTools(p.workingDir ?? this.store.directory).map(
          (t) => t.name,
        ),
      };
    if (isBuiltinMcp(p.extension)) {
      const server = await builtinMcp(p.extension, {
        cwd: p.workingDir ?? this.store.directory,
        dataDir: this.store.directory,
      });
      const tools = await this.driver.testExtension(server);
      return { tools: tools.map((t) => t.name) };
    }
    if (p.extension?.name === "projectmemory") {
      await this.driver.memory.list("codebuddy:readiness");
      return { tools: ["project_memory"] };
    }
    if (p.extension?.type !== "mcp") {
      if (p.extension?.name !== "developer")
        throw unsupported("builtin adapter: " + p.extension?.name);
      return { tools: (await this.driver.listTools()).map((t) => t.name) };
    }
    if (!this.driver.testExtension) throw unsupported("MCP connection test");
    const s = {
      id: "extension-test",
      cwd: p.workingDir ?? this.store.directory,
      providerId: "",
      modelId: "",
      type: "user",
    };
    const tested = await this.driver.testExtension(await harnessMcpServer(
      p.extension, this.store.read(["config"]), s.cwd, p.environment ?? {},
    ));
    return Array.isArray(tested)
      ? { tools: tested.map((t) => t.name) }
      : tested;
  }
  async ensureSession(s, { unpublished = false } = {}) {
    const pending = this.initializing.get(s.id);
    if (pending) return pending;
    const work = (async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await this.initializeSession(unpublished ? s : this.session(s.id), { unpublished }); }
        catch (error) {
          if (!isExtensionSnapshotChanged(error) || attempt >= 4) throw error;
          // The desktop registers bundled capabilities on mount. No prompt or
          // tool has started yet: prepare once more from its committed settings.
          await this.driver.releaseNativeSessionCapabilities?.(s.nativeSessionId ?? s.id);
          await this.store.flush();
        }
      }
    })();
    this.initializing.set(s.id, work);
    try { return await work; }
    finally { if (this.initializing.get(s.id) === work) this.initializing.delete(s.id); }
  }
  async readCurrentExtensions(sessionId, read) {
    for (let attempt = 0; ; attempt++) {
      try {
        const session = this.session(sessionId);
        const snapshot = await resolveSessionExtensions(session, this.settings);
        const result = await read(session, snapshot);
        snapshot.assertCurrent(this.session(sessionId));
        return result;
      } catch (error) {
        if (!isExtensionSnapshotChanged(error) || attempt >= 4) throw error;
        await this.store.flush();
      }
    }
  }
  async prepareStartup() {
    const state = this.store.read(['defaults', 'providers', 'config']);
    const provider = state.providers.find(p => p.id === state.defaults?.providerId);
    if (!provider || this.closing) return;
    const remote = async () => {
      const snapshot = await this.settings.extensionSnapshot();
      const servers = await Promise.all(snapshot.entries
        .filter(e => e.extension.type === 'mcp' && !e.extension.server?.command)
        .map(e => harnessMcpServer(e.extension, state, this.store.directory)));
      snapshot.assertCurrent();
      if (!this.closing && servers.length) return await this.driver.warmMcpServers?.(servers) ?? [];
      return [];
    };
    // Metadata and connection discovery only: no model generation, session,
    // stdio child or tool action. Native preset leases also serve Send in flight.
    const started = performance.now();
    const results = await Promise.allSettled([
      driverProvider(provider, state.defaults.modelId), remote(),
    ]);
    console.info('[Harness startup preparation]', JSON.stringify({
      elapsedMs: Math.round(performance.now() - started),
      metadataReady: results[0].status === 'fulfilled',
      remoteMcpReady: results[1].status === 'fulfilled' && results[1].value.every(server => server.status === 'ready'),
    }));
  }
  async initializeSession(s, { unpublished = false } = {}) {
    const configurationRevision = this.configurationRevision;
    if (this.sessionMutations.has(s.id))
      throw invalid("Wait for the session change to finish");
    if (s.readonlyHistory)
      throw invalid(
        "This imported history is read-only; start a new task to continue work",
      );
    if (this.active.get(s.id)?.driverStarted) return;
    if (!this.initialized.has(s.id)) {
      const started = performance.now();
      // Credential reads, capability discovery and native Host activation have
      // no dependency on each other. Keep model admission after all three and
      // the existing configuration-revision check.
      const phases = {};
      const measure = async (name, operation) => {
        const begin = performance.now();
        try { return await operation(); }
        finally { phases[name] = Math.round(performance.now() - begin); }
      };
      const [routing, extensions, tools] = await Promise.all([
        measure('routingMs', () => this.sessionModel(s).then(main => ({ main }))),
        measure('extensionsMs', () => resolveSessionExtensions(s, this.settings)),
        measure('hostToolsMs', () => this.driver.listTools?.() ?? []),
      ]);
      if (s.type === "code_pro") this.routing.set(s.id, routing);
      const route = this.routing.get(s.id)?.main;
      const main = applyModelThinking(
        routing.main.provider,
        modelThinkingPreference(thinkingProfile(this.provider(routing.main.provider.id), routing.main.model), this.provider(routing.main.provider.id).thinkingEfforts?.[routing.main.model], this.store.read(['preferences']).preferences.gooseThinkingEffort),
      );
      const provider = main.provider;
      this.thinking.set(s.id, main.thinkingEffort);
      const capability = await this.settings.request(
        "model-capabilities/resolve",
        {
          providerId: route?.provider.id ?? s.providerId,
          modelId: route?.model ?? s.modelId,
        },
      );
      if (capability.imageInput === "supported")
        provider.inputModalities = ["text", "image"];
      const options = await measure('optionsMs', () => this.sessionOptions(s, { extensions, tools }));
      const current = unpublished ? s : this.assertSessionAvailable(s.id);
      if (
        (current.nativeSessionId ?? current.id) !==
          (s.nativeSessionId ?? s.id) ||
        current.cwd !== s.cwd
      )
        throw invalid(
          "Session changed while its capabilities were being prepared; retry",
        );
      const preparedAt = performance.now();
      await this.driver.createSession({
        sessionId: s.id,
        cwd: s.cwd,
        provider,
        model: route?.model ?? s.modelId,
        options,
      });
      if (!unpublished) this.assertSessionAvailable(s.id);
      if (configurationRevision !== this.configurationRevision)
        throw extensionSnapshotChanged("Settings changed while the session was starting; retry with the current settings");
      this.initialized.add(s.id);
      console.info('[Harness session preparation]', JSON.stringify({
        sessionId: s.id,
        adapterMs: Math.round(preparedAt - started),
        phases,
        nativeSetupMs: Math.round(performance.now() - preparedAt),
        elapsedMs: Math.round(performance.now() - started),
      }));
    }
  }
  async prepareModelContent(s, content, signal) {
    const state = this.store.read(["modelRouting", "providers"]);
    const main = this.routing.get(s.id)?.main;
    return this.vision.preparePrompt({
      sessionId: s.id,
      cwd: s.cwd,
      content,
      routing: state.modelRouting,
      main: main
        ? { providerId: main.provider.id, modelId: main.model }
        : { providerId: s.providerId, modelId: s.modelId },
      providers: state.providers,
      signal,
    });
  }
  async request(method, p = {}, connection) {
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw invalid("RPC params must be an object");
    if (
      p.sessionId &&
      this.sessionMutations.has(p.sessionId) &&
      method !== "session/cancel"
    )
      throw invalid("Wait for the session change to finish");
    if (connection) {
      this.connections.add(connection);
      connection.sessionIds ??= new Set();
      if (p.sessionId) connection.sessionIds.add(p.sessionId);
    }
    if (this.workspaces.handles(method, p))
      return this.workspaces.request(method, p, connection);
    if (this.transcription.handles(method))
      return this.transcription.request(method, p, connection);
    if (this.reviews.handles(method.replace(prefix, "")))
      return this.reviews.request(method.replace(prefix, ""), p);
    if (this.conversations.handles(method))
      return this.mutateSession(p.sessionId, () =>
        this.conversations.request(method, p),
      );
    if (this.apps.handles(method.replace(prefix, "")))
      return this.apps.request(method.replace(prefix, ""), p);
    if (method === "_codebuddy/media/jobs") {
      requireString(p.sessionId, "sessionId");
      const session = this.session(p.sessionId);
      const options = { cwd: session.cwd, dataDir: this.store.directory, sessionId: session.id };
      const [images, videos] = await Promise.all([comfyuiTool(options).jobs(), comfyuiVideoTool(options).jobs()]);
      return { sessionId: session.id, jobs: [...images, ...videos].sort((a, b) => b.created_at.localeCompare(a.created_at)) };
    }
    if (method === "initialize")
      return {
        protocolVersion: 1,
        agentInfo: { name: "CodeBuddy", version: "0.1.0" },
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { list: {}, close: {}, fork: {} },
          _meta: { goose: { customNotifications: true } },
        },
      };
    if (method === "authenticate")
      throw unsupported(
        "ACP provider authentication; configure the model connection in settings",
      );
    if (method === "session/new") {
      requireString(p.cwd, "cwd");
      if (!path.isAbsolute(p.cwd)) throw invalid("cwd must be absolute");
      if (p.mcpServers != null && !Array.isArray(p.mcpServers))
        throw invalid("mcpServers must be an array");

      const sessionId = randomUUID();
      const codePro = p._meta?.workspaceMode === "codepro";
      let workspaceBound = false;
      const bindWorkspace = async () => {
        if (codePro && !workspaceBound) {
          await this.workspaces.consumeLease(
            { leaseId: p._meta?.workspaceLeaseId, cwd: p.cwd, sessionId },
            connection,
          );
          workspaceBound = true;
        }
      };
      let finishCreation;
      const done = new Promise((resolve) => {
        finishCreation = resolve;
      });
      this.sessionMutations.set(sessionId, { done });
      let s;
      try {
        const prepared = await prepareRecipe(
          this.library,
          p._meta ?? {},
          sessionId,
          connection,
          // A validated recipe may wait indefinitely for human input. Accept
          // the still-valid workspace token first, then recheck before saving.
          bindWorkspace,
        );
        const defaults = {
          ...this.store.read(["defaults"]).defaults,
          ...(prepared.providerId ? { providerId: prepared.providerId } : {}),
          ...(prepared.modelId ? { modelId: prepared.modelId } : {}),
        };
        const selectedProvider = this.provider(defaults.providerId);
        requireString(defaults.modelId, "default model");
        if (!selectedProvider.models.includes(defaults.modelId))
          throw invalid(
            "Select an available default model before starting a session",
          );
        const now = new Date().toISOString();
        s = {
          id: sessionId,
          cwd: p.cwd,
          title: "New Session",
          createdAt: now,
          updatedAt: now,
          providerId: defaults.providerId,
          modelId: defaults.modelId,
          type: codePro ? "code_pro" : "user",
          workspaceBinding: p._meta?.workspaceBinding ?? "writable_project",
          projectId: p._meta?.projectId ?? null,
          ...(await sealSessionExtensions(
            prepared.enabledExtensions.length
              ? [
                  ...(p._meta?.enabledExtensions ??
                    (await this.settings.extensions())
                      .filter((e) => e.enabled)
                      .map((e) => e.extension)),
                  ...prepared.enabledExtensions,
                ]
              : (p._meta?.enabledExtensions ?? null),
            p.mcpServers ?? [],
          )),
          recipe: prepared.recipe ? { ...prepared.recipe, extensions: [] } : null,
          userRecipeValues: prepared.userRecipeValues,
          temperature: prepared.temperature,
          messageCount: 0,
          updates: [],
        };
        await bindWorkspace();
        if (codePro)
          await this.workspaces.validateSession(s.id, s.cwd, {
            initialContents: true,
          });
        // Persist the conversation before starting model/MCP services. Their
        // readiness belongs to the first prompt, not the new-chat navigation.
        await this.store.update((state) => state.sessions.push(s));
      } catch (error) {
        await this.workspaces.releaseSession(sessionId, { discardUnused: true });
        throw error;
      } finally {
        this.sessionMutations.delete(sessionId);
        finishCreation();
      }
      connection?.sessionIds?.add(s.id);
      return {
        sessionId: s.id,
        modes: {
          ...modes,
          currentModeId:
            s.mode ?? this.store.read(["preferences"]).preferences?.gooseMode ?? "approve",
        },
        configOptions: this.options(s),
        _meta: {
          workingDir: s.cwd,
          extensionResults: [],
          recipe: s.recipe ?? null,
          userRecipeValues: s.userRecipeValues ?? null,
        },
      };
    }
    if (method === "session/list") {
      const types = p._meta?.types;
      if (types != null && !Array.isArray(types))
        throw invalid("Session types must be an array");
      const query =
        typeof p._meta?.query === "string"
          ? p._meta.query.trim().toLocaleLowerCase()
          : "";
      // A history listing must use one consistent snapshot. Reading the full
      // transcript store per row blocks model streams on large migrated profiles.
      const state = this.store.read();
      const sessions = state.sessions.filter(
          (s) =>
            (!p.cwd || s.cwd === p.cwd) &&
            (!types?.length || types.includes(s.type)) &&
            (p._meta?.includeArchived || !s.archivedAt) &&
            (!query ||
              s.title.toLocaleLowerCase().includes(query) ||
              s.updates.some(
                (u) =>
                  u.content?.type === "text" &&
                  u.content.text.toLocaleLowerCase().includes(query),
              )),
        );
      return {
        sessions: sessions
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((s) => this.info(s, state)),
      };
    }
    if (method === "session/load") {
      const s = this.session(p.sessionId);
      if (s.type === "code_pro" && !s.readonlyHistory) {
        if (p._meta?.workspaceLeaseId)
          await this.workspaces.consumeLease(
            { leaseId: p._meta.workspaceLeaseId, cwd: s.cwd, sessionId: s.id },
            connection,
          );
        else {
          try {
            await this.workspaces.validateSession(s.id, s.cwd);
          } catch {
            throw invalid(
              "CodePro workspace must be re-confirmed before this session can be resumed",
            );
          }
        }
      }
      const liveReplay = this.active.get(s.id)?.replay;
      // Journal projection is committed at turn end. Include already-published
      // live updates until that same turn has reached the persisted high water mark.
      const includeLive = liveReplay && !Object.values(s.transcriptTurns ?? {}).some(turn => turn.turnId === liveReplay.turnId);
      const transcript = replayTranscript(
        s.legacyHistory
          ? {
              ...s,
              updates: updatesFromConversation(
                await loadLegacyConversation(
                  this.store.directory,
                  s.legacyHistory,
                ),
                s.createdAt,
              ),
            }
          : includeLive ? { ...s, updates: [...(s.updates ?? []), ...liveReplay.users, ...liveReplay.updates], usageUpdates: [...(s.usageUpdates ?? []), ...liveReplay.usageUpdates] } : s,
      );
      for (const update of transcript.updates)
        connection.notify("session/update", { sessionId: s.id, update });
      for (const update of transcript.usageUpdates)
        connection.notify("_goose/unstable/session/update", {
          sessionId: s.id,
          update,
        });
      const unfinished = unfinishedCompactions(transcript.usageUpdates);
      if (unfinished.length && !this.active.has(s.id) && !s.readonlyHistory) {
        const history = await this.driver.history(s.id);
        for (const update of recoveredCompactionUpdates(unfinished, history.events))
          connection.notify("_goose/unstable/session/update", { sessionId: s.id, update });
      }
      const snapshot = this.runs.latest(s.id);
      if (snapshot) {
        connection.notify("session/update", {
          sessionId: s.id,
          update: {
            sessionUpdate: "session_info_update",
            // The latest run is retained for inspection after its Harness turn
            // ends. Only a live operation may reopen the renderer's stream.
            _meta: { goose: { activeRunId: this.active.has(s.id) ? snapshot.runId : null } },
          },
        });
        connection.notify(prefix + "codepro/run/update", { snapshot });
        connection.notify(prefix + "session/update", {
          sessionId: s.id,
          update: {
            sessionUpdate: "status_message",
            status: {
              type: "progress",
              message: "Task plan",
              data: this.runs.planContext(snapshot),
            },
          },
        });
      }
      return {
        modes: {
          ...modes,
          currentModeId:
            s.mode ?? this.store.read(["preferences"]).preferences?.gooseMode ?? "approve",
        },
        configOptions: this.options(s),
        _meta: {
          workingDir: s.cwd,
          extensionResults: await this.extensionResults(s),
          recipe: s.recipe ?? null,
          userRecipeValues: s.userRecipeValues ?? null,
        },
      };
    }
    if (method === "session/prompt") return this.prompt(p, connection);
    if (method === "session/cancel") {
      this.session(p.sessionId);
      const active = this.active.get(p.sessionId);
      if (active) {
        active.controller.abort();
        if (active.driverStarted) await this.driver.cancel(p.sessionId);
      }
      return {};
    }
    if (method === "session/close") {
      return this.mutateSession(p.sessionId, async () => {
        const active = this.active.get(p.sessionId);
        if (active) {
          active.controller.abort();
          await this.driver.cancel(p.sessionId);
          await active.done;
        }
        return this.driver.withConversationLock(p.sessionId, async () => {
          await this.releaseSession(this.session(p.sessionId));
          return {};
        });
      });
    }
    if (method === "session/set_config_option") {
      const s = this.session(p.sessionId);
      if (this.active.has(s.id))
        throw invalid("Stop the current turn before changing its model");
      let selection;
      if (p.configId === "provider_model") {
        try {
          selection = JSON.parse(p.value);
        } catch {
          throw invalid("Invalid provider/model selection");
        }
      } else if (p.configId === "model")
        selection = { providerId: s.providerId, modelId: p.value };
      else if (p.configId === "provider")
        selection = {
          providerId: p.value,
          modelId: this.provider(p.value).models[0],
        };
      else throw unsupported(method + ": " + p.configId);
      if (
        !selection ||
        typeof selection !== "object" ||
        Array.isArray(selection)
      )
        throw invalid("Invalid provider/model selection");
      const provider = this.provider(selection.providerId);
      if (!provider.models.includes(selection.modelId))
        throw invalid("Unknown model");
      await this.store.update((state) =>
        Object.assign(
          state.sessions.find((x) => x.id === s.id),
          { providerId: provider.id, modelId: selection.modelId },
        ),
      );
      this.initialized.delete(s.id);
      return { configOptions: this.options(this.session(s.id)) };
    }
    if (method === "session/set_mode") {
      const s = this.session(p.sessionId);
      validatePreference("gooseMode", p.modeId);
      await this.store.update((state) => {
        state.sessions.find((x) => x.id === s.id).mode = p.modeId;
      });
      connection?.notify("session/update", {
        sessionId: s.id,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: p.modeId,
        },
      });
      return {};
    }
    if (method === "session/delete") {
      return this.mutateSession(p.sessionId, () =>
        this.driver.withConversationLock(p.sessionId, async () => {
          if (this.active.has(p.sessionId))
            throw invalid("Stop the session before deleting it");
          await this.releaseSession(this.session(p.sessionId));
          await this.store.update((state) => {
            state.sessions = state.sessions.filter((s) => s.id !== p.sessionId);
          });
          return {};
        }),
      );
    }
    if (!method.startsWith(prefix)) throw unsupported(method);
    const name = method.slice(prefix.length);
    if (name === "subagent/conversation/get")
      return readSubagentConversation(this.session(p.sessionId), p, this.driver);
    if (name === "subagent/catalog/list")
      return listSubagentCatalog(this.session(p.sessionId), p, this.driver);
    if (["session/import", "session/export"].includes(name))
      return this.history.request(name, p);
    if (this.schedules?.handles(method))
      return this.schedules.request(method, p);
    const memoryResult = await this.memory.request(name, p);
    if (memoryResult !== undefined) {
      if (
        [
          "codepro/memory/status",
          "codepro/memory/update",
          "codepro/memory/delete",
        ].includes(name)
      )
        this.initialized.clear();
      return memoryResult;
    }
    const libraryResult = await this.library?.request(method, p, connection);
    if (libraryResult !== undefined) return libraryResult;
    if (name === "extensions/available") {
      const definitions = (await this.settings.extensions()).map(
        (e) => e.extension,
      );
      for (const entry of await listAvailableBuiltins())
        if (
          entry.available &&
          !definitions.some((e) => extensionName(e) === entry.configKey)
        )
          definitions.push(entry.extension);
      return { extensions: definitions };
    }
    const settingsResult = await this.settings.request(name, p);
    if (settingsResult !== undefined) return settingsResult;
    switch (name) {
      case "session/working-dir/update": {
        const s = this.session(p.sessionId);
        if (s.readonlyHistory) throw invalid("Imported history is read-only");
        if (s.type === "code_pro")
          throw invalid(
            "CodePro workspaces remain bound to their task; start a new task for another project",
          );
        if (this.active.has(s.id))
          throw invalid("Stop the current turn before changing its workspace");
        if (typeof p.workingDir !== "string" || !path.isAbsolute(p.workingDir))
          throw invalid("Choose an existing absolute workspace directory");
        await this.ensureSession(s);
        if (
          !this.driver.withConversationLock ||
          !this.driver.forkWorkingDirectory
        )
          throw unsupported("session workspace change");
        return this.mutateSession(s.id, () =>
          this.driver.withConversationLock(s.id, async () => {
            if (this.active.has(s.id))
              throw invalid(
                "Stop the current turn before changing its workspace",
              );
            const current = this.session(s.id);
            const previousNativeSessionId =
              current.nativeSessionId ?? current.id;
            const fork = await this.driver.forkWorkingDirectory(
              s.id,
              p.workingDir,
            );
            if (
              fork.sessionId === previousNativeSessionId &&
              fork.cwd === current.cwd
            )
              return {};
            await this.store.update((state) => {
              const session = state.sessions.find((item) => item.id === s.id);
              if (
                !session ||
                (session.nativeSessionId ?? session.id) !==
                  previousNativeSessionId ||
                session.cwd !== current.cwd
              )
                throw invalid(
                  "Session changed before the workspace switch could be saved",
                );
              session.nativeSessionId = fork.sessionId;
              session.cwd = fork.cwd;
              session.updatedAt = new Date().toISOString();
              session.directoryChanges ??= [];
              session.directoryChanges.push({
                previousNativeSessionId,
                nativeSessionId: fork.sessionId,
                previousCwd: current.cwd,
                cwd: fork.cwd,
                changedAt: session.updatedAt,
              });
            });
            this.initialized.delete(s.id);
            try {
              await this.driver.releaseNativeSessionCapabilities?.(
                previousNativeSessionId,
              );
            } catch {
              console.error(
                "[compat] workspace changed; retired capabilities will be closed at shutdown",
              );
            }
            connection?.notify("session/update", {
              sessionId: s.id,
              update: {
                sessionUpdate: "session_info_update",
                updatedAt: this.session(s.id).updatedAt,
              },
            });
            return {};
          }),
        );
      }
      case "session/extensions/add":
      case "session/extensions/remove": {
        const s = this.session(p.sessionId);
        if (this.active.has(s.id))
          throw invalid("Stop the current turn before changing extensions");
        let extensions = (await selectedExtensions(s, this.settings)).map(
          (e) => e.extension,
        );
        if (name.endsWith("add")) {
          if (!extensionName(p.extension))
            throw invalid("Extension name is required");
          extensions = [
            ...extensions.filter(
              (e) => extensionName(e) !== extensionName(p.extension),
            ),
            p.extension,
          ];
        } else
          extensions = extensions.filter((e) => extensionName(e) !== p.name);
        const sealed = await sealSessionExtensions(
          extensions,
          await sessionMcpServers(s),
        );
        await this.store.update((state) => {
          Object.assign(
            state.sessions.find((x) => x.id === s.id),
            sealed,
          );
        });
        this.initialized.delete(s.id);
        await this.driver.invalidateMcpServers?.([name.endsWith("add") ? extensionName(p.extension) : p.name]);
        return {};
      }
      case "codepro/run/get":
        return this.runs.get(p);
      case "codepro/run/control":
        return this.runs.control(p);
      case "codepro/effects/resolve":
        return this.runs.resolveEffect(p);
      case "session/project/update": {
        this.session(p.sessionId);
        await this.store.update((state) => {
          state.sessions.find((s) => s.id === p.sessionId).projectId =
            p.projectId ?? null;
        });
        return {};
      }
      case "tools/list": {
        const available = await this.readCurrentExtensions(p.sessionId, async (s, resolvedExtensions) => {
          await this.ensureSession(s);
          const tools = [];
          for (const t of await this.driver.listTools(s.id))
            if (await toolEnabled(s, this.settings, t.name, resolvedExtensions)) tools.push(t);
          return tools;
        });
        return {
          tools: available
            .filter(
              (t) =>
                !p.extensionName ||
                publicToolName(t.name).startsWith(p.extensionName + "__"),
            )
            .map((t) => ({
              name: publicToolName(t.name),
              description: t.description ?? "",
              parameters: Object.keys(
                t.parameters?.properties ?? t.inputSchema?.properties ?? {},
              ),
              inputSchema: t.parameters ?? t.inputSchema ?? {},
              ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
              permission:
                this.store.read(["toolPermissions"]).toolPermissions?.[publicToolName(t.name)] ??
                this.store.read(["toolPermissions"]).toolPermissions?.[t.name] ??
                "ask_before",
            })),
        };
      }
      case "tools/call": {
        const s = this.session(p.sessionId);
        await this.ensureSession(s);
        if (s.type === "code_pro")
          await this.workspaces.validateSession(s.id, s.cwd);
        this.assertSessionAvailable(s.id);
        const recordHistory = !GIT_READ_TOOL_NAMES.includes(harnessToolName(p.name));
        const writer = recordHistory ? await this.journal?.begin({ sessionId: s.id }) : undefined;
        const updates = [];
        const created = Math.floor(Date.now() / 1000);
        const publish = async (update) => {
          await writer?.append(update);
          updates.push(update);
          connection.notify("session/update", { sessionId: s.id, update });
        };
        let result;
        let internalControl = false;
        try {
          result = await this.driver.callTool(
            s.id,
            harnessToolName(p.name),
            p.arguments ?? {},
            {
              onEvent: async (event) => {
                await this.recordCapabilityUsage(s, event);
                if (event.internalControl === true) internalControl = true;
                if (!recordHistory || internalControl) return;
                const metadata = { directToolCall: true, messageId: `direct-tool:${event.id}`, created };
                const meta = { goose: { ...metadata, ...(event.mcpApp ? { mcpApp: event.mcpApp } : {}) } };
                if (event.type === "tool_call") await publish({
                  sessionUpdate: "tool_call", toolCallId: event.id, title: event.name,
                  status: "in_progress", kind: "execute", rawInput: event.arguments ?? {}, _meta: meta,
                });
                if (event.type === "tool_result") await publish(toolResultUpdate(event, metadata));
              },
              onPermission: async (tool) => {
                // The existing Git panel polls these bounded, read-only tools itself.
                // Model-initiated calls still use the normal per-action approval path.
                if (GIT_READ_TOOL_NAMES.includes(tool.name)) {
                  const permissions = this.store.read(["toolPermissions"]).toolPermissions ?? {};
                  return (
                    (await toolEnabled(s, this.settings, tool.name)) &&
                    (permissions[publicToolName(tool.name)] ??
                      permissions[tool.name]) !== "never_allow"
                  );
                }
                return this.approveTool(
                  s,
                  tool,
                  connection,
                  new AbortController().signal,
                  true,
                );
              },
            },
          );
        } finally {
          if (writer) await writer.finalize();
          else if (updates.length) await this.store.update((state) => {
            const saved = state.sessions.find((item) => item.id === s.id);
            saved.updates.push(...updates);
            saved.messageCount += 1;
            saved.updatedAt = new Date().toISOString();
          });
        }
        return result.mcpResult
          ? { ...result.mcpResult, isError: Boolean(result.isError) }
          : {
              content: result.content,
              structuredContent: result.value ?? result.structuredContent,
              isError: Boolean(result.isError),
            };
      }
      case "session/system-prompt/set": {
        const s = this.session(p.sessionId);
        if (this.active.has(s.id))
          throw invalid("Stop execution before changing its instructions");
        if (
          typeof p.text !== "string" ||
          !["set", "append"].includes(p.mode ?? "append")
        )
          throw invalid("Invalid system prompt");
        await this.store.update((state) => {
          const session = state.sessions.find((x) => x.id === s.id);
          session.instructions ??= {};
          const mode = p.mode ?? "append",
            key = p.key ?? "default";
          if (session.instructions[key]?.mode === mode)
            delete session.instructions[key];
          const entryKey = JSON.stringify([mode, key]);
          delete session.instructions[entryKey];
          if (p.text) session.instructions[entryKey] = { text: p.text, mode };
        });
        this.initialized.delete(s.id);
        return {};
      }
      case "session/steer": {
        const s = this.session(p.sessionId);
        const active = this.active.get(s.id);
        if (!active?.run || active.run.runId !== p.expectedRunId)
          throw invalid("Run changed or is no longer active");
        const prepared = await this.prepareModelContent(
          s,
          harnessPrompt(p.prompt),
          active.controller.signal,
        );
        if (
          this.active.get(s.id) !== active ||
          active.controller.signal.aborted
        )
          throw invalid("Run ended before the input could be added");
        const messageId = randomUUID();
        await this.driver.steer(s.id, prepared.content, {
          requestId: messageId,
          signal: active.controller.signal,
        });
        const created = Math.floor(Date.now() / 1000);
        for (const content of p.prompt)
          await active.notify({
            sessionUpdate: "user_message_chunk",
            content,
            messageId,
            _meta: { goose: { messageId, created } },
          });
        active.userMessages.push(
          ...p.prompt.filter((c) => c.type === "text").map((c) => c.text),
        );
        return { runId: active.run.runId, messageId };
      }
      case "diagnostics/get": {
        const s = this.session(p.sessionId);
        return {
          report: {
            engine: "deepseek-harness",
            sessionId: s.id,
            active: this.active.has(s.id),
            run: this.runs.latest(s.id),
            cwd: s.cwd,
          },
        };
      }
      case "session/info":
        return { session: this.info(this.session(p.sessionId)) };
      case "session/rename":
      case "session/archive":
      case "session/unarchive": {
        this.session(p.sessionId);
        if (name === "session/rename") requireString(p.title, "title");
        if (name === "session/archive" && this.active.has(p.sessionId))
          throw invalid("Stop the active turn before archiving");
        await this.store.update((state) => {
          const s = state.sessions.find((s) => s.id === p.sessionId);
          if (name === "session/rename") {
            s.title = p.title.trim();
            s.userSetName = true;
          } else
            s.archivedAt =
              name === "session/archive" ? new Date().toISOString() : null;
          s.updatedAt = new Date().toISOString();
        });
        return {};
      }
      case "defaults/read":
        return this.store.read(["defaults"]).defaults;
      case "defaults/clear":
        await this.store.update(
          (s) => (s.defaults = { providerId: null, modelId: null }),
        );
        return {};
      case "defaults/save": {
        const provider = this.provider(p.providerId);
        if (!provider.models.includes(p.modelId))
          throw invalid("Select a model from the provider");
        await this.store.update(
          (s) =>
            (s.defaults = { providerId: p.providerId, modelId: p.modelId }),
        );
        return {};
      }
      case "providers/list":
        return {
          entries: this.store
            .read(['providers'])
            .providers.filter(
              (x) => !p.providerIds?.length || p.providerIds.includes(x.id),
            )
            .map(inventory),
        };
      case "providers/supported-models/list": {
        const provider = this.provider(p.providerId);
        return {
          providerId: p.providerId,
          models: await discover(provider, provider, { timeoutMs: 2000 }),
        };
      }
      case "providers/custom/discover-models":
        return {
          models: await discover(
            p,
            p.providerId ? this.provider(p.providerId) : undefined,
          ),
        };
      case "providers/custom/create":
        return saveProvider(this.store, p);
      case "providers/custom/update": {
        this.checkProviderMutation(p.providerId);
        const result = await saveProvider(this.store, p, true);
        this.initialized.clear();
        return result;
      }
      case "providers/custom/read": {
        return readProvider(this.provider(p.providerId));
      }
      case "providers/custom/delete": {
        this.checkProviderMutation(p.providerId);
        this.provider(p.providerId);
        await this.store.update((s) => {
          s.providers = s.providers.filter((x) => x.id !== p.providerId);
          if (s.defaults.providerId === p.providerId)
            s.defaults = { providerId: null, modelId: null };
        });
        this.initialized.clear();
        return { providerId: p.providerId, refresh: { started: [] } };
      }
      case "providers/canonical-model-info": {
        const provider = this.provider(p.provider);
        return { modelInfo: await resolvedModelInfo(provider, p.model) };
      }
      case "providers/inventory/refresh": {
        const providers = this.store.read(["providers"]).providers;
        const ids = p.providerIds?.length
          ? p.providerIds
          : providers.map((x) => x.id);
        const started = [];
        const skipped = [];
        for (const id of ids) {
          const provider = providers.find((x) => x.id === id);
          if (!provider) {
            skipped.push({ providerId: id, reason: "unknown_provider" });
            continue;
          }
          const models = await discover(provider, provider);
          await this.store.update((state) => {
            const saved = state.providers.find((x) => x.id === id);
            if (saved) saved.models = models;
          });
          started.push(id);
        }
        return { started, skipped };
      }
      case "preferences/read": {
        const s = this.store.read(["revision", "preferences"]);
        return {
          revision: s.revision,
          values: (p.keys?.length ? p.keys : preferenceKeys).map((key) => ({
            key,
            value: s.preferences[key] ?? null,
            isMutable: preferenceKeys.includes(key),
          })),
        };
      }
      case "preferences/save":
      case "preferences/remove": {
        await this.store.update((s) => {
          if (p.expectedRevision !== s.revision)
            throw invalid("Preferences changed; reload and retry", {
              code: "preference_revision_conflict",
              expectedRevision: p.expectedRevision,
              actualRevision: s.revision,
            });
          if (name.endsWith("save"))
            for (const { key, value } of p.values ?? []) {
              if (!preferenceKeys.includes(key))
                throw invalid("Unknown preference");
              validatePreference(key, value);
              s.preferences[key] = value;
            }
          else for (const key of p.keys ?? []) delete s.preferences[key];
          s.revision++;
        });
        this.initialized.clear();
        return {};
      }
      case "config/read": {
        const c = this.store.read(["config"]).config[p.key];
        return { value: c?.secret ? "********" : (c?.value ?? null) };
      }
      case "config/read-all": {
        return {
          config: Object.fromEntries(
            Object.entries(this.store.read(["config"]).config)
              .filter(([, v]) => !v.secret)
              .map(([k, v]) => [k, v.value]),
          ),
          blockedMutationKeys: [],
        };
      }
      case "config/upsert": {
        requireString(p.key, "key");
        if (p.key === COMMON_QUERY_KEY) validateQuerySettings(p.value, p.isSecret);
        if (p.key === SUBAGENT_TEMPLATES_KEY) p.value = validateSubagentTemplates(p.value, this.store.read(["providers"]).providers, p.isSecret);
        const entry = p.isSecret
          ? { secret: await protectSecret(String(p.value)) }
          : { value: p.value };
        await this.store.update((s) => (s.config[p.key] = entry));
        // Query metadata reads the store per invocation; keep its live MCP scope.
        if (p.key !== COMMON_QUERY_KEY) this.initialized.clear();
        return {};
      }
      case "config/remove":
        await this.store.update((s) => delete s.config[p.key]);
        if (p.key !== COMMON_QUERY_KEY) this.initialized.clear();
        return {};
      case "config/extensions/list":
        return {
          extensions: this.store.read(["extensions"]).extensions,
          warnings: [
            "Preview: legacy builtin extensions are not yet connected to the CodeBuddy runtime.",
          ],
        };
      case "config/extensions/add":
      case "config/extensions/set-enabled":
        throw unsupported("legacy extension activation");
      case "session/extensions/list":
        return {
          extensions: await this.readCurrentExtensions(p.sessionId, (_s, snapshot) => snapshot.selected.map((e) => e.extension)),
        };
      case "codepro/model-routing/read":
        return { config: null };
      case "codepro/model-routing/save":
        throw unsupported("advanced agent model routing");
      default:
        throw unsupported(method);
    }
  }
  async prompt(p, connection) {
    const s = this.session(p.sessionId);
    if (this.sessionMutations.has(s.id))
      throw invalid("Wait for the session change to finish");
    if (s.readonlyHistory)
      throw invalid(
        "This imported history is read-only; start a new task to continue work",
      );
    const content = harnessPrompt(p.prompt);
    const manualCompact = p.prompt.length === 1 && p.prompt[0].type === "text" && p.prompt[0].text.trim() === "/compact";
    if (s.archivedAt) throw invalid("Unarchive the session before continuing");
    this.assertSessionAvailable(s.id);
    if (this.active.has(s.id))
      throw invalid("A prompt is already running for this session");
    const controller = new AbortController();
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const updates = [];
    const usageUpdates = [];
    const promptScope = randomUUID();
    const replay = { turnId: promptScope, users: [], updates, usageUpdates };
    const promptEntry = {
      controller,
      connection,
      done,
      replay,
      userMessages: [
        ...(s.updates ?? [])
          .filter(
            (u) =>
              u.sessionUpdate === "user_message_chunk" &&
              u.content?.type === "text",
          )
          .map((u) => u.content.text),
        ...p.prompt.filter((c) => c.type === "text").map((c) => c.text),
      ],
    };
    this.active.set(s.id, promptEntry);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        if (this.active.get(s.id) !== promptEntry) return;
        this.active.delete(s.id);
        // No await may separate deletion from this existing live-state fact:
        // observers without the original prompt RPC also need the release.
        for (const c of this.connections) {
          if (c.background || !c.sessionIds?.has(s.id)) continue;
          try {
            c.notify("session/update", {
              sessionId: s.id,
              update: { sessionUpdate: "session_info_update", _meta: { goose: { activeRunId: null } } },
            });
          } catch { /* A detached observer must not mask the prompt's outcome. */ }
        }
      } finally { finish(); }
    };
    let validated = false, validationError;
    try {
      if (s.type === "code_pro") await this.workspaces.validateSession(s.id, s.cwd);
      validated = true;
    } catch (error) {
      validationError = error;
    } finally {
      if (!validated || controller.signal.aborted) release();
    }
    if (controller.signal.aborted) return { stopReason: "cancelled" };
    if (!validated) throw validationError;
    let messageId = randomUUID();
    let afterToolResult = false;
    let lastResponseTextAvailable;
    const created = Math.floor(Date.now() / 1000);
    let writer;
    const notify = async (update) => {
      await writer?.append(update);
      updates.push(update);
      connection.notify("session/update", { sessionId: s.id, update });
    };
    const userId = p._meta?.["codeagentpro/source-message-id"] ?? randomUUID();
    const users = p.prompt.map((content) => ({
      sessionUpdate: "user_message_chunk",
      content,
      messageId: userId,
      _meta: { goose: { messageId: userId, created } },
    }));
    let promptError;
    let result;
    try {
      writer = await this.journal?.begin({
        sessionId: s.id,
        turnId: promptScope,
        users,
        title: p.prompt
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(" ")
          .slice(0, 80),
      });
      // The frozen renderer needs this acknowledgement before remote services
      // become ready, so sending a message is visible immediately.
      replay.users = users;
      for (const update of users)
        connection.notify("session/update", { sessionId: s.id, update });
      controller.signal.throwIfAborted();
      await this.ensureSession(s);
      controller.signal.throwIfAborted();
      const active = this.active.get(s.id);
      active.driverStarted = true;
      const prepared = await this.prepareModelContent(
        s,
        content,
        controller.signal,
      );
      if (s.type === "code_pro" && !manualCompact) {
        let run = this.runs.latest(s.id);
        if (
          !run ||
          ["completed", "cancelled", "failed", "fatal", "exhausted"].includes(
            run.state,
          )
        )
          run = await this.runs.create({
            sessionId: s.id,
            goal: p.prompt
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
            sourceMessageId: userId,
            executionOwner: "harness",
          });
        if (p._meta?.resumeRunId && p._meta.resumeRunId !== run.runId)
          throw invalid("Run changed before resume");
        active.run = run;
        const attempt = await this.runs.beginAttempt({
          sessionId: s.id,
          runId: run.runId,
          sourceMessageId: userId,
          executionOwner: "harness",
        });
        active.attemptId = attempt.attemptId;
        active.dispatched = new Map();
      }
      active.writer = writer;
      active.notify = notify;
      active.driverStarted = true;
      const nativeGoal = p._meta?.resumeRunId ? await this.driver.getGoal?.(s.id) : null;
      const projectContext = contextUpdates({ sessionId: s.id, runId: active.run?.runId, signal: controller.signal });
      const internalToolCalls = new Set();
      const projectWorkStatus = workStatusUpdates({
        sessionId: s.nativeSessionId ?? s.id, sourceMessageId: userId,
        runId: active.run?.runId ?? promptScope, signal: controller.signal,
      });
      const callbacks = {
        signal: controller.signal,
        requestId: userId,
        onUserQuestions: async ({ questions, signal }) => {
          const properties = Object.fromEntries(questions.map((q, i) => [`answer_${i}`, {
            type: 'string', title: q.question,
            description: [q.detail, q.options?.map(o => `${o.label}${o.description ? `: ${o.description}` : ''}`).join('; ')].filter(Boolean).join('\n'),
          }]));
          const reply = await connection.ask('elicitation/create', {
            sessionId: s.id, mode: 'form', message: questions.map(q => q.question).join('\n'),
            requestedSchema: { type: 'object', properties, required: Object.keys(properties) },
          }, signal ?? controller.signal);
          if (reply?.action !== 'accept') throw new Error('User question was cancelled or expired without an answer');
          return { answers: questions.map((q, i) => {
            const answer = reply.content?.[`answer_${i}`];
            if (typeof answer !== 'string') throw new Error('Missing user question answer');
            const selected = (q.options ?? []).some(o => o.label === answer) ? [answer] : [];
            return { id: q.id, selected, ...(selected.length ? {} : { custom: answer }) };
          }) };
        },
        ...(["paused", "blocked"].includes(nativeGoal?.phase)
          ? { resumeGoal: { goalId: nativeGoal.id, revision: nativeGoal.revision } }
          : {}),
        onPermission: async (tool) => {
          const approved = await this.approveTool(
            s,
            tool,
            connection,
            controller.signal,
          );
          if (approved && active.run) {
            await this.runs.recordToolStart({
              sessionId: s.id,
              runId: active.run.runId,
              attemptId: active.attemptId,
              callId:
                tool.sessionId && tool.sessionId !== s.id
                  ? `${tool.sessionId}:${tool.id}`
                  : tool.id,
              name: tool.name,
              internal: tool.delegated === true || tool.delegationControl === true,
            });
            active.dispatched.set(
              JSON.stringify([tool.sessionId ?? s.id, tool.id]),
              { ...tool },
            );
          }
          return approved;
        },
        onEvent: async (event) => {
          await this.recordCapabilityUsage(s, event);
          // Do not persist these observations or turn them into chat messages.
          // Child receipts remain filtered below; only their live wait target is shared.
          for (const update of projectWorkStatus(event))
            connection.notify("_goose/unstable/session/update", { sessionId: s.id, update });
          for (const update of projectContext(event)) {
            if (event.source !== 'streaming_estimate') {
              await writer?.appendUsage(update);
              usageUpdates.push(update);
            }
            connection.notify("_goose/unstable/session/update", { sessionId: s.id, update });
          }
          if (event.type === "harness_event" && active.run &&
              (!["todo/write", "turn/start", "goal/change"].includes(event.event.type) || !event.sessionId || event.sessionId === s.id))
            await this.runs.recordHarnessEvent({
              sessionId: s.id, runId: active.run.runId,
              attemptId: active.attemptId,
              nativeSessionId: event.sessionId ?? s.id,
              event: event.event,
            });
          if (["subagent_start", "subagent_end"].includes(event.type) && active.run)
            await this.runs.recordHarnessEvent({
              sessionId: s.id, runId: active.run.runId, attemptId: active.attemptId,
              nativeSessionId: event.sessionId ?? s.id,
              event: {
                type: event.type === "subagent_start" ? "subagent/start" : "subagent/end",
                data: { ...event, id: event.childSessionId ?? event.id },
              },
            });
          const dispatchKey = JSON.stringify([
            event.sessionId ?? s.id,
            event.id,
          ]);
          if (
            event.type === "tool_result" &&
            active.run &&
            active.dispatched.has(dispatchKey)
          ) {
            const tool = active.dispatched.get(dispatchKey);
            const details = event.structuredContent ?? {};
            const exitCode = details.exitCode ?? details.exit_code;
            const task = this.runs
              .context({ sessionId: s.id, runId: active.run.runId })
              .tasks.find((t) => t.taskId === tool.taskId);
            const isCommand = typeof tool.arguments?.command === "string";
            const uncertain =
              ["job", "background"].includes(details.kind) ||
              details.background === true ||
              details.aborted ||
              details.timedOut ||
              (Object.hasOwn(details, "exitCode") &&
                details.exitCode == null) ||
              (isCommand && !Number.isInteger(exitCode) && !event.isError);
            const kind =
              isCommand &&
              Number.isInteger(exitCode) &&
              task?.kind === "verification"
                ? "verification"
                : isCommand
                  ? "command"
                  : [
                        "write",
                        "edit",
                        "write_file",
                        "edit_file",
                        "apply_patch",
                      ].includes(tool.name)
                    ? "write"
                    : ["read", "read_file"].includes(tool.name)
                      ? "read"
                      : "tool";
            const toolPath = tool.arguments?.file_path ?? tool.arguments?.path;
            await this.runs.recordToolResult({
              sessionId: s.id,
              runId: active.run.runId,
              attemptId: active.attemptId,
              callId:
                event.sessionId && event.sessionId !== s.id
                  ? `${event.sessionId}:${event.id}`
                  : event.id,
              outcome: uncertain
                ? "unknown"
                : event.isError ||
                    (Number.isInteger(exitCode) && exitCode !== 0)
                  ? "failed"
                  : "succeeded",
              kind,
              ...(typeof toolPath === "string"
                ? { path: path.resolve(s.cwd, toolPath) }
                : {}),
              ...(Number.isInteger(exitCode) ? { exitCode } : {}),
              ...(isCommand ? { command: tool.arguments.command } : {}),
              artifactRef: `harness-tool:${event.id}`,
            });
            active.dispatched.delete(dispatchKey);
          }
          if (event.sessionId && event.sessionId !== s.id) return;
          if (event.type === 'assistant_committed' && typeof event.hasText === 'boolean')
            lastResponseTextAvailable = event.hasText;
          // Native logs retain every receipt. Main-chat projection omits
          // delegation plumbing; child tools remain in their own transcript.
          if (event.type === 'tool_call' && event.internalControl === true) internalToolCalls.add(event.id);
          const internalControl = event.internalControl === true ||
            (event.type === 'tool_result' && internalToolCalls.has(event.id));
          if (event.type === 'tool_result') internalToolCalls.delete(event.id);
          if (internalControl) return;

          if (
            event.type === "assistant_start" &&
            typeof event.attemptId === "string"
          ) {
            messageId = `harness-stream:${promptScope}:${event.attemptId}`;
            afterToolResult = false;
          }
          if (
            ["text_delta", "thinking_delta", "tool_call"].includes(event.type)
          ) {
            if (typeof event.messageId === "string")
              messageId = `harness-message:${promptScope}:${event.messageId}`;
            else if (afterToolResult) messageId = randomUUID();
            afterToolResult = false;
          }
          if (event.type === "text_delta" || event.type === "thinking_delta")
            await notify({
              sessionUpdate:
                event.type === "text_delta"
                  ? "agent_message_chunk"
                  : "agent_thought_chunk",
              content: { type: "text", text: event.text },
              messageId,
              _meta: { goose: { messageId, created } },
            });
          else if (event.type === "tool_call") {
            await notify({
              sessionUpdate: "tool_call",
              toolCallId: event.id,
              title: event.name,
              kind: "execute",
              status: "in_progress",
              rawInput: event.arguments ?? {},
              _meta: {
                goose: {
                  messageId,
                  created,
                  toolCall: { toolName: event.name, extensionName: "harness" },
                  ...(event.mcpApp ? { mcpApp: event.mcpApp } : {}),
                },
              },
            });
          } else if (event.type === "tool_result") {
            await notify(toolResultUpdate(event, {
              messageId: event.messageId ?? randomUUID(),
              created,
            }));
            afterToolResult = true;
          } else if (event.type === "usage") {
            const usage = {};
            for (const key of [
              "inputTokens",
              "outputTokens",
              "totalTokens",
              "cacheReadTokens",
              "cacheWriteTokens",
            ])
              if (Number.isFinite(event[key])) usage[key] = event[key];
            if (Object.keys(usage).length) {
              const update = {
                sessionUpdate: "message_usage",
                messageId,
                usage,
              };
              await writer?.appendUsage(update);
              usageUpdates.push(update);
              connection.notify("_goose/unstable/session/update", {
                sessionId: s.id,
                update,
              });
            }
          }
        },
      };
      if (manualCompact) {
        const compacted = await this.driver.compact(s.id, callbacks);
        if (!compacted) await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "当前上下文没有可压缩的历史。" } });
        result = { stopReason: "end_turn" };
      } else result = await this.driver.prompt(s.id, prepared.content, callbacks);
    } catch (error) {
      promptError = error;
    } finally {
      try {
        const active = this.active.get(s.id);
        if (active?.run && active.attemptId)
          await this.runs.finishHarnessAttempt({
            sessionId: s.id,
            runId: active.run.runId,
            attemptId: active.attemptId,
            result,
            error: promptError,
            aborted: controller.signal.aborted,
          });
        if (active?.run && active.attemptId) {
          const context = this.runs.context({
            sessionId: s.id,
            runId: active.run.runId,
          });
          const completed = context.state === "completed";
          const uncertainEffects = (context.recovery?.uncertainEffects ?? 0) + (context.recovery?.pendingEffects ?? 0);
          // Legacy verification receipts remain historical evidence; they cannot
          // certify work performed by a subsequent native Harness attempt.
          const acceptanceUnverified = uncertainEffects > 0 ||
            context.completionKind === "harness_goal" ||
            context.receipts.some((r) => r.kind === "write" || r.kind === "command");
          const limitations = completed ? [] : [context.lastReason ?? "Task requires continuation"];
          if (acceptanceUnverified)
            limitations.push("Turn completion does not assert independent acceptance; inspect the recorded tool results.");
          if (uncertainEffects > 0)
            limitations.push("Some tool effects still require inspection before retrying them.");
          const data = {
            schema_version: 1,
            session_id: s.id,
            run_id: context.runId,
            terminal_message_id: `terminal:${active.attemptId}`,
            source_user_message_id: userId,
            status: completed
              ? "completed"
              : context.state === "cancelled"
                ? "cancelled"
                : context.state === "failed"
                  ? "failed"
                : "interrupted",
            visible_text_available: updates.some(
              (u) => u.sessionUpdate === "agent_message_chunk",
            ),
            ...(typeof lastResponseTextAvailable === 'boolean'
              ? { last_response_text_available: lastResponseTextAvailable }
              : {}),
            tool_action_count: context.receipts.length,
            copy_artifact_ref: null,
            finished_at: new Date().toISOString(),
            checkpoint_id: null,
            retry_strategy: "not_available",
            report: {
              outcome: completed
                ? "completed"
                : context.state === "cancelled"
                  ? "cancelled"
                  : context.state === "failed"
                    ? "failed"
                  : context.state === "waiting_for_user"
                    ? "waiting_for_user"
                    : "paused",
              classification_counts: {
                confirmed_bug: 0,
                test_failure: context.receipts.filter(
                  (r) => r.kind === "verification" && r.outcome === "failed",
                ).length,
                environment_problem: 0,
                codepro_incomplete: completed ? 0 : 1,
                unverified: !completed || acceptanceUnverified ? 1 : 0,
              },
              changed_files: [
                ...new Set(
                  context.receipts
                    .filter(
                      (r) =>
                        r.kind === "write" &&
                        r.outcome === "succeeded" &&
                        r.path,
                    )
                    .map((r) => r.path),
                ),
              ],
              verification_summary: context.receipts
                .filter((r) => r.kind === "verification")
                .map((r) => ({
                  task_id: r.taskId ?? "",
                  verdict:
                    r.outcome === "succeeded"
                      ? "passed"
                      : r.outcome === "failed"
                        ? "failed"
                        : "unverified",
                  command: r.command,
                  exit_code: r.exitCode,
                  evidence_ref: r.artifactRef,
                })),
              limitations,
              recovery_action: completed ? "none" : "ask_user",
            },
          };
          if (completed && context.completionKind === "harness_turn" &&
              context.receipts.length === 0 && context.tasks.length === 0 &&
              context.nativeWorkers.length === 0 && uncertainEffects === 0)
            delete data.report;
          const update = {
            sessionUpdate: "status_message",
            status: {
              type: "progress",
              message: completed ? "" : (context.lastReason ?? "Task paused"),
              data,
            },
          };
          await writer?.appendUsage(update);
          usageUpdates.push(update);
          for (const c of new Set([connection, ...this.connections])) {
            if (c !== connection && (c.background || !c.sessionIds?.has(s.id))) continue;
            try { c.notify(prefix + "session/update", { sessionId: s.id, update }); }
            catch { /* The original durable terminal remains authoritative. */ }
          }
        }
        if (writer) await writer.finalize();
        else
          await this.store.update((state) => {
            const saved = state.sessions.find((x) => x.id === s.id);
            saved.updates.push(...users, ...updates);
            saved.usageUpdates ??= [];
            saved.usageUpdates.push(...usageUpdates);
            saved.messageCount += 1 + (updates.length ? 1 : 0);
            saved.updatedAt = new Date().toISOString();
            if (!saved.userSetName && saved.title === "New Session")
              saved.title = p.prompt
                .map((c) => c.text)
                .join(" ")
                .slice(0, 80);
          });
        const saved = this.session(s.id);
        connection.notify("session/update", {
          sessionId: s.id,
          update: {
            sessionUpdate: "session_info_update",
            title: saved.title,
            updatedAt: saved.updatedAt,
          },
        });
      } finally {
        release();
      }
    }
    if (controller.signal.aborted) return { stopReason: "cancelled" };
    if (promptError) throw promptError;
    return { stopReason: result?.stopReason ?? "end_turn" };
  }
  async close() {
    closeMediaStreams(this.store.directory);
    this.closing = true;
    await this.transcription.close();
    await this.reviews.close();
    const active = [...this.active.entries()];
    for (const [, turn] of active) turn.controller.abort();
    await this.vision.close();
    await Promise.allSettled(active.map(([id]) => this.driver.cancel(id)));
    await Promise.allSettled(active.map(([, turn]) => turn.done));
    await Promise.allSettled(this.initializing.values());
    await this.schedules?.close();
    await Promise.allSettled(
      [...this.sessionMutations.values()].map((change) => change.done),
    );
    await this.driver.close();
    await this.workspaces.close();
    await this.library?.close();
    await this.store.flush();
  }
}
