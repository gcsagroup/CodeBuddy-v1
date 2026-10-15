import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAgentMentionItems, listSlashCommandItems } from '../acp/autocomplete';
import { IntlTestWrapper } from '../i18n/test-utils';
import MentionPopover from './MentionPopover';

vi.mock('../acp/autocomplete', () => ({
  listAgentMentionItems: vi.fn().mockResolvedValue([]),
  listSlashCommandItems: vi.fn().mockResolvedValue([]),
}));

describe('MentionPopover while the workspace is unbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electron.listFiles = vi.fn().mockResolvedValue([]);
  });

  it('does not scan workspace mentions or files without a workspace', async () => {
    render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        position={{ x: 0, y: 0 }}
        query=""
        isSlashCommand={false}
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
      />,
      { wrapper: IntlTestWrapper }
    );

    await waitFor(() => {
      expect(listAgentMentionItems).not.toHaveBeenCalled();
      expect(listSlashCommandItems).not.toHaveBeenCalled();
      expect(window.electron.listFiles).not.toHaveBeenCalled();
    });
  });

  it('loads built-in slash commands without requiring a workspace', async () => {
    render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        position={{ x: 0, y: 0 }}
        query=""
        isSlashCommand
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
      />,
      { wrapper: IntlTestWrapper }
    );

    await waitFor(() => expect(listSlashCommandItems).toHaveBeenCalledWith('', undefined));
    expect(listAgentMentionItems).not.toHaveBeenCalled();
    expect(window.electron.listFiles).not.toHaveBeenCalled();
  });
});
