import {
  DEFAULT_GOOSE_MCP_HOST_CAPABILITIES,
  GooseClient,
  type GooseClientCallbacks,
} from '@aaif/goose-sdk';
import { PROTOCOL_VERSION, type InitializeResponse } from '@agentclientprotocol/sdk';
import packageJson from '../../package.json';
import { GOOSE_SERVE_EXITED_USER_MESSAGE } from '../gooseServeLeaseRegistry';
import {
  handleAcpGooseSessionNotification,
  handleAcpSessionNotification,
} from './chatNotifications';
import { createWebSocketStream } from './createWebSocketStream';
import { requestAcpElicitation } from './elicitationRequests';
import { requestAcpPermission } from './permissionRequests';
import { requestAcpRecipeParams } from './recipeParamRequests';
import { requestSkillManagementConfirmation } from './skillConfirmationRequests';
import { controlWorkspaceBrowser } from '../workspace-panel/browserControlClient';
import { hasDirectToolOrigin } from './adapter/shared';
import {
  applyCodeProRunNotification,
  applyCodeProRunSnapshot,
  listObservedCodeProRuns,
} from '../codepro/runProjection';

type AcpConnection = {
  client: GooseClient;
  stream: ReturnType<typeof createWebSocketStream>;
  initializeResponse: InitializeResponse;
  pendingRequests: AbortController;
};

type AcpRecoveryListener = (recovering: boolean) => void;

const ACP_INITIALIZE_TIMEOUT_MS = 10_000;
const ACP_RECONNECT_BASE_DELAY_MS = 500;
const ACP_RECONNECT_MAX_DELAY_MS = 30_000;

let currentConnection: AcpConnection | null = null;
let pendingConnection: Promise<AcpConnection> | null = null;
let connectionGeneration = 0;
let currentControlConnection: AcpConnection | null = null;
let pendingControlConnection: Promise<AcpConnection> | null = null;
let controlConnectionGeneration = 0;
let recovering = false;
const recoveryListeners = new Set<AcpRecoveryListener>();

export async function getAcpClient(): Promise<GooseClient> {
  return (await getConnection()).client;
}

/**
 * CodePro run snapshots must not share the long-lived session/prompt request's
 * transport. Some ACP servers serialize request dispatch on one connection, so
 * run/get would otherwise wait behind the prompt and the live UI would remain
 * on its first projection until the whole task finished.
 */
export async function getAcpControlClient(): Promise<GooseClient> {
  return (await getControlConnection()).client;
}

export async function getAcpInitializeResponse(): Promise<InitializeResponse> {
  return (await getConnection()).initializeResponse;
}

export function reconnectAcpAfterSystemResume(): void {
  resetAcpControlConnection();
  recoverConnection(true);
}

export function isAcpRecovering(): boolean {
  return recovering;
}

export function subscribeToAcpRecovery(listener: AcpRecoveryListener): () => void {
  recoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
  };
}

function setRecovering(nextRecovering: boolean): void {
  if (recovering === nextRecovering) {
    return;
  }

  recovering = nextRecovering;
  for (const listener of recoveryListeners) {
    listener(recovering);
  }
}

function recoverConnection(immediate: boolean): void {
  if (!currentConnection && !pendingConnection) {
    return;
  }

  setRecovering(true);
  const previousConnection = currentConnection;
  connectionGeneration += 1;
  currentConnection = null;
  pendingConnection = null;
  previousConnection?.pendingRequests.abort();
  previousConnection?.stream.close();

  const generation = connectionGeneration;
  const recoveryAttempt = immediate
    ? openConnection(generation).catch((error) => {
        if (generation !== connectionGeneration || isGooseServeExitedError(error)) {
          throw error;
        }
        return retryWithBackoff(generation);
      })
    : retryWithBackoff(generation);
  pendingConnection = recoveryAttempt;
  void recoveryAttempt.then(
    () => {
      if (generation === connectionGeneration) {
        setRecovering(false);
      }
    },
    () => {
      if (generation === connectionGeneration) {
        setRecovering(false);
      }
    }
  );
}

async function getConnection(): Promise<AcpConnection> {
  if (currentConnection) {
    return currentConnection;
  }

  if (!pendingConnection) {
    const generation = connectionGeneration;
    let connectionAttempt: Promise<AcpConnection>;
    connectionAttempt = openConnection(generation).catch((error) => {
      if (generation !== connectionGeneration || isGooseServeExitedError(error)) {
        throw error;
      }
      setRecovering(true);
      return retryWithBackoff(generation);
    });
    pendingConnection = connectionAttempt;
    void connectionAttempt.then(
      () => {
        if (generation === connectionGeneration) {
          setRecovering(false);
        }
      },
      () => {
        if (pendingConnection === connectionAttempt) {
          pendingConnection = null;
        }
        if (generation === connectionGeneration) {
          setRecovering(false);
        }
      }
    );
  }

  return pendingConnection;
}

export function resetAcpControlConnection(): void {
  const previousConnection = currentControlConnection;
  controlConnectionGeneration += 1;
  currentControlConnection = null;
  pendingControlConnection = null;
  previousConnection?.pendingRequests.abort();
  previousConnection?.stream.close();
}

async function getControlConnection(): Promise<AcpConnection> {
  if (currentControlConnection) {
    return currentControlConnection;
  }

  if (!pendingControlConnection) {
    const generation = controlConnectionGeneration;
    let connectionAttempt: Promise<AcpConnection>;
    connectionAttempt = openControlConnection(generation).catch((error) => {
      if (pendingControlConnection === connectionAttempt) {
        pendingControlConnection = null;
      }
      throw error;
    });
    pendingControlConnection = connectionAttempt;
  }

  return pendingControlConnection;
}

async function openConnection(generation: number): Promise<AcpConnection> {
  const wsUrl = await window.electron.getAcpUrl();
  if (!wsUrl) {
    throw new Error('ACP URL is not available');
  }

  const stream = createWebSocketStream(wsUrl);
  const pendingRequests = new AbortController();
  const client = new GooseClient(createClientCallbacks(pendingRequests.signal), stream);

  try {
    const initializeResponse = await initializeAcpClient(client);

    if (generation !== connectionGeneration) {
      throw new Error('ACP connection attempt is no longer current');
    }

    const connection = { client, stream, initializeResponse, pendingRequests };
    currentConnection = connection;
    void refreshObservedCodeProRuns(client);
    const handleClose = () => {
      pendingRequests.abort();
      if (currentConnection === connection) {
        recoverConnection(false);
      }
    };
    connection.client.closed.then(handleClose, handleClose);
    return connection;
  } catch (error) {
    pendingRequests.abort();
    stream.close();
    throw error;
  }
}

async function openControlConnection(generation: number): Promise<AcpConnection> {
  const wsUrl = await window.electron.getAcpUrl();
  if (!wsUrl) {
    throw new Error('ACP URL is not available');
  }

  const stream = createWebSocketStream(wsUrl);
  const pendingRequests = new AbortController();
  const client = new GooseClient(createClientCallbacks(pendingRequests.signal, true), stream);

  try {
    const initializeResponse = await initializeAcpClient(client);
    if (generation !== controlConnectionGeneration) {
      throw new Error('ACP control connection attempt is no longer current');
    }

    const connection = { client, stream, initializeResponse, pendingRequests };
    currentControlConnection = connection;
    const handleClose = () => {
      pendingRequests.abort();
      if (currentControlConnection === connection) {
        controlConnectionGeneration += 1;
        currentControlConnection = null;
        pendingControlConnection = null;
      }
    };
    connection.client.closed.then(handleClose, handleClose);
    return connection;
  } catch (error) {
    pendingRequests.abort();
    stream.close();
    throw error;
  }
}

function initializeAcpClient(client: GooseClient): Promise<InitializeResponse> {
  return withTimeout(
    client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      _meta: {
        'goose/useLoginShellPath': true,
      },
      clientCapabilities: {
        elicitation: { form: {} },
        _meta: {
          goose: {
            mcpHostCapabilities: DEFAULT_GOOSE_MCP_HOST_CAPABILITIES,
            customNotifications: true,
            projectContainers: 1,
            workspaceConfirmationRefresh: 1,
            recipeParameterRequests: true,
            businessSessionApproval: 1,
          },
        },
      },
      clientInfo: {
        name: packageJson.name,
        version: packageJson.version,
      },
    }),
    ACP_INITIALIZE_TIMEOUT_MS,
    `ACP initialize timed out after ${ACP_INITIALIZE_TIMEOUT_MS}ms`
  );
}

async function retryWithBackoff(generation: number): Promise<AcpConnection> {
  for (let attempt = 0; generation === connectionGeneration; attempt += 1) {
    const maximumDelay = Math.min(
      ACP_RECONNECT_MAX_DELAY_MS,
      ACP_RECONNECT_BASE_DELAY_MS * 2 ** attempt
    );
    await delay(Math.floor(Math.random() * maximumDelay));

    if (generation !== connectionGeneration) {
      break;
    }

    try {
      return await openConnection(generation);
    } catch (error) {
      if (generation !== connectionGeneration || isGooseServeExitedError(error)) {
        throw error;
      }
    }
  }

  throw new Error('ACP connection attempt is no longer current');
}

function isGooseServeExitedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(GOOSE_SERVE_EXITED_USER_MESSAGE);
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createClientCallbacks(
  signal: AbortController['signal'],
  controlOnly = false
): () => GooseClientCallbacks {
  return () => ({
    extMethod: async (method, params) => {
      if (method === '_codebuddy/browser/control') return controlWorkspaceBrowser(params, signal);
      throw new Error(`Unhandled desktop request: ${method}`);
    },
    requestPermission: (request) => requestAcpPermission(request, signal),
    unstable_createElicitation: (request) => requestAcpElicitation(request, signal),
    // A form can only answer the transport which requested it. A replacement
    // connection must never leave an obsolete form offering a dead submit.
    unstable_sessionRecipeRequestParams: (request) => requestAcpRecipeParams(request, signal),
    unstable_skillsManageRequestConfirmation: requestSkillManagementConfirmation,
    // Background schedules broadcast to both transports. Only the chat
    // transport projects them; direct Git/tool calls reply on the control one.
    sessionUpdate: async (notification) => {
      if (!controlOnly || hasDirectToolOrigin(notification.update._meta))
        await handleAcpSessionNotification(notification, signal);
    },
    unstable_sessionUpdate: async (notification) => {
      if (!controlOnly) await handleAcpGooseSessionNotification(notification);
    },
    unstable_codeproRunUpdate: async (notification) => {
      try {
        applyCodeProRunNotification(notification);
      } catch (error) {
        console.error('Rejected invalid CodePro run projection:', error);
      }
    },
  });
}

async function refreshObservedCodeProRuns(client: GooseClient): Promise<void> {
  await Promise.allSettled(
    listObservedCodeProRuns().map(async ({ sessionId, runId }) => {
      const response = await client.goose.codeproRunGet_unstable({
        schemaVersion: 1,
        sessionId,
        runId,
      });
      applyCodeProRunSnapshot(response.snapshot);
    })
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}
