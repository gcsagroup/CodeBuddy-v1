import { it, expect, vi } from 'vitest';
import type { WebContents } from 'electron';
import { BrowserController } from './browserControl';
it('keeps search results and unnamed controls after empty layout nodes without falsely reporting truncation', async () => {
  const send = vi.fn(async () => ({
    nodes: [
      ...Array.from({ length: 600 }, (_, i) => ({
        backendDOMNodeId: i + 1,
        role: { value: 'generic' },
        name: { value: '' },
      })),
      { backendDOMNodeId: 601, role: { value: 'link' }, name: { value: 'Official documentation' } },
      { backendDOMNodeId: 602, role: { value: 'checkbox' }, name: { value: '' } },
    ],
  }));
  const wc = {
    on: vi.fn(),
    isDestroyed: () => false,
    getURL: () => 'http://localhost/',
    getTitle: () => 'Search',
    debugger: { isAttached: () => true, sendCommand: send },
  } as unknown as WebContents;
  const result = await new BrowserController(wc).run({ operation: 'observe' });
  expect(result).toMatchObject({
    truncated: false,
    nodes: [
      { node: 601, role: 'link', name: 'Official documentation' },
      { node: 602, role: 'checkbox', name: '' },
    ],
  });
});
it('requires observed nodes, clears them after navigation, and distinguishes dispatch from verification', async () => {
  const events = new Map<string, (...args: unknown[]) => void>();
  const send = vi.fn(async (method: string) =>
    method === 'Accessibility.getFullAXTree'
      ? {
          nodes: [{ backendDOMNodeId: 12, role: { value: 'textbox' }, name: { value: 'Message' } }],
        }
      : {}
  );
  const wc = {
    on: (name: string, fn: (...args: unknown[]) => void) => events.set(name, fn),
    isDestroyed: () => false,
    getURL: () => 'http://localhost/',
    getTitle: () => 'Fixture',
    debugger: { isAttached: () => true, sendCommand: send },
  } as unknown as WebContents;
  const control = new BrowserController(wc);
  await expect(control.run({ operation: 'type', text: 'hello' })).rejects.toThrow('type requires');
  await expect(control.run({ operation: 'type', node: 12, text: 'hello' })).rejects.toThrow(
    'Observe'
  );
  await control.run({ operation: 'observe' });
  expect(await control.run({ operation: 'type', node: 12, text: 'hello' })).toMatchObject({
    dispatched: true,
    verified: false,
  });
  expect(send).toHaveBeenCalledWith('DOM.focus', { backendNodeId: 12 });
  expect(send).toHaveBeenCalledWith('Input.insertText', { text: 'hello' });
  events.get('did-start-navigation')!({}, 'http://new/', false, true);
  await expect(control.run({ operation: 'type', node: 12, text: 'hello' })).rejects.toThrow(
    'Observe'
  );
  await expect(control.run({ operation: 'key', key: 'Unknown' })).rejects.toThrow('Unsupported');
});
