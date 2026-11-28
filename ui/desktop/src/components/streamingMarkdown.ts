import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Root, RootContent } from 'mdast';
import type { Node, Point } from 'unist';
import type { Plugin } from 'unified';

type ParseMarkdown = (source: string) => Root;
type Origin = Point & { offset: number };
const start: Origin = { line: 1, column: 1, offset: 0 };

function hasReferences(node: Node): boolean {
  return (
    [
      'definition',
      'linkReference',
      'imageReference',
      'footnoteDefinition',
      'footnoteReference',
    ].includes(node.type) ||
    ('children' in node && (node.children as Node[]).some(hasReferences))
  );
}

function relocate(node: Node, origin: Origin): boolean {
  if (!node.position) return false;
  for (const point of [node.position.start, node.position.end]) {
    if (point.offset === undefined) return false;
    if (point.line === 1) point.column += origin.column - 1;
    point.line += origin.line - 1;
    point.offset += origin.offset;
  }
  return (
    !('children' in node) || (node.children as Node[]).every((child) => relocate(child, origin))
  );
}

// Reuse DSH's stable-prefix/two-tail-block frontier, while leaving one complete
// document tree for the existing transforms and React renderer. References keep
// document-wide parsing, so late definitions and footnote numbering stay exact.
export class StreamingMarkdownParser {
  private previous = '';
  private origin: Origin = { ...start };
  private frozen: RootContent[] = [];
  private root: Root | null = null;
  private fullDocument = false;

  get requiresFullDocument(): boolean {
    return this.fullDocument;
  }

  private update(source: string, parseMarkdown: ParseMarkdown): Root {
    if (this.root && source === this.previous) return this.root;
    if (!source.startsWith(this.previous)) {
      this.origin = { ...start };
      this.frozen = [];
      this.fullDocument = false;
    }
    let tree = parseMarkdown(this.fullDocument ? source : source.slice(this.origin.offset));
    if (!this.fullDocument && (hasReferences(tree) || !relocate(tree, this.origin))) {
      this.fullDocument = true;
      this.frozen = [];
      tree = parseMarkdown(source);
    }
    if (!this.fullDocument) {
      const boundary = Math.max(0, tree.children.length - 2);
      const end = tree.children[boundary - 1]?.position?.end;
      const children = [...this.frozen, ...tree.children];
      if (boundary > 0 && end?.offset !== undefined) {
        this.frozen.push(...tree.children.slice(0, boundary));
        this.origin = { ...end, offset: end.offset };
      }
      tree = { ...tree, children, position: { start: { ...start }, end: tree.position!.end } };
    }
    this.previous = source;
    this.root = tree;
    return tree;
  }

  parse(source: string, parseMarkdown: ParseMarkdown): Root {
    // Transforms must never mutate the raw cache, including on cache hits.
    return structuredClone(this.update(source, parseMarkdown));
  }

  blocks(source: string, parseMarkdown: ParseMarkdown): Array<{ key: number; content: string }> {
    const tree = this.update(source, parseMarkdown);
    if (this.fullDocument) return [{ key: 0, content: source }];
    return tree.children.map((node) => ({
      key: node.position!.start.offset!,
      content: source.slice(node.position!.start.offset!, node.position!.end.offset!),
    }));
  }
}

// unified exposes processor.parser; wrap the current processor's own grammar,
// rather than calling processor.parse recursively or replacing its extensions.
// https://github.com/unifiedjs/unified#processorparser
export const remarkStreamingParser: Plugin<[StreamingMarkdownParser]> = function (cache) {
  const parse = this.parser!;
  this.parser = (source, file) => cache.parse(source, (text) => parse(text, file) as Root);
};

const blockGrammar = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath, { singleDollarTextMath: false });

// Animated prose already memoizes completed React blocks. Keep that rendering
// optimization, sharing the same source frontier instead of cloning its word tree.
export class StreamingMarkdownBlocks {
  private readonly cache = new StreamingMarkdownParser();
  private initialized = false;
  get hasSource(): boolean {
    return this.initialized;
  }
  get requiresFullDocument(): boolean {
    return this.cache.requiresFullDocument;
  }
  update(source: string): Array<{ key: number; content: string }> {
    this.initialized = true;
    return this.cache.blocks(source, (text) => blockGrammar.parse(text));
  }
}
