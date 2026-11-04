import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

// Navigation convenience only: no existence, delivery or permission claim.
// Basenames and commands are deliberately left alone; their directory is unknown.
export function remarkCodeFileLinks() {
  return (tree: Root) => {
    visit(tree, 'inlineCode', (node, index, parent) => {
      if (index === undefined || !parent || parent.type === 'link') return;
      const value = node.value;
      if (!/^(?:[a-z]:[\\/]|\/(?!\/)|\.{1,2}[\\/]|[^\s\\/:]+[\\/])/i.test(value)) return;
      if (
        /[\r\n<>|"`]/.test(value) ||
        !/\.[a-z0-9]{1,12}(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/i.test(value)
      )
        return;
      // Relative paths with spaces are indistinguishable from shell invocations.
      if (!/^(?:[a-z]:[\\/]|\/(?!\/))/i.test(value) && /\s/.test(value)) return;
      parent.children[index] = {
        type: 'link',
        url: value.replace(/\\/g, '/'),
        children: [{ type: 'text', value }],
        position: node.position,
      };
    });
  };
}
