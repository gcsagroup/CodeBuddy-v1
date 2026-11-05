import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ConversationReferences } from './ConversationReferences';
import { conversationMention } from './conversationMention';

it('removes the selected occurrence without removing other references or the draft', () => {
  const first = conversationMention('one', '方案 [一]');
  const second = conversationMention('two', '方案 [一]');
  const onChange = vi.fn();
  render(
    <ConversationReferences text={'比较 ' + first + second + '保留这句话'} onChange={onChange} />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove reference: 方案 [一]' })[1]);
  expect(onChange).toHaveBeenCalledWith('比较 ' + first + ' 保留这句话');
});
