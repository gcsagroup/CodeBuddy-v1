import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchHighlighter } from './searchHighlighter';

class NativeHighlight extends Set<ReturnType<typeof document.createRange>> {
  priority = 0;
}

const registry = new Map<string, NativeHighlight>();
const highlighters: SearchHighlighter[] = [];

beforeEach(() => {
  vi.stubGlobal('CSS', { highlights: registry });
  vi.stubGlobal('Highlight', NativeHighlight);
});

afterEach(() => {
  highlighters.splice(0).forEach(item => item.destroy());
  registry.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function surface(content: string, onMatchesChange?: (count: number) => void) {
  const element = document.createElement('section');
  element.textContent = content;
  document.body.appendChild(element);
  const highlighter = new SearchHighlighter(element, onMatchesChange);
  highlighters.push(highlighter);
  return { element, highlighter };
}

describe('conversation text highlights', () => {
  it('clears only its own highlights when another chat is still searching', async () => {
    const first = surface('cat cat').highlighter;
    const second = surface('cat dog').highlighter;
    expect(await Promise.all([first.highlight('cat'), second.highlight('cat')])).toEqual([2, 1]);
    expect(registry.get('conversation-find')?.size).toBe(3);
    expect(registry.get('conversation-find-current')?.size).toBe(2);
    first.destroy();
    expect(registry.get('conversation-find')?.size).toBe(1);
    expect(registry.get('conversation-find-current')?.size).toBe(1);
    second.destroy();
    expect(registry.get('conversation-find')?.size).toBe(0);
  });

  it('matches bracket literals and Unicode without searching the find controls', async () => {
    const { element, highlighter } = surface('[A] [a] 输出🙂 输出🙂');
    const controls = document.createElement('div');
    controls.className = 'search-bar';
    controls.textContent = '[A] 输出🙂';
    element.appendChild(controls);
    expect(await highlighter.highlight('[A]')).toBe(2);
    expect(await highlighter.highlight('[A]', true)).toBe(1);
    expect(await highlighter.highlight('输出🙂')).toBe(2);
  });

  it('discards an incomplete query when replaced or closed', async () => {
    const { highlighter } = surface('before-after after');
    const oldQuery = highlighter.highlight('before');
    const latestQuery = highlighter.highlight('after');
    expect(await oldQuery).toBeUndefined();
    expect(await latestQuery).toBe(2);
    const pending = highlighter.highlight('before');
    highlighter.destroy();
    expect(await pending).toBeUndefined();
    expect(registry.get('conversation-find')?.size).toBe(0);
  });

  it('refreshes matches when streaming prose updates an existing text node', async () => {
    const notify = vi.fn();
    const { element, highlighter } = surface('status: pending', notify);
    expect(await highlighter.highlight('complete')).toBe(0);
    element.firstChild!.textContent = 'status: complete';
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(1));
    expect(registry.get('conversation-find-current')?.size).toBe(1);
  });
});
