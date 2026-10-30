import type { Root } from 'mdast';
import type { VFile } from 'vfile';
import { visit } from 'unist-util-visit';

// CommonMark treats backslash + punctuation as an escape. Recover a Windows
// destination from the parsed link's source span before that loses `.local`,
// `_name`, etc. Code, ordinary prose and non-file URLs are left to CommonMark.
export function remarkWindowsFileLinks() {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    visit(tree, (node) => {
      if (node.type !== 'link' && node.type !== 'image') return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const destination = source.slice(start, end).match(
        /\]\(\s*(?:<([a-z]:\\[^<>\r\n]+)>|([a-z]:\\[^\s\r\n]+?))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/i
      );
      if (destination) node.url = (destination[1] ?? destination[2]).replace(/\\/g, '/');
    });
  };
}
