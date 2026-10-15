/// <reference lib="es2022.intl" />

interface TextNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TextNode[];
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' });

// Stable inline siblings animate only on insertion. Do not delay content, change
// layout, or restart a paragraph's animation each time another delta arrives.
export function rehypeIncomingText() {
  return (tree: TextNode) => {
    const visit = (node: TextNode) => {
      if (node.tagName && ['pre', 'code', 'math', 'svg'].includes(node.tagName)) return;
      if (
        node.properties?.className instanceof Array &&
        node.properties.className.includes('katex')
      ) {
        return;
      }
      if (!node.children) return;
      node.children = node.children.flatMap((child): TextNode[] => {
        if (child.type !== 'text' || !child.value?.trim()) {
          visit(child);
          return [child];
        }
        return Array.from(words.segment(child.value), ({ segment }) => ({
          type: 'element',
          tagName: 'span',
          properties: { className: ['codepro-incoming-word'] },
          children: [{ type: 'text', value: segment }],
        }));
      });
    };
    visit(tree);
  };
}
