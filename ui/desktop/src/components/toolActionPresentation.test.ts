import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { formatToolAction } from './toolActionPresentation';

const intl = createIntl({ locale: 'en', messages: {} });
describe('live file generation', () => {
  it('counts received draft lines without claiming a write and drops draft wording for execution', () => {
    const args = { path: 'src/app.js', content: 'first\nsecond\n', __inputPreview: true };
    expect(formatToolAction(intl, 'write', args, 'running')).toBe(
      'Generating app.js · 2 lines received — not saved yet'
    );
    expect(formatToolAction(intl, 'write', { ...args, __inputPreview: undefined }, 'running')).toBe(
      'Write file app.js · in progress'
    );
    expect(formatToolAction(intl, 'write', args, 'completed')).toBe('Wrote file app.js');
  });
});
