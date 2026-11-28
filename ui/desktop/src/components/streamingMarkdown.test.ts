import { describe, expect, it, vi } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { StreamingMarkdownParser } from './streamingMarkdown';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath, { singleDollarTextMath: false });
const parse = (source: string) => processor.parse(source);
const documents = [
  '标题😀\r\n\r\n第二段。\r\n\r\nRead [报告](D:/目录/report.md).\r\n\r\n尾部',
  'One.\r\rTwo.\r\rThree.\r\rFour.',
  'One.\n\n- parent\n  - child\n\n    continued\n- next\n\nTail.',
  'One.\n\nTwo.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nTail.',
  'One.\n\nTwo.\n\nHeading\n---\n\nTail.',
  'One.\n\nTwo.\n\n' +
    '\x60'.repeat(3) +
    'ts\nconst rocket = "😀";\n' +
    '\x60'.repeat(3) +
    '\n\nTail.',
  'One.\n\nRead [guide][g].\n\nThree.\n\n[g]: https://example.com/guide',
  'One.\n\nClaim[^n].\n\nThree.\n\n[^n]: footnote\n\nTail.',
  'One.\n\nTwo.\n\n$$\nx^2 + y^2\n$$\n\nTail.',
];

describe('streaming source parser', () => {
  it.each(documents)(
    'preserves complete document grammar and UTF-16 source positions for every prefix: %s',
    (source) => {
      const cache = new StreamingMarkdownParser();
      for (let length = 0; length <= source.length; length++) {
        const prefix = source.slice(0, length);
        expect(cache.parse(prefix, parse)).toEqual(parse(prefix));
      }
    }
  );
  it('is independent of speculative append, rollback, replacement and repeated input', () => {
    const cache = new StreamingMarkdownParser();
    const a = 'First.\n\nSecond.\n\nThird.';
    for (const source of [
      a,
      a + '\n\nFourth.',
      a,
      a + '\n\nDifferent.',
      '',
      'Replacement.',
      'Replacement.',
    ])
      expect(cache.parse(source, parse)).toEqual(parse(source));
  });
  it('isolates cached raw trees from downstream transforms, including cache hits', () => {
    const cache = new StreamingMarkdownParser();
    const source = 'First.\n\nSecond.\n\nThird.';
    const changed = cache.parse(source, parse);
    changed.children.splice(0, changed.children.length);
    expect(cache.parse(source, parse)).toEqual(parse(source));
    expect(cache.parse(source + ' tail', parse)).toEqual(parse(source + ' tail'));
  });
  it('parses a bounded tail after a long completed prefix', () => {
    const cache = new StreamingMarkdownParser();
    const source = Array.from({ length: 500 }, (_, n) => 'Completed paragraph ' + n + '.').join(
      '\n\n'
    );
    const observed = vi.fn(parse);
    cache.parse(source, observed);
    cache.parse(source + ' tail', observed);
    expect(observed.mock.calls[observed.mock.calls.length - 1][0].length).toBeLessThan(
      source.length / 10
    );
  });
  it('falls back to the original full parse when positions are unavailable', () => {
    const parseWithoutPosition = (source: string) => {
      const root = parse(source);
      if (root.children[0]) delete root.children[0].position;
      return root;
    };
    const cache = new StreamingMarkdownParser();
    const source = 'First.\n\nSecond.\n\nThird.';
    expect(cache.parse(source, parseWithoutPosition)).toEqual(parseWithoutPosition(source));
    expect(cache.parse(source + '\n\nFourth.', parseWithoutPosition)).toEqual(
      parseWithoutPosition(source + '\n\nFourth.')
    );
  });
});
