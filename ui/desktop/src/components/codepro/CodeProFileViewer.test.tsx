import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'react-intl';
import zhMessages from '../../i18n/compiled/zh-CN.json';
import { CodeProFileViewer } from './CodeProFileViewer';
import { FileChangeDiff } from './CodeProFileChange';

describe('CodeProFileViewer', () => {
  it('discards a read that finishes after switching workspaces and reports read failures', async () => {
    let complete!: (value: { file: string; filePath: string; found: boolean; error: null }) => void;
    window.electron.readWorkspaceFile = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const view = render(
      <IntlProvider locale="en" messages={{}}>
        <CodeProFileViewer files={['app.html']} workspaceRoot="C:/one" />
      </IntlProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'app.html' }));
    view.rerender(
      <IntlProvider locale="en" messages={{}}>
        <CodeProFileViewer files={['app.html']} workspaceRoot="C:/two" />
      </IntlProvider>
    );
    await act(async () =>
      complete({
        file: 'old workspace content',
        filePath: 'C:/one/app.html',
        found: true,
        error: null,
      })
    );
    expect(screen.queryByText('old workspace content')).not.toBeInTheDocument();
    window.electron.readWorkspaceFile = vi.fn().mockRejectedValue(new Error('missing'));
    fireEvent.click(screen.getByRole('button', { name: 'app.html' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the file.');
  });
  beforeEach(() => {
    window.electron.readWorkspaceFile = vi.fn().mockResolvedValue({
      file: '# 项目说明',
      filePath: 'D:\\project\\README.md',
      error: null,
      found: true,
    });
  });

  it('opens a changed document inside the right panel', async () => {
    render(
      <IntlProvider locale="zh-CN" messages={zhMessages}>
        <CodeProFileViewer files={['README.md']} workspaceRoot={'D:\\project'} />
      </IntlProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'README.md' }));

    await waitFor(() =>
      expect(window.electron.readWorkspaceFile).toHaveBeenCalledWith('D:\\project', 'README.md')
    );
    expect(await screen.findByText('项目说明')).toBeVisible();
  });

  it('uses the current language while preserving file paths', () => {
    const { rerender } = render(
      <IntlProvider locale="en" messages={{}}>
        <CodeProFileViewer files={[]} workspaceRoot={'D:\\project'} />
      </IntlProvider>
    );

    expect(
      screen.getByText('Files read or changed by this task will appear here.')
    ).toBeInTheDocument();

    rerender(
      <IntlProvider locale="zh-CN" messages={zhMessages}>
        <CodeProFileViewer files={['D:\\project\\README.md']} workspaceRoot={'D:\\project'} />
      </IntlProvider>
    );

    expect(screen.getByRole('button', { name: 'D:\\project\\README.md' })).toBeInTheDocument();
  });
});

describe('file change presentation', () => {
  it('keeps real old/new positions across hunks and does not number diff metadata', () => {
    const { container } = render(
      <FileChangeDiff
        change={{
          path: 'app.py',
          added: 2,
          removed: 2,
          diff_truncated: true,
          diff: '--- old\n+++ new\n@@ -7,2 +7,2 @@\n-old value\n+new value\n context\n@@ -20 +21 @@\n-another old\n+another new\n\\ No newline at end of file',
        }}
      />
    );
    const rows = [...container.querySelectorAll('[data-diff-kind]')];
    expect(rows.map((row) => row.firstElementChild?.textContent?.trim())).toEqual([
      '',
      '',
      '',
      '7',
      '7',
      '8',
      '',
      '20',
      '21',
      '',
    ]);
    expect(rows[0]).toHaveAttribute('data-diff-kind', 'meta');
    expect(rows[1]).toHaveAttribute('data-diff-kind', 'meta');
    expect(rows[3]).toHaveAttribute('data-diff-kind', 'removed');
    expect(rows[4]).toHaveAttribute('data-diff-kind', 'added');
    expect(screen.getByText('…')).toBeVisible();
  });

  it('shows all supplied write receipts without replacing them with current file contents', () => {
    vi.mocked(window.electron.readWorkspaceFile).mockClear();
    const changes = ['@@ -7 +7 @@\n-before\n+after', '@@ -22 +22 @@\n-older\n+newer'].map(
      (diff) => ({ path: 'app.py', added: 1, removed: 1, diff, diff_truncated: false })
    );
    render(
      <IntlProvider locale="en" messages={{}}>
        <CodeProFileViewer
          files={['app.py']}
          workspaceRoot="C:/fixture"
          changesForFile={() => changes}
        />
      </IntlProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'app.py' }));
    expect(screen.getByText('+after')).toBeVisible();
    expect(screen.getByText('+newer')).toBeVisible();
    expect(window.electron.readWorkspaceFile).not.toHaveBeenCalled();
    const trigger = screen.getByRole('button', { name: 'app.py' });
    expect(trigger).toHaveTextContent('+2');
    expect(trigger).toHaveTextContent('−2');
    expect(trigger.querySelector('.lucide-chevron-right')).not.toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('+after')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByText('+after')).toBeVisible();
  });
});
