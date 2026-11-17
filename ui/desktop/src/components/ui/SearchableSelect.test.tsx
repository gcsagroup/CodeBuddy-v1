import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SearchableSelect } from './SearchableSelect';

it('finds a duplicate model by connection and returns its exact value only when selected', () => {
  const change = vi.fn();
  render(
    <SearchableSelect aria-label="Model" value="old" onValueChange={change}>
      <option value="old" disabled>
        Previously saved
      </option>
      {Array.from({ length: 60 }, (_, i) => (
        <optgroup label={`Connection ${i}`} key={i}>
          <option value={String(i)}>Shared model</option>
        </optgroup>
      ))}
    </SearchableSelect>
  );
  const input = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('Previously saved');
  expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-disabled', 'true');
  fireEvent.change(input, { target: { value: 'absent' } });
  expect(screen.queryByRole('option')).toBeNull();
  fireEvent.change(input, { target: { value: 'CONNECTION 59' } });
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('option', { name: 'Shared model · Connection 59' }));
  expect(change).toHaveBeenCalledWith('59');
});
