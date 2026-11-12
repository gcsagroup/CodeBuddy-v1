import { lazy, memo, Suspense, useEffect, useRef } from 'react';

const SyntaxHighlighter = lazy(() => import('react-syntax-highlighter/dist/esm/prism'));

const languages: Record<string, string> = {
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  json: 'json',
  css: 'css',
  html: 'markup',
  xml: 'markup',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
};

export const WorkspaceCodePreview = memo(function WorkspaceCodePreview({
  path,
  content,
  wrap,
  line,
}: {
  path: string;
  content: string;
  wrap: boolean;
  line?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (line)
      root.current
        ?.querySelector(`[data-source-line="${line}"]`)
        ?.scrollIntoView({ block: 'center' });
  }, [line, content]);
  const language = languages[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'text';
  const plainPreview = (
    <pre>
      {line
        ? content.split('\n').map((text, index) => (
            <span
              key={index}
              className={`wb-code-line ${index + 1 === line ? 'wb-code-line-selected' : ''}`}
              data-source-line={index + 1}
            >
              <span className="react-syntax-highlighter-line-number">{index + 1}</span>
              {text || '\n'}
            </span>
          ))
        : content}
    </pre>
  );
  // Keep linked lines selectable while loading the grammar and for large files.
  return (
    <div ref={root} className={'wb-code ' + (wrap ? 'wb-code-wrap' : '')}>
      <div className="wb-code-language">{language}</div>
      {content.length > 100_000 ? (
        plainPreview
      ) : (
        <Suspense fallback={plainPreview}>
          <SyntaxHighlighter
            language={language}
            style={{}}
            useInlineStyles={false}
            showLineNumbers
            wrapLines
            lineProps={(number: number) => ({
              className: `wb-code-line ${number === line ? 'wb-code-line-selected' : ''}`,
              'data-source-line': number,
            })}
            codeTagProps={{ style: { font: 'inherit', color: 'inherit', textShadow: 'none' } }}
            lineNumberStyle={{
              minWidth: '3.5em',
              paddingRight: '1.5em',
              userSelect: 'none',
              opacity: 0.45,
            }}
          >
            {content}
          </SyntaxHighlighter>
        </Suspense>
      )}
    </div>
  );
});
