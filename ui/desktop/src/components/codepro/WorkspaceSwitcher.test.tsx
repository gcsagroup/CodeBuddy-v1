import { render as testingRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

describe('WorkspaceSwitcher', () => {
  it('marks CodePro as selected and switches back to Code', async () => {
    const onChange = vi.fn();
    render(<WorkspaceSwitcher mode="codepro" onChange={onChange} />);

    expect(screen.getByRole('group', { name: 'Workspace switcher' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CodePro' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Code' }));

    expect(onChange).toHaveBeenCalledWith('code');
  });

  it('is hidden while unified mode owns the new-chat entry', () => {
    render(<WorkspaceSwitcher mode="codepro" onChange={vi.fn()} unifiedMode />);

    expect(screen.queryByRole('group', { name: 'Workspace switcher' })).not.toBeInTheDocument();
  });
});
