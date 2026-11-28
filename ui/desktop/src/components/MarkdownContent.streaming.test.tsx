import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import * as deliveredLinks from './remarkDeliveredFileLinks';
import { IntlTestWrapper } from '../i18n/test-utils';

afterEach(() => vi.restoreAllMocks());

describe('completed Markdown blocks', () => {
  it('does not transform completed thought blocks again merely because streaming ends', () => {
    const original = deliveredLinks.remarkDeliveredFileLinks;
    let prefixVisits = 0;
    vi.spyOn(deliveredLinks, 'remarkDeliveredFileLinks').mockImplementation((files) => {
      const transform = original(files);
      return (tree) => {
        if (JSON.stringify(tree).includes('settled-prefix-marker')) prefixVisits++;
        transform(tree);
      };
    });
    const source = 'settled-prefix-marker.\n\nSecond.\n\nThird.\n\nTail.';
    const view = render(<MarkdownContent content={source} streaming />, {
      wrapper: IntlTestWrapper,
    });
    view.rerender(<MarkdownContent content={source} streaming={false} />);
    expect(prefixVisits).toBe(1);
    expect(view.container).toHaveTextContent('Tail.');
  });

  it('keeps Strict Mode rollback and a final packet with a new definition correct', () => {
    const source = 'First.\n\n[focused](https://example.com/focus).\n\nRead [guide][g].\n\nTail.';
    const tree = (content: string, streaming = true) => (
      <React.StrictMode>
        <MarkdownContent content={content} streaming={streaming} />
      </React.StrictMode>
    );
    const view = render(tree(source), { wrapper: IntlTestWrapper });
    const focused = screen.getByRole('link', { name: 'focused' });
    focused.focus();
    view.rerender(tree(source + '\n\nSpeculative suffix.'));
    view.rerender(tree(source));
    expect(view.container).not.toHaveTextContent('Speculative suffix');
    view.rerender(tree(source + '\n\n[g]: https://example.com/guide', false));
    expect(screen.getByRole('link', { name: 'guide' })).toHaveAttribute(
      'href',
      'https://example.com/guide'
    );
    expect(screen.getByRole('link', { name: 'focused' })).toBe(focused);
    expect(document.activeElement).toBe(focused);
    view.rerender(tree('Replacement[^n].\n\n[^n]: New note.', false));
    expect(view.container).not.toHaveTextContent('First.');
    expect(view.container.querySelector('[data-footnote-ref]')).toHaveTextContent('1');
    view.rerender(tree('', false));
    expect(view.container.textContent).toBe('');
    expect(view.container.querySelector('a')).toBeNull();
    view.rerender(tree('New document.'));
    expect(view.container).toHaveTextContent('New document.');
  });

  it('refreshes cached link handlers when the session changes', () => {
    const opened = vi.fn();
    window.addEventListener('codebuddy:open-workspace-file', opened);
    try {
      const source = '[source](./src.ts:12)\n\nSecond.\n\nThird.\n\nTail.';
      const view = render(<MarkdownContent sessionId="before" content={source} streaming />, {
        wrapper: IntlTestWrapper,
      });
      view.rerender(<MarkdownContent sessionId="after" content={source} streaming />);
      fireEvent.click(screen.getByRole('link', { name: 'source' }));
      expect(opened.mock.calls[0][0].detail).toMatchObject({ sessionId: 'after' });
    } finally {
      window.removeEventListener('codebuddy:open-workspace-file', opened);
    }
  });

  it.each([false, true])(
    'does not transform a completed prefix again (animation=%s)',
    (animate) => {
      const original = deliveredLinks.remarkDeliveredFileLinks;
      let prefixVisits = 0;
      vi.spyOn(deliveredLinks, 'remarkDeliveredFileLinks').mockImplementation((files) => {
        const transform = original(files);
        return (tree) => {
          if (JSON.stringify(tree).includes('completed-prefix-marker')) prefixVisits++;
          transform(tree);
        };
      });
      const source = 'completed-prefix-marker.\n\nSecond.\n\nThird.\n\nTail';
      const view = render(
        <MarkdownContent content={source} streaming animateIncoming={animate} />,
        { wrapper: IntlTestWrapper }
      );
      for (const suffix of [' one', ' one two', ' one two three'])
        view.rerender(
          <MarkdownContent content={source + suffix} streaming animateIncoming={animate} />
        );
      expect(prefixVisits).toBe(1);
      expect(view.container).toHaveTextContent('Tail one two three');
    }
  );

  it.each([false, true])(
    'preserves an unrelated focused selection across late references and settling (animation=%s)',
    (animate) => {
      const source =
        'First.\n\n[focused](https://example.com/focus).\n\nRead [guide][g].\n\nFourth.\n\nFifth.';
      const view = render(
        <MarkdownContent content={source} streaming animateIncoming={animate} />,
        { wrapper: IntlTestWrapper }
      );
      const link = screen.getByRole('link', { name: 'focused' });
      link.focus();
      const text = link.querySelector('span')?.firstChild ?? link.firstChild!;
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.setStart(text, 1);
      range.setEnd(text, 4);
      selection.removeAllRanges();
      selection.addRange(range);
      const complete = source + '\n\n[g]: https://example.com/guide';
      view.rerender(<MarkdownContent content={complete} streaming animateIncoming={animate} />);
      expect(screen.getByRole('link', { name: 'guide' })).toHaveAttribute(
        'href',
        'https://example.com/guide'
      );
      expect(screen.getByRole('link', { name: 'focused' })).toBe(link);
      expect(document.activeElement).toBe(link);
      expect(selection.anchorNode).toBe(text);
      expect(selection.toString()).toBe('ocu');
      view.rerender(
        <MarkdownContent content={complete} streaming={false} animateIncoming={false} />
      );
      expect(screen.getByRole('link', { name: 'focused' })).toBe(link);
      expect(document.activeElement).toBe(link);
      // Removing animation wrappers may change the selected text node, but not its link owner.
      if (!animate) {
        expect(selection.anchorNode).toBe(text);
        expect(selection.toString()).toBe('ocu');
      }
    }
  );

  it('keeps distinct math owners when a late reference enables global compilation', () => {
    const source = '$$\nx^2\n$$\n\n$$\ny^3\n$$\n\nRead [guide][g].\n\nTail.';
    const view = render(<MarkdownContent content={source} streaming />, {
      wrapper: IntlTestWrapper,
    });
    const math = [...view.container.querySelectorAll('.katex')];
    expect(math).toHaveLength(2);
    const complete = source + '\n\n[g]: https://example.com/guide';
    view.rerender(<MarkdownContent content={complete} streaming />);
    expect([...view.container.querySelectorAll('.katex')]).toEqual(math);
    expect(view.container.querySelectorAll('.katex')[0]).toBe(math[0]);
    expect(view.container.querySelectorAll('.katex')[1]).toBe(math[1]);
    view.rerender(<MarkdownContent content={complete} streaming={false} />);
    expect(view.container.querySelectorAll('.katex')[1]).toBe(math[1]);
    view.rerender(<MarkdownContent content={'$$\nz^4\n$$\n\nReplacement.'} streaming />);
    expect(view.container.querySelectorAll('.katex')).toHaveLength(1);
    expect(view.container).not.toHaveTextContent('guide');
  });

  it('numbers cross-block footnotes once and keeps their back references complete', () => {
    const source = 'First[^b].\n\nSecond[^a] and again[^b].\n\n[^a]: Alpha.\n\n[^b]: Beta.';
    const view = render(<MarkdownContent content={source} streaming />, {
      wrapper: IntlTestWrapper,
    });
    expect(
      [...view.container.querySelectorAll('[data-footnote-ref]')].map((n) => n.textContent)
    ).toEqual(['1', '2', '1']);
    expect(
      [...view.container.querySelectorAll('section[data-footnotes] li')].map((n) => n.textContent)
    ).toEqual([expect.stringContaining('Beta.'), expect.stringContaining('Alpha.')]);
    expect(view.container.querySelectorAll('[data-footnote-backref]')).toHaveLength(3);
    for (const anchor of view.container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      expect(
        view.container.querySelector(`[id="${anchor.getAttribute('href')!.slice(1)}"]`)
      ).not.toBeNull();
    }
    const focused = view.container.querySelector<HTMLAnchorElement>('[data-footnote-ref]')!;
    focused.focus();
    view.rerender(<MarkdownContent content={source} streaming={false} />);
    expect(view.container.querySelector('[data-footnote-ref]')).toBe(focused);
    expect(document.activeElement).toBe(focused);
  });

  it.each([false, true])(
    'invalidates completed links for real receipts, ambiguity and revocation (global=%s)',
    (global) => {
      const path = '/work/report.txt';
      const source =
        '[report.txt](<absolute file path>)\n\nSecond.\n\nThird.\n\nTail.' +
        (global ? '\n\n[g]: https://example.com' : '');
      const tree = (files: React.ContextType<typeof deliveredLinks.AnswerFiles>) => (
        <deliveredLinks.AnswerFiles.Provider value={files}>
          <MarkdownContent content={source} sessionId="cache-receipts" streaming />
        </deliveredLinks.AnswerFiles.Provider>
      );
      const view = render(tree([]), { wrapper: IntlTestWrapper });
      const href = () => screen.getByRole('link', { name: 'report.txt' }).getAttribute('href');
      const initial = href();
      view.rerender(tree([{ key: path, path }]));
      expect(decodeURIComponent(href()!)).toBe(path);
      view.rerender(
        tree([
          { key: path, path },
          { key: '/other/report.txt', path: '/other/report.txt' },
        ])
      );
      expect(href()).toBe(initial);
      view.rerender(tree([]));
      expect(href()).toBe(initial);
    }
  );
});
