import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolActivityIcon } from './ToolActivityIcon';

function iconClass(name: string, status: 'loading' | 'success' = 'loading') {
  const { container } = render(<ToolActivityIcon name={name} status={status} />);
  return container.querySelector('svg')?.getAttribute('class') ?? '';
}

describe('ToolActivityIcon', () => {
  it('keeps the operation recognizable while it is running', () => {
    expect(iconClass('thinking')).toContain('lucide-atom');
    expect(iconClass('developer__edit')).toContain('lucide-code-xml');
    expect(iconClass('developer__shell')).toContain('lucide-terminal');
    expect(iconClass('developer__read_file')).toContain('lucide-file-search');
    expect(iconClass('developer__web_search_exa')).toContain('lucide-globe');
    expect(iconClass('generate_image')).toContain('lucide-image-plus');
  });

  it('uses the same operation icon after completion', () => {
    expect(iconClass('developer__shell', 'loading')).toContain('lucide-terminal');
    expect(iconClass('developer__shell', 'success')).toContain('lucide-terminal');
  });
});
