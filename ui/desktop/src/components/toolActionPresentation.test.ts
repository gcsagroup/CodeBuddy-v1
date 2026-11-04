import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { formatToolAction, webSearchDetails } from './toolActionPresentation';
import type { ToolResponseMessageContent } from '../types/message';

const intl = createIntl({ locale: 'en', messages: {} });

describe('native automation task actions', () => {
  it.each([
    ['schedule_create', '创建', '建立', 'Create', 'Creating', 'Created'],
    ['schedule_pause', '暂停', '暫停', 'Pause', 'Pausing', 'Paused'],
    ['schedule_resume', '恢复', '恢復', 'Resume', 'Resuming', 'Resumed'],
  ])('localizes %s without claiming success before its receipt', (name, simplified, traditional, base, running, completed) => {
    for (const [locale, labels] of [
      ['zh-CN', [`${simplified}自动化任务`, `正在${simplified}自动化任务`, `已${simplified}自动化任务`]],
      ['zh-TW', [`${traditional}自動化任務`, `正在${traditional}自動化任務`, `已${traditional}自動化任務`]],
      ['en', [`${base} automation task`, `${running} automation task`, `${completed} automation task`]],
    ] as const) {
      const local = createIntl({ locale, messages: {} });
      expect(formatToolAction(local, name, {})).toBe(labels[0]);
      expect(formatToolAction(local, name, {}, 'running')).toBe(labels[1]);
      expect(formatToolAction(local, name, {}, 'completed')).toBe(labels[2]);
      expect(formatToolAction(local, name, {}, 'running', 'name')).toBe(labels[0]);
    }
    expect(formatToolAction(intl, `mcp__external__${name}`, {}, 'running')).not.toBe(`${running} automation task`);
  });
});

describe('media operation receipts', () => {
  const response = (
    receipt: Record<string, unknown>,
    persisted = false
  ): ToolResponseMessageContent => ({
    type: 'toolResponse',
    id: 'media-call',
    toolResult: {
      status: 'success',
      value: persisted
        ? { content: [{ type: 'text', text: JSON.stringify(receipt) }] }
        : { content: [], structuredContent: receipt },
    },
  });
  const title = (name: string, operation: string, receipt?: ToolResponseMessageContent) =>
    formatToolAction(
      intl,
      name,
      { operation },
      'completed',
      'detail',
      undefined,
      undefined,
      receipt
    );

  it.each(['generate_image', 'generate_video'])(
    'shows each requested business name before receiving a job for %s without claiming completion',
    (tool) => {
      for (const name of ['春季促销海报', '夏季促销海报']) {
        const args = { operation: 'generate', display_name: name };
        expect(formatToolAction(intl, tool, args, 'running')).toBe(`Running: Generate ${name}`);
        expect(formatToolAction(intl, tool, args, undefined, 'name')).toBe(`Generate ${name}`);
        expect(formatToolAction(intl, tool, args, 'completed')).toBe(`Generate ${name}`);
        expect(
          formatToolAction(
            intl,
            tool,
            args,
            'completed',
            'detail',
            undefined,
            undefined,
            response({ status: 'queued', display_name: name })
          )
        ).toBe(`Generate ${name}: Queued`);
      }
    }
  );

  it('does not apply the native naming contract to unrelated MCP tools or workflow inspection', () => {
    expect(
      formatToolAction(
        intl,
        'mcp__other__generate_image',
        {
          operation: 'generate',
          display_name: 'Ignored name',
        },
        undefined,
        'name'
      )
    ).toBe('Image generation · Submission request');
    expect(
      formatToolAction(
        intl,
        'generate_image',
        {
          operation: 'inspect',
          display_name: 'Ignored name',
        },
        undefined,
        'name'
      )
    ).toBe('Image generation · Workflow inspection');
  });

  it('uses the active view language for the named action', () => {
    for (const locale of ['zh-CN', 'zh-TW']) {
      expect(
        formatToolAction(
          createIntl({ locale, messages: {} }),
          'generate_image',
          {
            operation: 'generate',
            display_name: '小熊猫招手动作图',
          },
          undefined,
          'name'
        )
      ).toBe('生成小熊猫招手动作图');
    }
  });

  it.each(['generate_image', 'mcp__comfyui__generate_video'])(
    'keeps submission and repeated status calls distinct for %s',
    (name) => {
      const kind = name.endsWith('video') ? 'Video' : 'Image';
      expect(title(name, 'generate', response({ status: 'queued' }))).toBe(
        `${kind} generation · Submission request: Queued`
      );
      for (let poll = 0; poll < 13; poll++)
        expect(title(name, 'status', response({ status: 'running' }))).toBe(
          `${kind} generation · Status check: Generating`
        );
      expect(title(name, 'status', response({ status: 'completed' }, true))).toBe(
        `${kind} generation · Status check: Completed`
      );
      expect(title(name, 'status', response({ status: 'failed' }))).toBe(
        `${kind} generation · Status check: Failed`
      );
    }
  );

  it('does not promote a successful cancel tool receipt into confirmed cancellation', () => {
    expect(
      title(
        'generate_video',
        'cancel',
        response({ status: 'running', cancellation_confirmed: false })
      )
    ).toBe('Video generation · Cancellation request: Generating · Cancellation not confirmed');
    expect(
      title(
        'generate_video',
        'cancel',
        response({ status: 'cancelled', cancellation_confirmed: true })
      )
    ).toBe('Video generation · Cancellation request: Cancelled');
    expect(title('generate_video', 'cancel', response({ status: 'completed' }))).toBe(
      'Video generation · Cancellation request: Completed · Cancellation not confirmed'
    );
  });

  it('keeps missing or prose-only receipts neutral and names inspection before it executes', () => {
    expect(title('generate_image', 'generate')).toBe('Image generation · Submission request');
    expect(
      title('generate_image', 'status', {
        type: 'toolResponse',
        id: 'media-call',
        toolResult: {
          status: 'success',
          value: {
            content: [{ type: 'text', text: 'The image completed successfully' }],
          },
        },
      })
    ).toBe('Image generation · Status check');
    expect(
      formatToolAction(intl, 'generate_image', { operation: 'inspect' }, undefined, 'name')
    ).toBe('Image generation · Workflow inspection');
    expect(
      formatToolAction(
        intl,
        'generate_image',
        { operation: 'generate', __inputPreview: true },
        'running'
      )
    ).toBe('Preparing operation parameters: Image generation · Submission request');
  });
});

it('uses the same browser operation name in approvals and progress without inventing execution', () => {
  expect(
    formatToolAction(intl, 'browser_control', { operation: 'observe' }, undefined, 'name')
  ).toBe('Read page');
  expect(formatToolAction(intl, 'browser_control', { operation: 'observe' }, 'running')).toBe(
    'Running: Read page'
  );
  expect(
    formatToolAction(
      intl,
      'browser_control',
      { operation: 'observe', __inputPreview: true },
      'running'
    )
  ).toBe('Preparing operation parameters: Read page');
  expect(
    formatToolAction(intl, 'browser_control', { operation: 'invented' }, undefined, 'name')
  ).toBe('Browser action');
});
describe('live file generation', () => {
  it('uses an extension display title only as a fallback and never treats argument prose as a name', () => {
    expect(
      formatToolAction(
        intl,
        'mcp__custom__inspect_build',
        { description: 'delete everything' },
        undefined,
        'name',
        'Inspect build report'
      )
    ).toBe('Inspect build report');
    expect(
      formatToolAction(
        intl,
        'mcp__custom__inspect_build',
        {},
        undefined,
        'name',
        'mcp__custom__inspect_build'
      )
    ).toBe('Inspect Build');
    expect(
      formatToolAction(
        intl,
        'mcp__qwen_computer__get_app_state',
        {},
        undefined,
        'name',
        'mcp__qwen_computer__get_app_state'
      )
    ).toBe('Read window contents');
  });
  it('counts received draft lines without claiming a write and drops draft wording for execution', () => {
    const args = { path: 'src/app.js', content: 'first\nsecond\n', __inputPreview: true };
    expect(formatToolAction(intl, 'write', args, 'running')).toBe(
      'Generating app.js, 2 lines received — not saved yet'
    );
    expect(formatToolAction(intl, 'write', { ...args, __inputPreview: undefined }, 'running')).toBe(
      'Running: Write file app.js'
    );
    expect(formatToolAction(intl, 'write', args, 'completed')).toBe('Wrote file app.js');
  });
});

describe('web search presentation receipts', () => {
  it('extracts a typed failure reason without showing the raw error JSON', () => {
    expect(
      webSearchDetails(
        { query: 'query' },
        {
          type: 'toolResponse',
          id: 'error',
          toolResult: {
            status: 'error',
            error: '{"error":{"message":"Search provider unavailable"},"requestId":"private-id"}',
          },
        }
      )
    ).toEqual({ queries: ['query'], sources: [], notice: 'Search provider unavailable' });
  });
  it('shows a structured MCP failure reason only under its actual error receipt', () => {
    expect(
      webSearchDetails(
        {},
        {
          type: 'toolResponse',
          id: 'error',
          toolResult: {
            status: 'success',
            value: {
              isError: true,
              content: [],
              structuredContent: {
                error: { message: 'Provider quota exceeded' },
                internal: 'hidden',
              },
            },
          },
        }
      )
    ).toEqual({ queries: [], sources: [], notice: 'Provider quota exceeded' });
  });
  it.each(['mcp__exa__web_search_exa', 'mcp__brave__brave_web_search', 'web_search'])(
    'names %s naturally from its identity and actual state',
    (name) => {
      expect(formatToolAction(intl, name, {}, 'running')).toBe('Searching the web');
      expect(formatToolAction(intl, name, {}, 'completed')).toBe('Searched the web');
    }
  );

  it('projects structured sources without exposing raw payloads or unsafe URLs', () => {
    const details = webSearchDetails(
      { query: 'a real query' },
      {
        type: 'toolResponse',
        id: 'search',
        toolResult: {
          status: 'success',
          value: {
            content: [],
            structuredContent: {
              results: [
                {
                  title: 'Official source',
                  url: 'https://example.test/docs',
                  text: 'Long source body',
                },
                { title: 'unsafe', url: 'javascript:alert(1)' },
                { title: 'credential URL', url: 'https://user:secret@example.test/' },
              ],
            },
          },
        },
      }
    );
    expect(details).toEqual({
      queries: ['a real query'],
      sources: [{ title: 'Official source', url: 'https://example.test/docs' }],
    });
    expect(formatToolAction(intl, 'search', {}, 'running')).toBe('Running: Search');
  });
});
