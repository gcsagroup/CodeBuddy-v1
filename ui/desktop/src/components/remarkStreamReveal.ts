interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

// Parse the text already received, then reveal its syntax tree. This keeps known
// bold/code/table syntax in place instead of rendering a sliced Markdown string
// first as plain text and restyling it when its closing delimiter becomes visible.
export function remarkStreamReveal({ at, source }: { at: number; source: string }) {
  return (tree: MarkdownNode) => {
    const reveal = (node: MarkdownNode): boolean => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && start >= at) return false;
      if (end !== undefined && end <= at) return true;
      if (node.children) {
        node.children = node.children.filter((child) => {
          if (reveal(child)) return true;
          // Keep column count stable while only part of a table row is visible.
          if (child.type === 'tableCell') {
            child.children = [];
            return true;
          }
          return false;
        });
      } else if (node.value !== undefined && start !== undefined) {
        let contentStart = start;
        if (node.type === 'code' && /^ {0,3}(`{3,}|~{3,})/.test(source.slice(start))) {
          contentStart = source.indexOf('\n', start) + 1;
        } else if (node.type === 'inlineCode') {
          contentStart += source.slice(start).match(/^`+/)?.[0].length ?? 0;
        }
        node.value = node.value.slice(0, Math.max(0, at - contentStart));
      }
      return true;
    };
    if (!reveal(tree)) tree.children = [];
  };
}
