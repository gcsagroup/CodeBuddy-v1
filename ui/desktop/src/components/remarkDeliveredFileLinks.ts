import { createContext } from 'react';
import type { Link, Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { fileIdentity, type ConversationChangeFile } from './codepro/conversationChanges';

export type AnswerFile = Readonly<Pick<ConversationChangeFile, 'key' | 'path'>>;
export const AnswerFiles = createContext<readonly AnswerFile[]>([]);

// Older replies copied the prompt's placeholder, sometimes prepending it to
// the real destination. Only repair a link backed by this turn's write receipt.
export function remarkDeliveredFileLinks(files: readonly AnswerFile[]) {
  const resolve = (label: string) => {
    const matches = files.filter(file => file.path.replace(/\\/g, '/').split('/').pop() === label);
    if (matches.length !== 1) return;
    return matches[0].path.replace(/\\/g, '/');
  };
  return (tree: Root) => {
    visit(tree, 'link', node => {
      if (node.url !== 'absolute file path' || node.children.length !== 1 || node.children[0].type !== 'text') return;
      const path = resolve(node.children[0].value);
      if (path) node.url = path;
    });
    visit(tree, 'html', (node, index, parent) => {
      if (node.value !== '<absolute file path>' || index === undefined || !parent) return;
      const before = parent.children[index - 1], after = parent.children[index + 1];
      if (before?.type !== 'text' || after?.type !== 'text') return;
      const label = /\[([^[\]\r\n]+)\]\($/.exec(before.value);
      if (!label) return;
      // Match the entire known destination, including any parentheses in it.
      for (const file of files) {
        const destination = [file.key, file.path].find(path =>
          after.value[path.length] === ')' && fileIdentity(after.value.slice(0, path.length)) === fileIdentity(path));
        if (!destination) continue;
        const link: Link = { type: 'link', url: file.path.replace(/\\/g, '/'), children: [{ type: 'text', value: label[1] }] };
        before.value = before.value.slice(0, label.index);
        parent.children[index] = link;
        after.value = after.value.slice(destination.length + 1);
        return;
      }
    });
  };
}
