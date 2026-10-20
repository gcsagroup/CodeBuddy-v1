import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, type RenderOptions } from '@testing-library/react';
import { screen, waitFor } from '@testing-library/dom';
import MarkdownContent from './MarkdownContent';
import { IntlTestWrapper } from '../i18n/test-utils';

const renderWithIntl = (ui: React.ReactElement, options?: RenderOptions) =>
  render(ui, { wrapper: IntlTestWrapper, ...options });

// Mock the icons to avoid import issues
vi.mock('./icons', () => ({
  Check: () => <div data-testid="check-icon">✓</div>,
  Copy: () => <div data-testid="copy-icon">📋</div>,
}));

describe('MarkdownContent', () => {
  it('keeps numeric tilde ranges intact while retaining explicit double-tilde deletion', () => {
    const { container } = renderWithIntl(
      <MarkdownContent
        content={'宇航员上太空 40%~80% 前几天会吐，2~3 天后适应。\n\n~~明确删除~~'}
      />
    );
    expect(container).toHaveTextContent('40%~80% 前几天会吐，2~3 天后适应。');
    expect(container.querySelectorAll('del')).toHaveLength(1);
    expect(container.querySelector('del')).toHaveTextContent('明确删除');
  });
  it('keeps existing links and animated words mounted while streaming text grows', () => {
    const content = '开头 **加粗重点** 与 [参考文档](https://example.com/docs)，hello world。';
    const { container, rerender } = renderWithIntl(
      <MarkdownContent content={content} animateIncoming />
    );
    const link = screen.getByRole('link', { name: '参考文档' });
    const word = link.querySelector('.codepro-incoming-word');
    const strong = container.querySelector('strong');
    expect(word).not.toBeNull();

    rerender(<MarkdownContent content={`${content} 后续文字继续到达。`} animateIncoming />);

    expect(screen.getByRole('link', { name: '参考文档' })).toBe(link);
    expect(link.querySelector('.codepro-incoming-word')).toBe(word);
    expect(container.querySelector('strong')).toBe(strong);
    expect(container).toHaveTextContent('hello world。 后续文字继续到达。');
  });

  it('removes word wrappers after a long streamed answer settles without changing its Markdown', () => {
    const content = Array.from(
      { length: 120 },
      (_, index) =>
        `- 第 ${index + 1} 项：**加粗重点 ${index + 1}**，English review complete! [参考文档 ${index + 1}](https://example.com/docs/${index + 1})。`
    ).join('\n');
    const { container, rerender } = renderWithIntl(
      <MarkdownContent content={content} animateIncoming />
    );
    const streamedText = container.textContent;
    expect(container.querySelectorAll('.codepro-incoming-word').length).toBeGreaterThan(120);
    expect(container.querySelectorAll('li')).toHaveLength(120);

    rerender(<MarkdownContent content={content} animateIncoming={false} />);

    expect(container.querySelectorAll('.codepro-incoming-word')).toHaveLength(0);
    expect(container.querySelector('.codepro-incoming-text')).toBeNull();
    expect(container.textContent).toBe(streamedText);
    expect(container.querySelectorAll('li')).toHaveLength(120);
    expect(container.querySelectorAll('strong')).toHaveLength(120);
    expect(container.querySelector('strong')).toHaveTextContent('加粗重点 1');
    expect(screen.getAllByRole('link')).toHaveLength(120);
    expect(screen.getByRole('link', { name: '参考文档 120' })).toHaveAttribute(
      'href',
      'https://example.com/docs/120'
    );
  });

  it('keeps the zero-character first frame empty even when a full packet has arrived', () => {
    const { container } = renderWithIntl(
      <MarkdownContent content={'# 标题\n\n尚未开始显示的完整一段。'} revealAt={0} />
    );
    expect(container.textContent).toBe('');
  });
  it('does not reveal later lines when line-break conversion creates synthetic text nodes', () => {
    const { container } = renderWithIntl(
      <MarkdownContent content={'第一行\n第二行\n第三行'} revealAt={2} />
    );
    expect(container.textContent).toBe('第一');
    expect(container.querySelector('br')).toBeNull();
  });
  it('uses received Markdown structure while revealing only the visible prefix', () => {
    const content =
      '**加粗文字** 和 `some_code`\n\n| 名称 | 内容 |\n| --- | --- |\n| 文件 | 已读取 |';
    const { container, rerender } = renderWithIntl(
      <MarkdownContent content={content} revealAt={4} />
    );
    expect(container.querySelector('strong')?.textContent).toBe('加粗');
    expect(container.textContent).not.toContain('**');
    expect(container.querySelector('table')).toBeNull();
    rerender(
      <IntlTestWrapper>
        <MarkdownContent content={content} revealAt={content.indexOf('内容')} />
      </IntlTestWrapper>
    );
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelector('tbody')).toBeNull();
    rerender(
      <IntlTestWrapper>
        <MarkdownContent content={content} revealAt={content.length} />
      </IntlTestWrapper>
    );
    expect(container.querySelector('code')?.textContent).toBe('some_code');
    expect(container.textContent).toContain('已读取');
  });

  describe('HTML Security Integration', () => {
    it('renders the trusted CodePro technical evidence block as a native fold', async () => {
      const content = [
        '# CodePro 分析报告',
        '',
        '分析正文。',
        '',
        '<details>',
        '<summary>查看技术证据（读取路径和命令）</summary>',
        '',
        '- 路径：`D:/project/src/main.rs`',
        '- 命令：`rg --files`',
        '',
        '</details>',
      ].join('\n');

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(container.querySelector('details')).toBeInTheDocument();
      });
      expect(screen.getByText('查看运行记录')).toBeInTheDocument();
      expect(screen.queryByText('查看技术证据（读取路径和命令）')).not.toBeInTheDocument();
      expect(container).toHaveTextContent('D:/project/src/main.rs');
      expect(container).toHaveTextContent('rg --files');
      expect(container).not.toHaveTextContent('<details>');
      expect(container).not.toHaveTextContent('</details>');
    });

    it('renders UserReportV1 technical details as a native fold', async () => {
      const content = [
        '# 本次任务结果',
        '',
        '已完成。',
        '',
        '<details>',
        '<summary>技术详情</summary>',
        '',
        '- 验证 diagnostic：Passed（`node tests.js`；退出码：0）',
        '',
        '</details>',
      ].join('\n');

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => expect(container.querySelector('details')).toBeInTheDocument());
      expect(screen.getByText('查看运行记录')).toBeInTheDocument();
      expect(container).toHaveTextContent('node tests.js');
      expect(container).not.toHaveTextContent('<details>');
    });

    it('hides an unfinished CodePro technical evidence block while it is streaming', async () => {
      const content = [
        '# CodePro 分析报告',
        '',
        '分析正文。',
        '',
        '<details>',
        '<summary>查看技术证据（读取路径和命令）</summary>',
        '',
        '- `tree`：确认项目目录结构',
      ].join('\n');

      const { container, rerender } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('正在整理运行记录…')).toBeInTheDocument();
      });
      expect(container).not.toHaveTextContent('<details>');
      expect(container).not.toHaveTextContent('<summary>');
      expect(container).not.toHaveTextContent('</summary>');
      expect(container).not.toHaveTextContent('确认项目目录结构');

      rerender(<MarkdownContent content={`${content}\n\n</details>`} />);

      await waitFor(() => {
        expect(container.querySelector('details')).toBeInTheDocument();
      });
      expect(screen.queryByText('正在整理运行记录…')).not.toBeInTheDocument();
      expect(container).toHaveTextContent('确认项目目录结构');
    });

    it('hides a partially streamed CodePro evidence summary', async () => {
      const content = [
        '# CodePro 测试报告',
        '',
        '正在生成报告。',
        '',
        '<details>',
        '<summary>查看技术证',
      ].join('\n');

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('正在整理运行记录…')).toBeInTheDocument();
      });
      expect(container).not.toHaveTextContent('<details>');
      expect(container).not.toHaveTextContent('<summary>');
    });

    it('hides a partially streamed CodePro details opening tag', async () => {
      const content = ['# CodePro 修复报告', '', '正在生成报告。', '', '<detai'].join('\n');

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('正在整理运行记录…')).toBeInTheDocument();
      });
      expect(container).not.toHaveTextContent('<detai');
    });

    it('does not trust an unfinished details block in ordinary markdown', async () => {
      const content = ['# 普通说明', '', '<details>', '<summary>普通内容'].join('\n');

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      expect(screen.queryByText('正在整理运行记录…')).not.toBeInTheDocument();
      expect(container).toHaveTextContent('<details>');
      expect(container.querySelector('[role="status"]')).not.toBeInTheDocument();
    });

    it('renders safe markdown content normally', async () => {
      const content = `# Test Title

Visit <https://example.com> for more info.

Contact <admin@example.com> for support.

Use \`Array<T>\` for generics.`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('Test Title')).toBeInTheDocument();
        expect(screen.getByText(/Visit/)).toBeInTheDocument();
        expect(screen.getByText(/for more info/)).toBeInTheDocument();
        expect(screen.getByText(/Contact/)).toBeInTheDocument();
        expect(screen.getByText(/for support/)).toBeInTheDocument();
      });

      // Should not create extra code blocks for safe content
      const codeBlocks = screen.queryAllByText(/```html/);
      expect(codeBlocks).toHaveLength(0);
    });

    it('wraps dangerous HTML in code blocks', async () => {
      const content = `# Security Test

This is safe text.

<script>alert('xss')</script>

More safe text.`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('Security Test')).toBeInTheDocument();
        expect(screen.getByText('This is safe text.')).toBeInTheDocument();
        expect(screen.getByText('More safe text.')).toBeInTheDocument();
      });

      // The script tag should be in a code block, not executed
      const scriptElements = document.querySelectorAll('script');
      expect(scriptElements).toHaveLength(0); // No actual script tags should be created

      // Should find the script content in a code block (text may be split across spans)
      await waitFor(() => {
        expect(screen.getByText(/alert/)).toBeInTheDocument();
        expect(screen.getByText(/xss/)).toBeInTheDocument();
      });
    });

    it('handles HTML comments securely', async () => {
      const content = `# Comment Test

<!-- This is a malicious comment -->

Normal text continues.`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('Comment Test')).toBeInTheDocument();
        expect(screen.getByText('Normal text continues.')).toBeInTheDocument();
      });

      // Comment should be in a code block
      await waitFor(() => {
        expect(screen.getByText(/This is a malicious comment/)).toBeInTheDocument();
      });
    });

    it('preserves existing code blocks', async () => {
      const content = `# Code Block Test

\`\`\`javascript
const html = "<div>This is safe in a code block</div>";
console.log(html);
\`\`\`

<div>This should be wrapped</div>`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('Code Block Test')).toBeInTheDocument();
      });

      // Should preserve the original JavaScript code block (text may be split)
      await waitFor(() => {
        expect(screen.getByText(/const/)).toBeInTheDocument();
        expect(screen.getAllByText(/html/)).toHaveLength(2); // Variable name and function parameter
      });

      // The div outside the code block should be wrapped
      await waitFor(() => {
        expect(screen.getByText(/This should be wrapped/)).toBeInTheDocument();
      });
    });

    it('handles mixed safe and unsafe content', async () => {
      const content = `# Mixed Content Test

1. Auto-link: <https://block.dev>
2. Inline code: \`const x = Array<T>();\`
3. Real markup: <input type="text" disabled>
4. Placeholder path: <project-root>/src`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('Mixed Content Test')).toBeInTheDocument();
        expect(screen.getByText(/Auto-link/)).toBeInTheDocument();
        expect(screen.getByText(/Inline code/)).toBeInTheDocument();
        expect(screen.getByText(/Real markup/)).toBeInTheDocument();
        expect(screen.getByText(/Placeholder path/)).toBeInTheDocument();
      });

      // Only the input tag should be wrapped
      await waitFor(() => {
        expect(screen.getByText(/input/)).toBeInTheDocument();
        expect(screen.getByText(/type/)).toBeInTheDocument();
        expect(screen.getByText(/disabled/)).toBeInTheDocument();
      });

      // Should not have actual input elements in the DOM
      const inputElements = document.querySelectorAll('input');
      expect(inputElements).toHaveLength(0);
    });
  });

  describe('Code Block Functionality', () => {
    it('renders code blocks with syntax highlighting', async () => {
      const content = `\`\`\`javascript
console.log('Hello, World!');
\`\`\``;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText(/console/)).toBeInTheDocument();
        expect(screen.getByText(/log/)).toBeInTheDocument();
        expect(screen.getByText(/Hello, World!/)).toBeInTheDocument();
      });
    });

    it('renders language-less fenced code as a block instead of inline code', async () => {
      const content = `\`\`\`
React + Electron + Vite
|-- session management
\`-- tool approval
\`\`\``;

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        const code = container.querySelector('pre code');
        expect(code).toBeInTheDocument();
        expect(code).not.toHaveClass('bg-inline-code');
        expect(code).toHaveTextContent('React + Electron + Vite');
        expect(code).toHaveTextContent('tool approval');
      });
    });

    it('renders inline code', async () => {
      const content = 'Use `console.log()` to debug.';

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText(/Use/)).toBeInTheDocument();
        expect(screen.getByText(/to debug/)).toBeInTheDocument();
        expect(screen.getByText('console.log()')).toBeInTheDocument();
        expect(container.querySelector('code')).toHaveClass('bg-inline-code');
      });
    });
  });

  describe('Markdown Features', () => {
    it('renders headers correctly', async () => {
      const content = `# H1 Header
## H2 Header
### H3 Header`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'H1 Header' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'H2 Header' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: 'H3 Header' })).toBeInTheDocument();
      });
    });

    it('renders lists correctly', async () => {
      const content = `- Item 1
- Item 2
- Item 3

1. Numbered 1
2. Numbered 2`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('Item 1')).toBeInTheDocument();
        expect(screen.getByText('Item 2')).toBeInTheDocument();
        expect(screen.getByText('Item 3')).toBeInTheDocument();
        expect(screen.getByText('Numbered 1')).toBeInTheDocument();
        expect(screen.getByText('Numbered 2')).toBeInTheDocument();
      });
    });

    it('renders links with correct attributes', async () => {
      const content = '[Visit Block](https://block.dev)';

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        const link = screen.getByRole('link', { name: 'Visit Block' });
        expect(link).toBeInTheDocument();
        expect(link).toHaveAttribute('href', 'https://block.dev');
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      });
    });

    it('renders tables correctly', async () => {
      const content = `| Name | Value |
|------|-------|
| Test | 123   |
| Demo | 456   |`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText('Name')).toBeInTheDocument();
        expect(screen.getByText('Value')).toBeInTheDocument();
        expect(screen.getByText('Test')).toBeInTheDocument();
        expect(screen.getByText('123')).toBeInTheDocument();
        expect(screen.getByText('Demo')).toBeInTheDocument();
        expect(screen.getByText('456')).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('handles empty content gracefully', async () => {
      renderWithIntl(<MarkdownContent content="" />);

      // Should not throw and should render the component
      const container = document.querySelector('.w-full.overflow-x-hidden');
      expect(container).toBeInTheDocument();
    });

    it('handles malformed markdown gracefully', async () => {
      const content = `# Unclosed header
[Unclosed link(https://example.com
\`\`\`
Unclosed code block`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        // Should still render what it can
        expect(screen.getByText('Unclosed header')).toBeInTheDocument();
      });
    });
  });

  describe('Line Break Functionality', () => {
    it('preserves single line breaks with remark-breaks plugin', async () => {
      const content = `First line
Second line
Third line`;

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        // Check that all text content is present (text may be split by <br> tags)
        expect(container).toHaveTextContent('First line');
        expect(container).toHaveTextContent('Second line');
        expect(container).toHaveTextContent('Third line');
      });

      // Check that line breaks are preserved (rendered as <br> tags)
      const brElements = container.querySelectorAll('br');
      expect(brElements.length).toBeGreaterThan(0);
    });

    it('handles mixed content with line breaks', async () => {
      const content = `# Header
Paragraph with
line breaks.

- List item 1
- List item 2`;

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Header' })).toBeInTheDocument();

        // Check that text content is present (text may be split by <br> tags)
        expect(container).toHaveTextContent('Paragraph with');
        expect(container).toHaveTextContent('line breaks.');
        expect(screen.getByText('List item 1')).toBeInTheDocument();
        expect(screen.getByText('List item 2')).toBeInTheDocument();
      });
    });

    it('maintains existing markdown features with line breaks', async () => {
      const content = `**Bold text**
with line break

\`code\` and
more text`;

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        // Bold text should still work
        const boldElement = container.querySelector('strong');
        expect(boldElement).toBeInTheDocument();
        expect(boldElement).toHaveTextContent('Bold text');

        // Code should still work
        expect(screen.getByText('code')).toBeInTheDocument();
      });
    });
  });

  describe('URL Overflow Handling', () => {
    it('handles very long URLs without overflow', async () => {
      const longUrl =
        'https://example-docs.com/document/d/1oruk3lcrnhoOXMFzBJB8X6qQ5AtQTmj4XXxXk3xK-3g/edit?usp=sharing&mode=edit&version=1';
      const content = `Check out this document: ${longUrl}

Another very long URL: https://www.example.com/very/long/path/with/many/segments/and/parameters?param1=value1&param2=value2&param3=value3&param4=value4&param5=value5`;

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText(/Check out this document/)).toBeInTheDocument();
        expect(screen.getByText(/Another very long URL/)).toBeInTheDocument();
      });

      // Check that URLs are rendered as links
      const links = container.querySelectorAll('a');
      expect(links.length).toBeGreaterThan(0);

      // Check that links have proper CSS classes for word breaking
      links.forEach((link) => {
        // The CSS should allow the text to break
        expect(link).toBeInTheDocument();
      });
    });

    it('handles markdown links with long URLs', async () => {
      const longUrl =
        'https://example-docs.com/document/d/1oruk3lcrnhoOXMFzBJB8X6qQ5AtQTmj4XXxXk3xK-3g/edit?usp=sharing&mode=edit&version=1';
      const content = `[Click here for the document](${longUrl})`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        const link = screen.getByRole('link', { name: 'Click here for the document' });
        expect(link).toBeInTheDocument();
        expect(link).toHaveAttribute('href', longUrl);
      });
    });

    it('handles multiple long URLs in the same message', async () => {
      const content = `Here are some long URLs:

1. Example Doc: https://example-docs.com/document/d/1oruk3lcrnhoOXMFzBJB8X6qQ5AtQTmj4XXxXk3xK-3g/edit?usp=sharing&mode=edit&version=1
2. Another long URL: https://www.example.com/very/long/path/with/many/segments/and/parameters?param1=value1&param2=value2&param3=value3
3. Third URL: https://api.example.com/v1/users/12345/documents/67890/attachments/abcdef123456789?format=json&include=metadata&sort=created_at`;

      renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(screen.getByText(/Here are some long URLs/)).toBeInTheDocument();
        expect(screen.getByText(/Example Doc/)).toBeInTheDocument();
        expect(screen.getByText(/Another long URL/)).toBeInTheDocument();
        expect(screen.getByText(/Third URL/)).toBeInTheDocument();
      });
    });

    it('applies word-break CSS classes to the container', () => {
      const content = 'Test content';
      renderWithIntl(<MarkdownContent content={content} />);

      const markdownContainer = document.querySelector('.prose');
      expect(markdownContainer).toBeInTheDocument();
      expect(markdownContainer).toHaveClass('prose-a:break-all');
      expect(markdownContainer).toHaveClass('prose-a:overflow-wrap-anywhere');
    });
  });

  describe('KaTeX Math Rendering - singleDollarTextMath: false', () => {
    it('treats single dollar signs as plain text', async () => {
      const content = 'The formula $x_i$ represents the i-th element.';

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        const katexElements = container.querySelectorAll('.katex');
        expect(katexElements.length).toBe(0);
        expect(container).toHaveTextContent('$x_i$');
      });
    });

    it('renders double dollar signs as display math', async () => {
      const content = `Calculate

$$
x^2 + y^2
$$

for the result.`;

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        const katexDisplay = container.querySelector('.katex-display');
        expect(katexDisplay).toBeInTheDocument();
      });
    });

    it('handles shell commands without triggering math mode', async () => {
      const content = 'Run echo "$FOO_BAR" to see the value.';

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        const katexElements = container.querySelectorAll('.katex');
        expect(katexElements.length).toBe(0);
        expect(container).toHaveTextContent('$FOO_BAR');
      });
    });

    it('preserves math in code blocks', async () => {
      const content = 'The formula `math\nx^2\n` uses inline code.';

      const { container } = renderWithIntl(<MarkdownContent content={content} />);

      await waitFor(() => {
        expect(container).toHaveTextContent('x^2');
      });
    });
  });
});

it('routes legacy file image syntax and local links to the scoped right panel without loading file URLs', () => {
  const opened = vi.fn();
  window.addEventListener('codebuddy:open-workspace-file', opened);
  try {
    const view = renderWithIntl(
      <MarkdownContent
        sessionId="media"
        content={'![Video](file:///D:/fixture/a%20b.mp4)\n\n[Image](D:/fixture/image.png)'}
      />
    );
    expect(view.container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    expect(opened.mock.calls[0][0].detail).toEqual({
      sessionId: 'media',
      filePath: 'D:/fixture/a b.mp4',
    });
    fireEvent.click(screen.getByRole('link', { name: 'Image' }));
    expect(opened.mock.calls[1][0].detail.filePath).toBe('D:/fixture/image.png');
  } finally {
    window.removeEventListener('codebuddy:open-workspace-file', opened);
  }
});
