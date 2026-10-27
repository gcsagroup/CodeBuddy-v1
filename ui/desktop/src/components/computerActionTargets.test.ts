import { expect, it } from 'vitest';
import type { Message } from '../types/message';
import { computerActionTargets } from './computerActionTargets';

const request = (id: string, name: string, args: Record<string, unknown>): Message => ({
  id,
  role: 'assistant',
  created: 1,
  metadata: { userVisible: true, agentVisible: true },
  content: [
    { type: 'toolRequest', id, toolCall: { name: `mcp__qwen_computer__${name}`, arguments: args } },
  ],
});
const receipt = (id: string, pid: number, title: string, tree = ''): Message => ({
  id: `result-${id}`,
  role: 'user',
  created: 1,
  metadata: { userVisible: false, agentVisible: true },
  content: [
    {
      type: 'toolResponse',
      id,
      toolResult: {
        status: 'success',
        value: {
          structuredContent: {
            desktop_observation: {
              schema_version: 1,
              pid,
              window_handle: 100,
              app_name: `app-${pid}`,
              window_title: title,
            },
          },
          content: [{ type: 'text', text: tree }],
        },
      },
    },
  ],
});

it('describes the clicked target from its before-state, without substituting the opened window or editable values', () => {
  const messages = [
    request('observe', 'get_app_state', { app: 'window:1:100' }),
    receipt(
      'observe',
      1,
      '招聘评审',
      '\t42 列表项目 A01.jpg Value: private-token Secondary Actions: Invoke Frame: {}'
    ),
    request('open', 'click', { app: 'window:1:100', element_index: '42', click_count: 2 }),
    receipt('open', 1, 'A01.jpg — 照片', '\t42 按钮 关闭 Frame: {}'),
    request('type', 'type_text', { app: 'window:1:100', text: 'secret-password' }),
  ];
  const before = JSON.stringify(messages);
  const targets = computerActionTargets(messages);
  expect(targets.get('observe')).toBe('招聘评审');
  expect(targets.get('open')).toBe('招聘评审 列表项目 A01.jpg');
  expect(targets.get('type')).toBe('A01.jpg — 照片');
  expect([...targets.values()].join(' ')).not.toMatch(/private-token|secret-password/);
  expect(JSON.stringify(messages)).toBe(before);
});

it('does not borrow another window, stale foreground or coordinate guess as an element label', () => {
  const targets = computerActionTargets([
    request('observe', 'get_app_state', { app: 'window:1:100' }),
    receipt('observe', 1, 'Window A', '\t42 按钮 A Frame: {}'),
    request('other', 'click', { app: 'window:2:100', element_index: '42' }),
    request('foreground', 'click', { app: 'foreground', element_index: '42' }),
    request('coordinates', 'click', { app: 'window:1:100', x: 10, y: 20 }),
  ]);
  expect(targets.has('other')).toBe(false);
  expect(targets.has('foreground')).toBe(false);
  expect(targets.get('coordinates')).toBe('Window A (10, 20)');
});

it('labels browser reads, captures and controls from that tab observation without exposing field values', () => {
  const browser = (id: string, args: Record<string, unknown>): Message => ({
    id,
    role: 'assistant',
    created: 1,
    metadata: { userVisible: true, agentVisible: true },
    content: [{ type: 'toolRequest', id, toolCall: { name: 'browser_control', arguments: args } }],
  });
  const result: Message = {
    id: 'page-result',
    role: 'user',
    created: 1,
    metadata: { userVisible: false, agentVisible: true },
    content: [
      {
        type: 'toolResponse',
        id: 'read-page',
        toolResult: {
          status: 'success',
          value: {
            structuredContent: {
              title: '会议室预约',
              nodes: [
                { node: 10, role: 'button', name: '保存预约' },
                { node: 11, role: 'textbox', name: '密码', value: 'secret-value' },
              ],
            },
          },
        },
      },
    ],
  };
  const targets = computerActionTargets([
    browser('read-page', { id: 'tab-one', operation: 'observe' }),
    result,
    browser('capture', { id: 'tab-one', operation: 'screenshot' }),
    browser('other-tab', { id: 'tab-two', operation: 'screenshot' }),
    browser('save', { id: 'tab-one', operation: 'click', node: 10 }),
  ]);
  expect(targets.get('read-page')).toBe('会议室预约');
  expect(targets.get('capture')).toBe('会议室预约');
  expect(targets.get('save')).toBe('会议室预约 保存预约');
  expect(targets.has('other-tab')).toBe(false);
  expect([...targets.values()].join(' ')).not.toContain('secret-value');
});
