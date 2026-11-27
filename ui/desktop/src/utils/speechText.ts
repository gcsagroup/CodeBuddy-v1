import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const parser = unified().use(remarkParse).use(remarkGfm);
type SpeechNode = { type: string; value?: string; alt?: string; children?: SpeechNode[] };
export function speechText(markdown: string): string {
  const read = (node: SpeechNode): string => {
    if (node.type === 'html' || node.type === 'definition') return '';
    if (node.type === 'image') return node.alt ?? '';
    if (node.type === 'break') return '\n';
    if (typeof node.value === 'string') return node.value;
    const separator = ['root', 'list', 'listItem', 'blockquote', 'table', 'tableRow'].includes(
      node.type
    )
      ? '\n'
      : '';
    return node.children?.map(read).join(separator) ?? '';
  };
  const text = read(parser.parse(markdown) as SpeechNode)
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, '')
    .replace(
      /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0E|\uFE0F|\u200D|\u20E3|[\u{E0020}-\u{E007F}])/gu,
      ''
    )
    .replace(/[─━═│┃┌┐└┘├┤┬┴┼•▪●◆◇▶►✓✔✗✘]/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}
