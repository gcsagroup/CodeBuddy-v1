import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { CodeProWorkStep } from './CodeProWorkStep';

it('routes source links in a progress message to its own conversation', () => {
  const opened = vi.fn();
  window.addEventListener('codebuddy:open-workspace-file', opened);
  try {
    const view = render(
      <CodeProWorkStep
        sessionId="source-progress"
        text="已找到原因：[源码](../runtime/providers.mjs#L644)。"
        streaming={false}
        settled={false}
        summary=""
        operationCount={0}
        storageKey="source-progress"
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(view.getByRole('link', { name: '源码' }));
    expect(opened.mock.calls[0][0].detail).toEqual({
      sessionId: 'source-progress',
      filePath: '../runtime/providers.mjs',
    });
  } finally {
    window.removeEventListener('codebuddy:open-workspace-file', opened);
  }
});
