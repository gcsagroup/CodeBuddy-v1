import { it, expect, vi } from 'vitest';
import type { WebContents } from 'electron';
import { BrowserController } from './browserControl';
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
