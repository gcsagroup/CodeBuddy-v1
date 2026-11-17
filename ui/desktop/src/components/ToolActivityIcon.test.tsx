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
    expect(iconClass('developer__edit')).toContain('lucide-pencil');
    expect(iconClass('developer__shell')).toContain('lucide-terminal');
    expect(iconClass('developer__read_file')).toContain('lucide-file-search');
    expect(iconClass('developer__web_search_exa')).toContain('lucide-globe');
    expect(iconClass('generate_image')).toContain('lucide-image-plus');
  });

  it('uses the same operation icon after completion', () => {
    expect(iconClass('developer__shell', 'loading')).toContain('lucide-terminal');
    expect(iconClass('developer__shell', 'success')).toContain('lucide-terminal');
  });

  it('keeps tool operations grey while running and after completion', () => {
    for (const name of ['developer__write', 'developer__edit', 'developer__apply_patch', 'developer__write_file', 'developer__shell', 'developer__read_file', 'generate_image']) {
      for (const status of ['loading', 'success'] as const) {
        const classes = iconClass(name, status);
        if (['developer__write', 'developer__edit', 'developer__apply_patch', 'developer__write_file'].includes(name)) {
          expect(classes).toContain('lucide-pencil');
        }
        expect(classes).toContain('text-text-secondary');
        expect(classes).not.toContain('text-blue-500');
      }
    }
  });

  it('can keep the active icon still when a surrounding status transition supplies motion', () => {
    const { container } = render(<ToolActivityIcon name="developer__edit" status="loading" animated={false} />);
    expect(container.querySelector('.lucide-pencil')).not.toHaveClass('motion-safe:animate-pulse');
  });
});
