import type { Root } from 'mdast';
import type { VFile } from 'vfile';
import { visit } from 'unist-util-visit';

// CommonMark treats backslash + punctuation as an escape. Recover a Windows
// destination from the parsed link's source span before that loses `.local`,
// `_name`, etc. Code, ordinary prose and non-file URLs are left to CommonMark.
export function remarkWindowsFileLinks() {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    visit(tree, (node, index, parent) => {
      if (node.type !== 'link' && node.type !== 'image') return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      // Historical model replies sometimes wrapped a drive path in HTTP and
      // used [label]<destination>. GFM splits the autolink at the first space.
      // Use the source span so CommonMark escapes do not corrupt the pathname.
      if (node.type === 'link' && /^https?:\/\/[a-z]:\\/i.test(node.url)) {
        const before = index !== undefined && parent ? parent.children[index - 1] : undefined;
        const after = index !== undefined && parent ? parent.children[index + 1] : undefined;
        const raw = source.slice(start, end);
        const bracket = before?.type === 'text' && before.value.match(/\[([^[\]\n]+)\](<?)$/);
        let path = node.url.replace(/^https?:\/\//i, '');
        if (bracket && before?.type === 'text' && (raw.startsWith('<') || bracket[2])) {
          if (bracket[2]) {
            const tail = after?.type === 'text' && /^([^<>\r\n]*)>/.exec(after.value);
            if (!tail || after?.type !== 'text') return;
            const continuation = /^([^<>\r\n]*)>/.exec(source.slice(end, after.position?.end.offset));
            if (!continuation) return;
            path = raw.replace(/^https?:\/\//i, '') + continuation[1];
            after.value = after.value.slice(tail[0].length);
          }
          before.value = before.value.slice(0, bracket.index);
          node.children = [{ type: 'text', value: bracket[1] }];
        } else {
          const original = raw.match(/\]\(\s*<?https?:\/\/([a-z]:\\[^<>\r\n]+?)>?\s*\)$/i);
          if (original) path = original[1];
        }
        node.url = path.replace(/\\/g, '/');
        return;
      }
      const destination = source.slice(start, end).match(
        /\]\(\s*(?:<([a-z]:\\[^<>\r\n]+)>|([a-z]:\\[^\s\r\n]+?))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/i
      );
      if (destination) node.url = (destination[1] ?? destination[2]).replace(/\\/g, '/');
    });
  };
}
