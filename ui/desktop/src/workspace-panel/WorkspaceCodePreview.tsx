import { memo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

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
}: {
  path: string;
  content: string;
  wrap: boolean;
}) {
  const language = languages[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'text';
  // Bound tokenization cost for large files; retain their full, selectable contents.
  return (
    <div className={'wb-code ' + (wrap ? 'wb-code-wrap' : '')}>
      <div className="wb-code-language">{language}</div>
      {content.length > 100_000 ? (
        <pre>{content}</pre>
      ) : (
        <SyntaxHighlighter
          language={language}
          style={{}}
          useInlineStyles={false}
          showLineNumbers
          wrapLines
          lineProps={{ className: 'wb-code-line' }}
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
      )}
    </div>
  );
});
