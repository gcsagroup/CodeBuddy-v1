import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAgentMentionItems, listSlashCommandItems } from '../acp/autocomplete';
import { IntlTestWrapper } from '../i18n/test-utils';
import MentionPopover from './MentionPopover';
import { loadToolbox } from '../acp/toolbox';
vi.mock('../acp/toolbox', () => ({ loadToolbox: vi.fn() }));

vi.mock('../acp/autocomplete', () => ({
  listAgentMentionItems: vi.fn().mockResolvedValue([]),
  listSlashCommandItems: vi.fn().mockResolvedValue([]),
}));

describe('MentionPopover while the workspace is unbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadToolbox).mockResolvedValue({
      model: { methods: [], capabilities: [], external: [], apps: [] },
      errors: {},
      warnings: [],
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.electron.listFiles = vi.fn().mockResolvedValue([]);
  });

  it('shows Toolbox skills, MCP and built-in tools even when slash discovery is pending', async () => {
    vi.mocked(listSlashCommandItems).mockReturnValueOnce(new Promise(() => {}));
    const mcp = {
      id: 'external:fixture',
      name: 'Fixture MCP',
      description: 'Connected service',
      kind: 'external' as const,
      source: 'extension' as const,
      status: 'disabled' as const,
      actions: [],
    };
    vi.mocked(loadToolbox).mockResolvedValue({
      model: {
        methods: [
          {
            id: 'skill:office-docx',
            name: 'office-docx',
            description: 'Document skill',
            kind: 'skill',
            source: 'source',
            status: 'ready',
            actions: [],
          },
        ],
        capabilities: [
          {
            id: 'builtin:developer',
            name: 'Developer',
            description: 'Read and edit files',
            kind: 'builtin',
            source: 'extension',
            status: 'configured',
            actions: [],
          },
        ],
        external: [mcp],
        apps: [],
      },
      errors: {},
      warnings: [],
    });
    const onSelect = vi.fn();
    render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        position={{ x: 0, y: 600 }}
        query=""
        isSlashCommand
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir="/fixture"
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByRole('option', { name: /office-docx/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /Developer/ })).toBeVisible();
    const entry = screen.getByRole('option', { name: /Fixture MCP/ });
    expect(entry).toHaveTextContent('Disabled');
    fireEvent.click(entry);
    expect(onSelect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ toolboxItem: mcp })
    );
    expect(loadToolbox).toHaveBeenCalledWith('/fixture', undefined);
  });

  it('shows local goal and plan commands while remote commands are pending and selects by click', async () => {
    vi.mocked(listSlashCommandItems).mockReturnValueOnce(new Promise(() => {}));
    const onSelect = vi.fn();
    const { rerender } = render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        position={{ x: 300, y: 400 }}
        query=""
        isSlashCommand
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByRole('option', { name: /^Goal \/goal/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /^Plan \/plan / })).toBeVisible();
    rerender(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        position={{ x: 300, y: 400 }}
        query="permission"
        isSlashCommand
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
      />
    );
    fireEvent.click(await screen.findByRole('option', { name: /^Permissions/ }));
    expect(onSelect).toHaveBeenCalledWith('/permission ');
    expect(screen.queryByRole('option', { name: /^Goal \/goal/ })).toBeNull();
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
