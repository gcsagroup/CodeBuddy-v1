import { AppEvents } from '../../../constants/events';
import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../../i18n';
import { all_response_styles, ResponseStyleSelectionItem } from './ResponseStyleSelectionItem';

const i18n = defineMessages({
  saveError: {
    id: 'codeProModels.saveError',
    defaultMessage: 'Failed to save. Try again later.',
  },
});

export const ResponseStylesSection = () => {
  const intl = useIntl();
  const [currentStyle, setCurrentStyle] = useState('concise');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadResponseStyle() {
      try {
        const savedStyle = await window.electron.getSetting('responseStyle');
        setCurrentStyle(savedStyle);
      } catch (error) {
        console.error('Error loading response style:', error);
      }
    }
    void loadResponseStyle();
  }, []);

  const handleStyleChange = async (newStyle: string) => {
    if (isSaving || newStyle === currentStyle) return;

    setIsSaving(true);
    setError(null);
    try {
      await window.electron.setSetting('responseStyle', newStyle);
      setCurrentStyle(newStyle);
      window.dispatchEvent(new CustomEvent(AppEvents.RESPONSE_STYLE_CHANGED));
    } catch (saveError) {
      console.error('Error saving response style:', saveError);
      setError(intl.formatMessage(i18n.saveError));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {all_response_styles.map((style) => (
        <ResponseStyleSelectionItem
          key={style.key}
          style={style}
          currentStyle={currentStyle}
          showDescription={true}
          disabled={isSaving}
          handleStyleChange={handleStyleChange}
        />
      ))}
      {error && (
        <p role="alert" className="text-xs text-red-500 px-2 pt-1">
          {error}
        </p>
      )}
    </div>
  );
};
