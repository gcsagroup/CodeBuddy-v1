import { Children, isValidElement, useState, type ReactNode } from 'react';
import { currentLocale } from '../../i18n';
import { selectNativeText } from '../../utils/nativeLocalization';
import { Select } from './Select';

export const SHORT_LIST_LIMIT = 6;

interface Props {
  children: ReactNode;
  id?: string;
  'aria-label'?: string;
  value: string | number;
  disabled?: boolean;
  className?: string;
  onValueChange: (value: string) => void;
}

interface Choice {
  label: string;
  value: string;
  isDisabled: boolean;
}

// Accept the same option and optgroup markup for both the short and searchable views.
function collectOptions(children: ReactNode, group = '', disabled = false): Choice[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<React.OptionHTMLAttributes<HTMLOptionElement>>(child)) return [];
    const props = child.props;
    if (child.type === 'optgroup') {
      return collectOptions(props.children, props.label, disabled || props.disabled);
    }
    const text = props.label ?? Children.toArray(props.children).join('').trim();
    return [
      {
        value: String(props.value ?? text),
        label: group && !text.includes(group) ? `${text} · ${group}` : text,
        isDisabled: Boolean(disabled || props.disabled),
      },
    ];
  });
}

export function SearchableSelect({ children, value, onValueChange, ...props }: Props) {
  const [open, setOpen] = useState(false);
  const options = collectOptions(children);
  if (options.length <= SHORT_LIST_LIMIT) {
    return (
      <select {...props} value={value} onChange={(e) => onValueChange(e.target.value)}>
        {children}
      </select>
    );
  }
  const selected = options.find((option) => option.value === String(value));
  const search = selectNativeText(
    currentLocale,
    'Type to search…',
    '输入关键词搜索…',
    '輸入關鍵字搜尋…'
  );
  return (
    <Select
      inputId={props.id}
      aria-label={props['aria-label']}
      isDisabled={props.disabled}
      controlClassName={props.className}
      value={selected ?? null}
      options={selected?.value ? [selected, ...options.filter((o) => o !== selected)] : options}
      controlShouldRenderValue={!open}
      placeholder={search}
      noOptionsMessage={() =>
        selectNativeText(currentLocale, 'No matches', '没有匹配项', '沒有符合項目')
      }
      maxMenuHeight={196}
      minMenuHeight={80}
      menuPlacement="auto"
      menuShouldScrollIntoView
      tabSelectsValue={false}
      onMenuOpen={() => setOpen(true)}
      onMenuClose={() => setOpen(false)}
      onChange={(option) => {
        if (option) onValueChange((option as Choice).value);
      }}
    />
  );
}
