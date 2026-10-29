import { getToolRequests, getToolResponses, type Message } from '../types/message';
import { presentedToolCall } from './codepro/CodeProToolContent';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface Observation {
  identity: string;
  window: string;
  aliases: string[];
  elements: Map<string, string>;
}

function observation(value: unknown): Observation | undefined {
  if (!record(value) || value.isError === true || !record(value.structuredContent)) return;
  const info = value.structuredContent.desktop_observation;
  if (
    !record(info) ||
    info.schema_version !== 1 ||
    !Number.isSafeInteger(info.pid) ||
    Number(info.pid) <= 0 ||
    !Number.isSafeInteger(info.window_handle) ||
    Number(info.window_handle) <= 0 ||
    typeof info.app_name !== 'string' ||
    typeof info.window_title !== 'string'
  )
    return;
  const identity = `window:${info.pid}:${info.window_handle}`;
  const elements = new Map<string, string>();
  // This is the native provider's UIA serialization, never assistant prose.
  // Keep only the element label; editable values and geometry are not titles.
  if (Array.isArray(value.content))
    for (const part of value.content) {
      if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
      for (const line of part.text.split(/\r?\n/)) {
        const match = /^\t+(\d+)\s+(.+)$/.exec(line);
        if (!match) continue;
        const label = match[2].split(/\s+(?:Value|Secondary Actions|Frame):/)[0].trim();
        if (label) elements.set(match[1], label);
      }
    }
  return {
    identity,
    window: info.window_title.trim() || info.app_name,
    aliases: [
      identity,
      info.app_name,
      String(info.pid),
      ...(typeof info.bundle_identifier === 'string' ? [info.bundle_identifier] : []),
    ],
    elements,
  };
}

/** Display-only targets, bound to the observation BEFORE each action. */
export function computerActionTargets(messages: Message[]): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  const snapshots = new Map<string, Observation>();
  const calls = new Map<string, { name: string; app: string }>();
  const browserCalls = new Map<string, { operation: string; id: string }>();
  const pages = new Map<string, { title: string; elements: Map<string, string> }>();
  for (const message of messages) {
    if (message.role === 'user' && message.content.some((part) => part.type === 'text')) {
      snapshots.clear();
      pages.clear();
    }
    for (const request of getToolRequests(message)) {
      const call = presentedToolCall(request);
      if (call?.name === 'browser_control') {
        const id = typeof call.arguments.id === 'string' ? call.arguments.id : '';
        const operation =
          typeof call.arguments.operation === 'string' ? call.arguments.operation : '';
        browserCalls.set(request.id, { id, operation });
        const page = pages.get(id);
        if (page) {
          const node = call.arguments.node;
          const element = typeof node === 'number' ? page.elements.get(String(node)) : undefined;
          targets.set(request.id, [page.title, element].filter(Boolean).join(' '));
        }
        continue;
      }
      if (!call || !/^(?:mcp__)?qwen_computer__/.test(call.name)) continue;
      const name = call.name.split('__').pop()!;
      const app = typeof call.arguments.app === 'string' ? call.arguments.app.toLowerCase() : '';
      calls.set(request.id, { name, app });
      const prior = snapshots.get(app);
      if (!prior) continue;
      const index = call.arguments.element_index;
      const element =
        typeof index === 'string' || typeof index === 'number'
          ? prior.elements.get(String(index))
          : undefined;
      const coordinates =
        typeof call.arguments.x === 'number' && typeof call.arguments.y === 'number'
          ? `(${call.arguments.x}, ${call.arguments.y})`
          : undefined;
      targets.set(request.id, [prior.window, element ?? coordinates].filter(Boolean).join(' '));
    }
    for (const response of getToolResponses(message)) {
      const browser = browserCalls.get(response.id);
      if (browser) {
        const value =
          response.toolResult.status === 'success' ? response.toolResult.value : undefined;
        const output = record(value) ? value.structuredContent : undefined;
        if (!record(output) || output.isError === true) {
          pages.delete(browser.id);
          continue;
        }
        if (browser.operation === 'open' && typeof output.id === 'string') {
          // An open receipt identifies a tab. Its first observation supplies
          // the title and node names; URL/query strings are never guessed labels.
          pages.set(output.id, { title: '', elements: new Map() });
        } else if (browser.operation === 'observe' && typeof output.title === 'string') {
          const elements = new Map<string, string>();
          if (Array.isArray(output.nodes))
            for (const node of output.nodes) {
              if (record(node) && typeof node.node === 'number' && typeof node.name === 'string')
                elements.set(String(node.node), node.name);
            }
          const title = output.title.replace(/·/g, ' ').replace(/\s+/g, ' ').trim();
          pages.set(browser.id, { title, elements });
          targets.set(response.id, title);
        } else if (browser.operation === 'close') {
          pages.delete(browser.id);
        } else if (['click', 'type', 'key'].includes(browser.operation)) {
          // A control action can replace the document or its node identities.
          const page = pages.get(browser.id);
          if (page) pages.set(browser.id, { ...page, elements: new Map() });
        }
        continue;
      }
      const call = calls.get(response.id);
      if (!call) continue;
      const snapshot =
        response.toolResult.status === 'success'
          ? observation(response.toolResult.value)
          : undefined;
      // An action can change focus or geometry; never carry another window's
      // indices through it. Missing/error observations provide no target facts.
      if (call.name !== 'get_app_state') snapshots.clear();
      if (!snapshot) {
        snapshots.delete(call.app);
        continue;
      }
      for (const [alias, prior] of snapshots) {
        if (prior.identity === snapshot.identity) snapshots.set(alias, snapshot);
      }
      for (const alias of [...snapshot.aliases, call.app]) {
        if (alias) snapshots.set(alias.toLowerCase(), snapshot);
      }
      if (call.name === 'get_app_state') targets.set(response.id, snapshot.window);
    }
  }
  return targets;
}
