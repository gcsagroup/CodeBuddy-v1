import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath, { singleDollarTextMath: false });

type Block = { key: number; content: string };
type Node = { type: string; children?: Node[] };
const hasReferences = (node: Node): boolean =>
  [
    'definition',
    'linkReference',
    'imageReference',
    'footnoteDefinition',
    'footnoteReference',
  ].includes(node.type) || !!node.children?.some(hasReferences);

// DSH alpha2 retains stable top-level blocks and reparses two trailing blocks.
// Use the same frontier with our existing Markdown grammar and renderers. Global
// references keep full-document parsing so late definitions remain correct.
export class StreamingMarkdownBlocks {
  private previous = '';
  private offset = 0;
  private frozen: Block[] = [];
  private blocks: Block[] = [];
  private fullDocument = false;

  update(text: string): Block[] {
    if (text === this.previous) return this.blocks;
    if (!text.startsWith(this.previous)) {
      this.offset = 0;
      this.frozen = [];
      this.fullDocument = false;
    }
    this.previous = text;
    if (this.fullDocument) return (this.blocks = [{ key: 0, content: text }]);
    const base = this.offset;
    const tree = parser.parse(text.slice(base));
    if (hasReferences(tree)) {
      this.fullDocument = true;
      return (this.blocks = [{ key: 0, content: text }]);
    }
    const boundary = Math.max(0, tree.children.length - 2);
    const tail: Block[] = [];
    tree.children.forEach((node, index) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const block = { key: base + start, content: text.slice(base + start, base + end) };
      if (index < boundary) {
        this.frozen.push(block);
        this.offset = base + end;
      } else tail.push(block);
    });
    return (this.blocks = [...this.frozen, ...tail]);
  }
}
