import React, {
  useState,
  useEffect,
  useRef,
  memo,
  useMemo,
  useCallback,
  createContext,
  useContext,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import { remarkStreamReveal } from './remarkStreamReveal';
import { rehypeIncomingText } from './rehypeIncomingText';
import { StreamingMarkdownBlocks } from './streamingMarkdown';
import './ui/stream-prose.css';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import './ui/disclosure.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
// Improved oneDark theme for better comment contrast and readability
const customOneDarkTheme = {
  ...oneDark,
  'code[class*="language-"]': {
    ...oneDark['code[class*="language-"]'],
    color: '#e6e6e6',
    fontSize: 'var(--conversation-code-size, 14px)',
  },
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    color: '#e6e6e6',
    fontSize: 'var(--conversation-code-size, 14px)',
  },
  comment: { ...oneDark.comment, color: '#a0a0a0', fontStyle: 'italic' },
  prolog: { ...oneDark.prolog, color: '#a0a0a0' },
  doctype: { ...oneDark.doctype, color: '#a0a0a0' },
  cdata: { ...oneDark.cdata, color: '#a0a0a0' },
};

import { Check, Copy } from './icons';
import { wrapHTMLInCodeBlock } from '../utils/htmlSecurity';
import { isProtocolSafe, getProtocol, BLOCKED_PROTOCOLS } from '../utils/urlSecurity';
import { ConfirmationModal } from './ui/ConfirmationModal';
import { openWorkspaceFile, workspaceLinkPath } from '../workspace-panel/workspaceFilePanel';
import { panelMessages } from '../workspace-panel/workspacePanelMessages';
import { defineMessages, useIntl } from '../i18n';

const i18n = defineMessages({
  copyCode: {
    id: 'markdownContent.copyCode',
    defaultMessage: 'Copy code',
  },
  openExternalLink: {
    id: 'markdownContent.openExternalLink',
    defaultMessage: 'Open External Link',
  },
  openProtocolLink: {
    id: 'markdownContent.openProtocolLink',
    defaultMessage: 'Open {protocol} link?',
  },
  thisWillOpen: {
    id: 'markdownContent.thisWillOpen',
    defaultMessage: 'This will open: {href}',
  },
  open: {
    id: 'markdownContent.open',
    defaultMessage: 'Open',
  },
  cancel: {
    id: 'markdownContent.cancel',
    defaultMessage: 'Cancel',
  },
  failedToOpenLink: {
    id: 'markdownContent.failedToOpenLink',
    defaultMessage: 'Failed to Open Link',
  },
  noApplicationFound: {
    id: 'markdownContent.noApplicationFound',
    defaultMessage: 'No application found to open this link.',
  },
});

interface CodeProps extends React.ClassAttributes<HTMLElement>, React.HTMLAttributes<HTMLElement> {
  inline?: boolean;
  node?: unknown;
}

interface MarkdownContentProps {
  sessionId?: string;
  content: string;
  className?: string;
  revealAt?: number;
  animateIncoming?: boolean;
}

type MarkdownSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'technical-evidence'; summary: string; content: string; streaming?: boolean };

export function splitCodeProTechnicalEvidence(content: string): MarkdownSegment[] {
  const pattern =
    /^<details>\r?\n<summary>((?:查看技术证据|查看运行记录|技术详情|Technical details)[^<\r\n]*)<\/summary>\r?\n([\s\S]*?)^<\/details>[ \t]*(?:\r?\n|$)/gm;
  const segments: MarkdownSegment[] = [];
  let cursor = 0;

  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ kind: 'markdown', content: content.slice(cursor, index) });
    }
    segments.push({
      kind: 'technical-evidence',
      summary: match[1] === 'Technical details' ? match[1] : '查看运行记录',
      content: match[2].trim(),
    });
    cursor = index + match[0].length;
  }

  const isCodeProReport =
    /^# (?:CodePro\s+(?:分析|测试|修复|检查|执行)(?:报告|结果)|本次任务结果)/m.test(content);
  if (isCodeProReport) {
    const remainder = content.slice(cursor);
    const partialOpenings = [...remainder.matchAll(/^<details>[ \t]*(?:\r?\n|$)/gm)];
    const partialOpening = partialOpenings[partialOpenings.length - 1];
    let partialStart = partialOpening?.index;
    if (partialStart === undefined) {
      const trailingLineStart = remainder.lastIndexOf('\n') + 1;
      const trailingLine = remainder.slice(trailingLineStart);
      if (trailingLine.length > 0 && '<details>'.startsWith(trailingLine)) {
        partialStart = trailingLineStart;
      }
    }
    if (partialStart !== undefined) {
      const partialContent = remainder.slice(partialStart);
      if (!partialContent.includes('</details>')) {
        const markdownBeforePartial = remainder.slice(0, partialStart);
        if (markdownBeforePartial) {
          segments.push({ kind: 'markdown', content: markdownBeforePartial });
        }
        segments.push({
          kind: 'technical-evidence',
          summary: '正在整理运行记录…',
          content: '',
          streaming: true,
        });
        cursor = content.length;
      }
    }
  }

  if (cursor < content.length || segments.length === 0) {
    segments.push({ kind: 'markdown', content: content.slice(cursor) });
  }
  return segments;
}

// Memoized CodeBlock component to prevent re-rendering when props haven't changed
const StreamingMarkdownContext = createContext(false);

const CodeBlock = memo(function CodeBlock({
  language,
  children,
}: {
  language: string;
  children: string;
}) {
  const intl = useIntl();
  const streaming = useContext(StreamingMarkdownContext);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);

      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Memoize the SyntaxHighlighter component to prevent re-rendering
  // Only re-render if language or children change
  const memoizedSyntaxHighlighter = useMemo(() => {
    // Re-tokenizing an ever-growing program stalls input and cancellation.
    // Keep every received character visible; large historical blocks also avoid
    // building thousands of syntax spans when reopening a conversation.
    if (streaming || children.length > 8000) {
      return (
        <div
          data-plain-code
          style={{
            margin: 0,
            padding: '1em',
            borderRadius: 8,
            lineHeight: '1.6',
            background: '#282c34',
            color: '#e6e6e6',
          }}
        >
          <code
            style={{
              whiteSpace: 'pre',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--conversation-code-size, 14px)',
            }}
          >
            {children}
          </code>
        </div>
      );
    }

    return (
      <SyntaxHighlighter
        style={customOneDarkTheme}
        language={language}
        PreTag="div"
        customStyle={{
          margin: 0,
          width: '100%',
          maxWidth: '100%',
          borderRadius: '8px',
          lineHeight: '1.6',
        }}
        codeTagProps={{
          style: {
            whiteSpace: 'pre',
            wordBreak: 'normal',
            overflowWrap: 'normal',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--conversation-code-size, 14px)',
          },
        }}
        // Performance optimizations for SyntaxHighlighter
        showLineNumbers={false} // Disable line numbers for better performance
        wrapLines={false} // Disable line wrapping for better performance
        lineProps={undefined} // Don't add extra props to each line
      >
        {children}
      </SyntaxHighlighter>
    );
  }, [language, children, streaming]);

  return (
    <div className="relative group w-full">
      <button
        onClick={handleCopy}
        className="absolute right-2 bottom-2 p-1.5 rounded-lg bg-gray-700/50 text-gray-300 font-sans text-sm
                 opacity-0 group-hover:opacity-100 transition-opacity duration-200
                 hover:bg-gray-600/50 hover:text-gray-100 z-10"
        title={intl.formatMessage(i18n.copyCode)}
        aria-label={intl.formatMessage(i18n.copyCode)}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
      <div className="w-full overflow-x-auto">{memoizedSyntaxHighlighter}</div>
    </div>
  );
});

const MarkdownCode = memo(
  React.forwardRef(function MarkdownCode(
    { inline, className, children, node: _node, ...props }: CodeProps,
    ref: React.Ref<HTMLElement>
  ) {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children);
    const isFencedCodeBlock = !inline && (Boolean(match) || code.endsWith('\n'));

    return isFencedCodeBlock ? (
      <CodeBlock language={match?.[1] ?? 'text'}>{code.replace(/\n$/, '')}</CodeBlock>
    ) : (
      <code
        ref={ref}
        {...props}
        className="break-all bg-inline-code whitespace-pre-wrap font-mono !text-inherit before:content-none after:content-none"
      >
        {children}
      </code>
    );
  })
);

// Custom URL transform to preserve deep link URLs (spotify:, vscode:, slack:, etc.)
// React-markdown's default only allows http/https/mailto and strips all other protocols
// We allow all protocols except dangerous ones (javascript:, data:, file:, etc.)
const customUrlTransform = (url: string): string => {
  try {
    const protocol = new URL(url).protocol;
    if (BLOCKED_PROTOCOLS.includes(protocol)) {
      return '';
    }
  } catch {
    // Not a valid URL, allow it (could be relative path)
  }
  return url;
};

const MarkdownContent = memo(function MarkdownContent({
  content,
  className = '',
  revealAt,
  animateIncoming = false,
  sessionId,
}: MarkdownContentProps) {
  const intl = useIntl();
  const splitIncoming = animateIncoming;
  const previewLabel = intl.formatMessage(panelMessages.previewMedia);
  const [pendingLink, setPendingLink] = useState<{ protocol: string; href: string } | null>(null);

  const completeSegments = useMemo(() => {
    try {
      const processed = wrapHTMLInCodeBlock(content);
      return splitCodeProTechnicalEvidence(processed);
    } catch (error) {
      console.error('Error processing content:', error);
      return [{ kind: 'markdown' as const, content }];
    }
  }, [content]);
  const canRevealTree =
    completeSegments.length === 1 &&
    completeSegments[0].kind === 'markdown' &&
    completeSegments[0].content === content;
  // Preserve existing HTML-safety and technical-evidence transformations; their
  // generated wrappers do not share offsets with the original source.
  const segments = useMemo(
    () =>
      revealAt !== undefined && !canRevealTree
        ? splitCodeProTechnicalEvidence(wrapHTMLInCodeBlock(content.slice(0, revealAt)))
        : completeSegments,
    [content, revealAt, canRevealTree, completeSegments]
  );

  const handleConfirmOpen = useCallback(async () => {
    if (pendingLink) {
      try {
        await window.electron.openExternal(pendingLink.href);
      } catch {
        await window.electron.showMessageBox({
          type: 'error',
          buttons: ['OK'],
          title: intl.formatMessage(i18n.failedToOpenLink),
          message: intl.formatMessage(i18n.noApplicationFound),
          detail: pendingLink.href,
        });
      }
    }
    setPendingLink(null);
  }, [pendingLink, intl]);

  const handleCancelOpen = useCallback(() => {
    setPendingLink(null);
  }, []);

  // Keep renderer identity stable as deltas arrive, especially for links whose
  // existing children must not remount and replay their entrance animation.
  const components = useMemo<Components>(
    () => ({
      a: (props) => (
        <a
          {...props}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!props.href) return;
            const filePath = workspaceLinkPath(props.href);
            if (sessionId && filePath) {
              openWorkspaceFile({ sessionId, filePath });
              return;
            }
            if (isProtocolSafe(props.href)) {
              window.electron.openExternal(props.href);
            } else {
              const protocol = getProtocol(props.href);
              if (protocol) setPendingLink({ protocol, href: props.href });
            }
          }}
        />
      ),
      img: ({ src, alt }) =>
        sessionId && typeof src === 'string' && workspaceLinkPath(src) ? (
          <button
            type="button"
            className="underline"
            onClick={() => openWorkspaceFile({ sessionId, filePath: workspaceLinkPath(src)! })}
          >
            {alt || previewLabel}
          </button>
        ) : (
          <img src={src} alt={alt} />
        ),
      code: MarkdownCode,
    }),
    [sessionId, previewLabel]
  );

  const urlTransform = useCallback(
    (url: string) => (sessionId && workspaceLinkPath(url) ? url : customUrlTransform(url)),
    [sessionId]
  );
  const renderMarkdown = (markdown: string, key: string) =>
    revealAt === undefined && splitIncoming ? (
      <StreamingMarkdown
        key={key}
        content={markdown}
        components={components}
        urlTransform={urlTransform}
      />
    ) : (
      <ReactMarkdown
        key={key}
        urlTransform={urlTransform}
        remarkPlugins={[
          [remarkGfm, { singleTilde: false }],
          [remarkMath, { singleDollarTextMath: false }],
          ...(revealAt !== undefined && canRevealTree
            ? [
                [remarkStreamReveal, { at: revealAt, source: content }] as [
                  typeof remarkStreamReveal,
                  { at: number; source: string },
                ],
              ]
            : []),
          // Clip before break conversion, which creates nodes without source offsets.
          remarkBreaks,
        ]}
        rehypePlugins={[
          ...(splitIncoming ? [rehypeIncomingText] : []),
          [
            rehypeKatex,
            {
              throwOnError: false,
              errorColor: '#cc0000',
              strict: false,
            },
          ],
        ]}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    );

  return (
    <StreamingMarkdownContext.Provider value={animateIncoming}>
      <div
        className={`w-full overflow-x-hidden prose prose-sm text-text-primary dark:prose-invert max-w-full word-break font-sans
        prose-pre:p-0 prose-pre:m-0 !p-0
        prose-code:break-all prose-code:whitespace-pre-wrap prose-code:font-mono
        prose-a:break-all prose-a:overflow-wrap-anywhere
        prose-table:table prose-table:w-full
        prose-blockquote:text-inherit
        prose-td:border prose-td:border-border-primary prose-td:p-2
        prose-th:border prose-th:border-border-primary prose-th:p-2
        prose-thead:bg-background-primary
        prose-h1:text-2xl prose-h1:font-normal prose-h1:mb-5 prose-h1:mt-0 prose-h1:font-sans
        prose-h2:text-xl prose-h2:font-normal prose-h2:mb-4 prose-h2:mt-4 prose-h2:font-sans
        prose-h3:text-lg prose-h3:font-normal prose-h3:mb-3 prose-h3:mt-3 prose-h3:font-sans
        prose-p:mt-0 prose-p:mb-2 prose-p:font-sans
        prose-ol:my-2 prose-ol:font-sans
        prose-ul:mt-0 prose-ul:mb-3 prose-ul:font-sans
        prose-li:m-0 prose-li:font-sans ${splitIncoming ? 'codepro-incoming-text' : ''} ${className}`}
      >
        {segments.map((segment, index) =>
          segment.kind === 'markdown' ? (
            renderMarkdown(segment.content, `markdown-${index}`)
          ) : segment.streaming ? (
            <div
              key={`technical-evidence-streaming-${index}`}
              role="status"
              aria-live="polite"
              className="my-3 flex items-center gap-2 rounded-lg border border-border-subtle bg-background-secondary/40 px-3 py-2 text-sm text-text-secondary"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-text-secondary"
              />
              {segment.summary}
            </div>
          ) : (
            <details key={`technical-evidence-${index}`} className="codepro-disclosure my-3 py-2">
              <summary className="cursor-pointer select-none font-medium text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary">
                {segment.summary}
              </summary>
              <div className="mt-2 max-h-80 overflow-y-auto">
                {renderMarkdown(segment.content, `technical-evidence-body-${index}`)}
              </div>
            </details>
          )
        )}
      </div>
      <ConfirmationModal
        isOpen={pendingLink !== null}
        title={intl.formatMessage(i18n.openExternalLink)}
        message={intl.formatMessage(i18n.openProtocolLink, {
          protocol: pendingLink?.protocol ?? '',
        })}
        detail={intl.formatMessage(i18n.thisWillOpen, { href: pendingLink?.href ?? '' })}
        onConfirm={handleConfirmOpen}
        onCancel={handleCancelOpen}
        confirmLabel={intl.formatMessage(i18n.open)}
        cancelLabel={intl.formatMessage(i18n.cancel)}
      />
    </StreamingMarkdownContext.Provider>
  );
});

const StreamingBlock = memo(function StreamingBlock({
  content,
  components,
  urlTransform,
}: {
  content: string;
  components: Components;
  urlTransform: (url: string) => string;
}) {
  return (
    <ReactMarkdown
      components={components}
      urlTransform={urlTransform}
      remarkPlugins={[
        [remarkGfm, { singleTilde: false }],
        [remarkMath, { singleDollarTextMath: false }],
        remarkBreaks,
      ]}
      rehypePlugins={[
        rehypeIncomingText,
        [rehypeKatex, { throwOnError: false, errorColor: '#cc0000', strict: false }],
      ]}
    >
      {content}
    </ReactMarkdown>
  );
});

function StreamingMarkdown(props: {
  content: string;
  components: Components;
  urlTransform: (url: string) => string;
}) {
  const parser = useRef<StreamingMarkdownBlocks | null>(null);
  parser.current ??= new StreamingMarkdownBlocks();
  const blocks = parser.current.update(props.content);
  return (
    <>
      {blocks.map((block, index) => (
        <React.Fragment key={block.key}>
          {index > 0 ? '\n' : null}
          <StreamingBlock
            content={block.content}
            components={props.components}
            urlTransform={props.urlTransform}
          />
        </React.Fragment>
      ))}
    </>
  );
}

export default MarkdownContent;
