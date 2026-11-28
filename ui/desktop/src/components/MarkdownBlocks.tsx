import React, { memo, useContext, useRef, useState } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import type { Element, Root as HtmlRoot } from 'hast';
import type { Root as MarkdownRoot } from 'mdast';
import type { Plugin, PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import { AnswerFiles, remarkDeliveredFileLinks, type AnswerFile } from './remarkDeliveredFileLinks';
import { remarkWindowsFileLinks } from './remarkWindowsFileLinks';
import { remarkCodeFileLinks } from './remarkCodeFileLinks';
import { rehypeIncomingText } from './rehypeIncomingText';
import { StreamingMarkdownBlocks } from './streamingMarkdown';

type RenderOptions = {
  components: Components;
  urlTransform: (url: string) => string;
  animateIncoming: boolean;
};
type Block = { key: string; separator: string } | { key: string; content: string; tree?: HtmlRoot };
type Bridge = Element & { data: { element: React.ReactElement } };
type OwnedBlock = Element & { data: { key: string; separator?: string } };
type RenderCache = RenderOptions & {
  source: string;
  fullDocument: boolean;
  entries: Map<string, { block: Block; element: React.ReactElement }>;
  elements: React.ReactElement[];
};

function sameOptions(a: RenderOptions, b: RenderOptions): boolean {
  return (
    a.components === b.components &&
    a.urlTransform === b.urlTransform &&
    a.animateIncoming === b.animateIncoming
  );
}

function sameBlock(a: Block, b: Block): boolean {
  return 'separator' in a && 'separator' in b
    ? a.separator === b.separator
    : 'content' in a && 'content' in b && a.content === b.content && a.tree === b.tree;
}

function renderBlock(block: Block, options: RenderOptions): React.ReactElement {
  return (
    <React.Fragment key={block.key}>
      {'separator' in block ? (
        block.separator
      ) : (
        <StreamingBlock content={block.content} tree={block.tree} {...options} />
      )}
    </React.Fragment>
  );
}

function reuseBlocks(
  previous: RenderCache | undefined,
  blocks: Block[],
  options: RenderOptions,
  source: string,
  fullDocument: boolean
): RenderCache {
  const entries: RenderCache['entries'] = new Map();
  const compatible = previous && sameOptions(previous, options);
  const elements = blocks.map((block) => {
    const old = compatible ? previous.entries.get(block.key) : undefined;
    const entry =
      old && sameBlock(old.block, block) ? old : { block, element: renderBlock(block, options) };
    entries.set(block.key, entry);
    return entry.element;
  });
  return { ...options, source, fullDocument, entries, elements };
}

function remarkPlugins(files: readonly AnswerFile[]): PluggableList {
  return [
    [remarkDeliveredFileLinks, files],
    remarkWindowsFileLinks,
    remarkCodeFileLinks,
    [remarkGfm, { singleTilde: false }],
    [remarkMath, { singleDollarTextMath: false }],
    remarkBreaks,
  ];
}

function rehypePlugins(animate: boolean): PluggableList {
  return [
    ...(animate ? [rehypeIncomingText] : []),
    [rehypeKatex, { throwOnError: false, errorColor: '#cc0000', strict: false }],
  ];
}

// Some transforms (notably KaTeX) replace nodes without retaining positions.
// Keep the source owner around their output, then unwrap it before presentation.
const ownBlocks: Plugin<[], HtmlRoot> = () => (tree) => {
  const generated = new Map<string, number>();
  // The JSX runtime omits doctypes; they are not valid element children.
  tree.children = tree.children
    .filter((child) => child.type !== 'doctype')
    .map((child, index, children): OwnedBlock => {
      const offset = child.position?.start.offset;
      const shape = `${child.type}:${child.type === 'element' ? child.tagName : ''}`;
      const count = generated.get(shape) ?? 0;
      if (offset === undefined) generated.set(shape, count + 1);
      let key = offset === undefined ? `generated:${shape}:${count}` : `source:${offset}`;
      let separator: string | undefined;
      if (child.type === 'text' && !child.value.trim()) {
        const nextOffset = children[index + 1]?.position?.start.offset;
        key = `gap:${nextOffset ?? `generated:${count}`}`;
        separator = child.value;
      }
      return {
        type: 'element',
        tagName: 'div',
        properties: {},
        children: [child],
        data: { key, separator },
      };
    });
};

const emptyDocument: Plugin = function () {
  this.parser = (): MarkdownRoot => ({ type: 'root', children: [] });
};

function htmlBlocks(tree: HtmlRoot): Block[] {
  return (tree.children as OwnedBlock[]).map(({ children, data: { key, separator } }) =>
    separator !== undefined
      ? { key, separator }
      : { key, content: '', tree: { type: 'root', children } }
  );
}

// Both paths have the same owner and source-offset keys. Global references are
// compiled once by ReactMarkdown, then each block only runs its public HAST→JSX
// boundary. Raw trees live in node.data so the outer post() cannot mutate them.
// https://github.com/remarkjs/react-markdown/tree/10.1.0#architecture
export const MarkdownBlocks = memo(function MarkdownBlocks({
  content,
  streaming,
  ...options
}: RenderOptions & { content: string; streaming: boolean }) {
  const files = useContext(AnswerFiles);
  const parser = useRef<StreamingMarkdownBlocks | null>(null);
  parser.current ??= new StreamingMarkdownBlocks();
  // Initial history uses one full compile. Once an incremental cache exists,
  // settle with its latest source instead of reprocessing the completed tree.
  const incremental = streaming || parser.current.hasSource;
  const parsed = incremental ? parser.current.update(content) : [];
  const fullDocument = !incremental || parser.current.requiresFullDocument;
  const blocks: Block[] = parsed.flatMap((block, index) => [
    ...(index ? [{ key: `gap:${block.key}`, separator: '\n' }] : []),
    { key: `source:${block.key}`, content: block.content },
  ]);
  const [cache, setCache] = useState(() =>
    reuseBlocks(undefined, fullDocument ? [] : blocks, options, content, fullDocument)
  );
  let rendered = cache;
  // A render-local immutable cache: interrupted renders cannot publish a mutable
  // ref Map. React retries this component before reconciling its children.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (
    cache.fullDocument !== fullDocument ||
    (fullDocument
      ? cache.entries.size > 0
      : cache.source !== content || !sameOptions(cache, options))
  ) {
    rendered = reuseBlocks(
      fullDocument ? undefined : cache,
      fullDocument ? [] : blocks,
      options,
      content,
      fullDocument
    );
    setCache(rendered);
  }
  const bridge: Plugin<[], HtmlRoot> = () => (tree) => {
    const node: Bridge = {
      type: 'element',
      tagName: 'div',
      properties: {},
      children: [],
      // Opaque JSX also keeps development prop diagnostics from walking a
      // document-sized data array every time an unrelated tail changes.
      data: {
        element: (
          <>
            {fullDocument
              ? htmlBlocks(tree).map((block) => renderBlock(block, options))
              : rendered.elements}
          </>
        ),
      },
    };
    return { type: 'root', children: [node] };
  };
  return (
    <ReactMarkdown
      components={bridgeComponents}
      remarkPlugins={fullDocument ? remarkPlugins(files) : [emptyDocument]}
      rehypePlugins={
        fullDocument ? [ownBlocks, ...rehypePlugins(options.animateIncoming), bridge] : [bridge]
      }
    >
      {content}
    </ReactMarkdown>
  );
});

function MarkdownBlockList({ node }: ExtraProps) {
  // This component is used only by our own empty bridge element above.
  return (node as Bridge).data.element;
}
const bridgeComponents: Components = { div: MarkdownBlockList };

const StreamingBlock = memo(function StreamingBlock({
  content,
  tree,
  components,
  urlTransform,
  animateIncoming,
}: RenderOptions & { content: string; tree?: HtmlRoot }) {
  const files = useContext(AnswerFiles);
  // ReactMarkdown post() rewrites raw nodes and URL properties in place. Clone
  // only this block; never clone the full document once for every block.
  const inject: Plugin<[], HtmlRoot> = () => () => structuredClone(tree!);
  return (
    <ReactMarkdown
      components={components}
      urlTransform={urlTransform}
      remarkPlugins={tree ? [] : remarkPlugins(files)}
      rehypePlugins={tree ? [inject] : rehypePlugins(animateIncoming)}
    >
      {content}
    </ReactMarkdown>
  );
});
