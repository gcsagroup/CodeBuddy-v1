import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AnswerFilesProvider } from './AnswerFilesProvider';
import MarkdownContent from './MarkdownContent';
import type { AnswerFile } from './remarkDeliveredFileLinks';
import { IntlTestWrapper } from '../i18n/test-utils';

const processed = vi.hoisted(() => [] as string[]);
vi.mock('./remarkWindowsFileLinks', async (original) => {
  const actual = await original<typeof import('./remarkWindowsFileLinks')>();
  return {
    ...actual,
    remarkWindowsFileLinks: () => {
      const transform = actual.remarkWindowsFileLinks();
      return (...args: Parameters<typeof transform>) => {
        processed.push(String(args[1]));
        return transform(...args);
      };
    },
  };
});

beforeEach(() => { processed.length = 0; });

function body(content: string, files: readonly AnswerFile[], sessionId = 'session', turnId = 'turn') {
  return (
    <AnswerFilesProvider sessionId={sessionId} turnId={turnId} files={files}>
      <MarkdownContent content={content} animateIncoming streaming />
    </AnswerFilesProvider>
  );
}

it.each([{ files: [] }, { files: [{ key: '/work/note.txt', path: '/work/note.txt' }] }])(
  'does not reprocess completed blocks for equivalent file facts: $files', ({ files }) => {
    const content = 'First.\n\n[focused](https://example.com/).\n\nThird.\n\nTail.';
    const view = render(body(content, files), { wrapper: IntlTestWrapper });
    const link = screen.getByRole('link', { name: 'focused' });
    link.focus();
    processed.length = 0;
    view.rerender(body(content, files.map(file => ({ ...file }))));
    expect(processed).toEqual([]);
    view.rerender(body(content + ' More received text.', files.map(file => ({ ...file }))));
    expect(processed.some(source => source.includes('First.'))).toBe(false);
    expect(view.container).toHaveTextContent('More received text.');
    expect(screen.getByRole('link', { name: 'focused' })).toBe(link);
    expect(document.activeElement).toBe(link);
  }
);

it('updates late receipt repairs, basename ambiguity and revocation without retaining stale facts', () => {
  const content = '[note.txt](<absolute file path>)\n\nSecond.\n\nThird.\n\nTail.';
  const view = render(body(content, []), { wrapper: IntlTestWrapper });
  const original = screen.getByRole('link', { name: 'note.txt' }).getAttribute('href');
  const file = { key: '/work/note.txt', path: '/work/note.txt' };
  view.rerender(body(content, [file]));
  expect(screen.getByRole('link', { name: 'note.txt' })).toHaveAttribute('href', file.path);
  view.rerender(body(content, [file, { key: '/other/note.txt', path: '/other/note.txt' }]));
  expect(screen.getByRole('link', { name: 'note.txt' })).toHaveAttribute('href', original);
  view.rerender(body(content, [file]));
  expect(screen.getByRole('link', { name: 'note.txt' })).toHaveAttribute('href', file.path);
  view.rerender(body(content, []));
  expect(screen.getByRole('link', { name: 'note.txt' })).toHaveAttribute('href', original);
});

it('invalidates for key-only edits and for session or turn changes', () => {
  const key = '/work/note.txt';
  const content = '[note](<absolute file path>' + key + ')\n\nSecond.\n\nThird.\n\nTail.';
  const file = { key, path: '/work/actual.txt' };
  const view = render(body(content, []), { wrapper: IntlTestWrapper });
  expect(screen.queryByRole('link', { name: 'note' })).toBeNull();
  view.rerender(body(content, [file]));
  expect(screen.getByRole('link', { name: 'note' })).toHaveAttribute('href', file.path);
  view.rerender(body(content, [{ ...file, key: '/work/different.txt' }]));
  expect(screen.queryByRole('link', { name: 'note' })).toBeNull();
  processed.length = 0;
  view.rerender(body(content, [{ ...file, key: '/work/different.txt' }], 'other-session'));
  expect(processed.length).toBeGreaterThan(0);
  processed.length = 0;
  view.rerender(body(content, [{ ...file, key: '/work/different.txt' }], 'other-session', 'other-turn'));
  expect(processed.length).toBeGreaterThan(0);
});
