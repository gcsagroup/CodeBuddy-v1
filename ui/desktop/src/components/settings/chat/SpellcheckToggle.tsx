import { useState, useEffect } from 'react';
import { Switch } from '../../ui/switch';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  title: {
    id: 'spellcheckToggle.title',
    defaultMessage: 'Enable Spellcheck',
  },
  description: {
    id: 'spellcheckToggle.description',
    defaultMessage: 'Check spelling in the chat input. Requires restart to take effect.',
  },
  saveError: {
    id: 'codeProModels.saveError',
    defaultMessage: 'Failed to save. Try again later.',
  },
});

export const SpellcheckToggle = () => {
  const intl = useIntl();
  const [enabled, setEnabled] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadState = async () => {
      try {
        const state = await window.electron.getSpellcheckState();
        setEnabled(state);
      } catch (loadError) {
        console.error('Error loading spellcheck setting:', loadError);
      }
    };
    void loadState();
  }, []);

  const handleToggle = async (checked: boolean) => {
    if (isSaving || checked === enabled) return;

    setIsSaving(true);
    setError(null);
    try {
      await window.electron.setSpellcheck(checked);
      setEnabled(checked);
    } catch (saveError) {
      console.error('Error saving spellcheck setting:', saveError);
      setError(intl.formatMessage(i18n.saveError));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex items-center justify-between py-2 px-2 hover:bg-background-secondary rounded-lg transition-all">
      <div>
        <h3 className="text-text-primary">{intl.formatMessage(i18n.title)}</h3>
        <p className="text-xs text-text-secondary max-w-md mt-[2px]">
          {intl.formatMessage(i18n.description)}
        </p>
        {error && (
          <p role="alert" className="text-xs text-red-500 max-w-md mt-1">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center">
        <Switch
          checked={enabled}
          disabled={isSaving}
          aria-label={intl.formatMessage(i18n.title)}
          onCheckedChange={(checked) => void handleToggle(checked)}
          variant="mono"
        />
      </div>
    </div>
  );
};
