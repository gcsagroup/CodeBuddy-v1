import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { formatToolAction, webSearchDetails } from './toolActionPresentation';

const intl = createIntl({ locale: 'en', messages: {} });

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
