import { useEffect, useState } from 'react';
import { FolderKanban, Sparkles } from 'lucide-react';
import { getConfiguredExtensions, setConfigExtensionEnabled } from '../../../acp/extensions';
import { readPreferences, savePreferences } from '../../../acp/preferences';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { Switch } from '../../ui/switch';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import ProjectMemoryRecords from './ProjectMemoryRecords';

const PROJECT_MEMORY_EXTENSION = 'projectmemory';
const PERSONALIZED_MEMORY_PREFERENCE = 'personalizedMemoryEnabled' as const;

const i18n = defineMessages({
  title: { id: 'memorySettings.title', defaultMessage: 'Memory' },
  description: {
    id: 'memorySettings.description',
    defaultMessage: 'Control what CodeBuddy can remember across conversations.',
  },
  controls: { id: 'memorySettings.controls', defaultMessage: 'Memory controls' },
  projectMemory: { id: 'memorySettings.projectMemory', defaultMessage: 'Project memory' },
  toggleDescription: {
    id: 'memorySettings.toggleDescription',
    defaultMessage:
      'Turning this off stops new memory writes and recall without deleting stored records.',
  },
  enableProjectMemory: {
    id: 'memorySettings.enableProjectMemory',
    defaultMessage: 'Enable project memory',
  },
  personalizedMemory: {
    id: 'memorySettings.personalizedMemory',
    defaultMessage: 'Remember my working habits',
  },
  personalizedMemoryDescription: {
    id: 'memorySettings.personalizedMemoryDescription',
    defaultMessage:
      'Learn stable, low-risk preferences such as language, answer format, tools, testing, and workflow. Sensitive personal details and one-off requests are not saved automatically.',
  },
  enablePersonalizedMemory: {
    id: 'memorySettings.enablePersonalizedMemory',
    defaultMessage: 'Automatically remember my working habits',
  },
  personalizedMemoryRequiresProjectMemory: {
    id: 'memorySettings.personalizedMemoryRequiresProjectMemory',
    defaultMessage: 'Turn on project memory to use automatic personalization.',
  },
  personalizationOffRetention: {
    id: 'memorySettings.personalizationOffRetention',
    defaultMessage: 'Turning this off stops automatic learning and keeps existing memories.',
  },
  on: { id: 'memorySettings.on', defaultMessage: 'On' },
  off: { id: 'memorySettings.off', defaultMessage: 'Off' },
  manage: { id: 'memorySettings.manage', defaultMessage: 'Manage project memory' },
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function MemorySettingsSection() {
  const intl = useIntl();
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryConfigKey, setMemoryConfigKey] = useState(PROJECT_MEMORY_EXTENSION);
  const [memoryTogglePending, setMemoryTogglePending] = useState(false);
  const [personalizedMemoryEnabled, setPersonalizedMemoryEnabled] = useState(false);
  const [personalizedMemoryEditable, setPersonalizedMemoryEditable] = useState(false);
  const [personalizedMemoryPending, setPersonalizedMemoryPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRecords, setShowRecords] = useState(false);

  useEffect(() => {
    void getConfiguredExtensions()
      .then(({ extensions }) => {
        const projectMemory = extensions.find(
          (extension) =>
            extension.configKey === PROJECT_MEMORY_EXTENSION ||
            extension.name === PROJECT_MEMORY_EXTENSION
        );
        if (projectMemory) {
          setMemoryEnabled(projectMemory.enabled);
          setMemoryConfigKey(projectMemory.configKey ?? PROJECT_MEMORY_EXTENSION);
        }
      })
      .catch((configError) => setError(errorText(configError)));
  }, []);

  useEffect(() => {
    void readPreferences([PERSONALIZED_MEMORY_PREFERENCE])
      .then((snapshot) => {
        const preference = snapshot.values.find(
          ({ key }) => key === PERSONALIZED_MEMORY_PREFERENCE
        );
        if (!preference || preference.value === null) {
          setPersonalizedMemoryEnabled(false);
          setPersonalizedMemoryEditable(preference?.isMutable ?? true);
          return;
        }
        if (typeof preference.value !== 'boolean') {
          setPersonalizedMemoryEditable(false);
          return;
        }
        setPersonalizedMemoryEnabled(preference.value);
        setPersonalizedMemoryEditable(preference.isMutable);
      })
      .catch((preferenceError) => setError(errorText(preferenceError)));
  }, []);

  const setProjectMemoryEnabled = async (enabled: boolean) => {
    setMemoryTogglePending(true);
    setError(null);
    try {
      await setConfigExtensionEnabled(memoryConfigKey, enabled);
      setMemoryEnabled(enabled);
    } catch (toggleError) {
      setError(errorText(toggleError));
    } finally {
      setMemoryTogglePending(false);
    }
  };

  const setPersonalizationEnabled = async (enabled: boolean) => {
    if (personalizedMemoryPending || !personalizedMemoryEditable) return;
    setPersonalizedMemoryPending(true);
    setError(null);
    try {
      const snapshot = await savePreferences([
        { key: PERSONALIZED_MEMORY_PREFERENCE, value: enabled, isMutable: true },
      ]);
      const preference = snapshot.values.find(({ key }) => key === PERSONALIZED_MEMORY_PREFERENCE);
      if (!preference || typeof preference.value !== 'boolean') {
        throw new Error('Invalid personalized memory preference');
      }
      setPersonalizedMemoryEnabled(preference.value);
      setPersonalizedMemoryEditable(preference.isMutable);
    } catch (preferenceError) {
      setError(errorText(preferenceError));
    } finally {
      setPersonalizedMemoryPending(false);
    }
  };

  return (
    <section className="mt-1 space-y-4 pr-4 pb-8" aria-label={intl.formatMessage(i18n.title)}>
      <Card className="gap-0 overflow-hidden rounded-lg py-0">
        <CardHeader className="gap-1 border-b border-border-subtle py-4">
          <CardTitle>{intl.formatMessage(i18n.controls)}</CardTitle>
          <CardDescription>{intl.formatMessage(i18n.description)}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border-subtle px-0">
          <div className="flex items-center justify-between gap-6 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <FolderKanban className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" />
              <div>
                <div className="text-sm font-medium">{intl.formatMessage(i18n.projectMemory)}</div>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  {intl.formatMessage(i18n.toggleDescription)}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
              {intl.formatMessage(memoryEnabled ? i18n.on : i18n.off)}
              <Switch
                aria-label={intl.formatMessage(i18n.enableProjectMemory)}
                checked={memoryEnabled}
                disabled={memoryTogglePending}
                onCheckedChange={(checked) => void setProjectMemoryEnabled(checked)}
                variant="mono"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-6 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" />
              <div>
                <div className="text-sm font-medium">
                  {intl.formatMessage(i18n.personalizedMemory)}
                </div>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  {intl.formatMessage(i18n.personalizedMemoryDescription)}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {intl.formatMessage(
                    memoryEnabled
                      ? i18n.personalizationOffRetention
                      : i18n.personalizedMemoryRequiresProjectMemory
                  )}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
              {intl.formatMessage(personalizedMemoryEnabled ? i18n.on : i18n.off)}
              <Switch
                aria-label={intl.formatMessage(i18n.enablePersonalizedMemory)}
                checked={personalizedMemoryEnabled}
                disabled={
                  personalizedMemoryPending || !personalizedMemoryEditable || !memoryEnabled
                }
                onCheckedChange={(checked) => void setPersonalizationEnabled(checked)}
                variant="mono"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Button
        variant="outline"
        aria-expanded={showRecords}
        onClick={() => setShowRecords(!showRecords)}
      >
        {intl.formatMessage(i18n.manage)}
      </Button>
      {showRecords && <ProjectMemoryRecords />}

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
