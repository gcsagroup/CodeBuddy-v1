import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import ChatSettingsSection from './ChatSettingsSection';

vi.mock('../mode/ModeSection', () => ({
  ModeSection: () => <div>mode-section</div>,
}));

vi.mock('../response_styles/ResponseStylesSection', () => ({
  ResponseStylesSection: () => <div>response-styles-section</div>,
}));

vi.mock('./GlobalInstructionsSection', () => ({
  GlobalInstructionsSection: () => <div>global-instructions-section</div>,
}));

describe('ChatSettingsSection', () => {
  it('shows global instructions without a manual project-instructions picker', () => {
    render(<ChatSettingsSection />, { wrapper: IntlTestWrapper });

    expect(screen.getByText('global-instructions-section')).toBeInTheDocument();
    expect(screen.getByText('response-styles-section')).toBeInTheDocument();
    expect(screen.queryByText('mode-section')).not.toBeInTheDocument();
    expect(screen.queryByText('project-instructions-section')).not.toBeInTheDocument();
  });
});
