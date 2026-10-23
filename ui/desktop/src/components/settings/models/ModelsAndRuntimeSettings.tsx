import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, RefreshCw } from 'lucide-react';
import type { View } from '../../../utils/navigationUtils';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { acpListProviderDetails } from '../../../acp/providers';
import type { ProviderDetails } from '../../../types/providers';
import SubagentTemplateSettings from './SubagentTemplateSettings';
import { CodeProModelModal } from '../../codepro/CodeProModelModal';
import ProviderGrid from '../providers/ProviderGrid';
import ModelsSection from './ModelsSection';
import ModelImageCapabilitySettings from './ModelImageCapabilitySettings';
import ModelContextSettings from './ModelContextSettings';
import ImageGenerationSettings from './ImageGenerationSettings';

const i18n = defineMessages({
  auxiliaryVision: {
    id: 'modelsAndRuntime.auxiliaryVision',
    defaultMessage: 'Auxiliary vision settings',
  },
  codeBuddyModel: {
    id: 'modelsAndRuntime.codeBuddyModel',
    defaultMessage: 'CodeBuddy model',
  },
  codeBuddyModelDescription: {
    id: 'modelsAndRuntime.codeBuddyModelDescription',
    defaultMessage: 'The first-party CodeBuddy model is still in development.',
  },
  inDevelopment: {
    id: 'modelsAndRuntime.inDevelopment',
    defaultMessage: 'In development',
  },
  customConnections: {
    id: 'modelsAndRuntime.customConnections',
    defaultMessage: 'Custom model connections',
  },
  customConnectionsDescription: {
    id: 'modelsAndRuntime.customConnectionsDescription',
    defaultMessage:
      'Connect a local, LAN, or self-hosted endpoint. Built-in vendor catalogues stay out of everyday settings.',
  },
  loadingConnections: {
    id: 'modelsAndRuntime.loadingConnections',
    defaultMessage: 'Loading custom connections…',
  },
  connectionsUnavailable: {
    id: 'modelsAndRuntime.connectionsUnavailable',
    defaultMessage:
      'Custom connections could not be loaded. Your saved configuration was not changed.',
  },
  retry: {
    id: 'modelsAndRuntime.retry',
    defaultMessage: 'Retry',
  },
});

interface ModelsAndRuntimeSettingsProps {
  setView: (view: View) => void;
}

export default function ModelsAndRuntimeSettings({ setView }: ModelsAndRuntimeSettingsProps) {
  const intl = useIntl();
  const [visionSettingsOpen, setVisionSettingsOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);

  const loadCustomConnections = useCallback(async () => {
    setConnectionsLoading(true);
    setConnectionsFailed(false);
    try {
      setProviders(await acpListProviderDetails());
      setConnectionsLoaded(true);
    } catch {
      setConnectionsFailed(true);
    } finally {
      setConnectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCustomConnections();
  }, [loadCustomConnections]);

  const customProviders = useMemo(
    () =>
      providers.filter(
        (provider) => provider.provider_type === 'Custom' && provider.category !== 'agent'
      ),
    [providers]
  );
  const configuredProviders = useMemo(
    () => customProviders.filter((provider) => provider.is_configured),
    [customProviders]
  );

  return (
    <div className="space-y-4 pb-8">
      <Card className="rounded-lg border-dashed">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex gap-3">
              <div className="rounded-md bg-purple-500/10 p-2 text-purple-500">
                <FlaskConical className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>{intl.formatMessage(i18n.codeBuddyModel)}</CardTitle>
                <CardDescription>
                  {intl.formatMessage(i18n.codeBuddyModelDescription)}
                </CardDescription>
              </div>
            </div>
            <span className="rounded-full bg-yellow-500/10 px-3 py-1 text-xs font-medium text-yellow-600">
              {intl.formatMessage(i18n.inDevelopment)}
            </span>
          </div>
        </CardHeader>
      </Card>

      <ModelsSection setView={setView} showProviderConfiguration={false} />

      <Card className="rounded-lg">
        <CardHeader className="pb-3">
          <CardTitle>{intl.formatMessage(i18n.customConnections)}</CardTitle>
          <CardDescription>{intl.formatMessage(i18n.customConnectionsDescription)}</CardDescription>
        </CardHeader>
        <CardContent>
          {connectionsLoading && !connectionsLoaded && (
            <p className="py-6 text-center text-sm text-text-muted">
              {intl.formatMessage(i18n.loadingConnections)}
            </p>
          )}
          {connectionsFailed && (
            <div className="flex items-center justify-between gap-4 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-4">
              <p className="text-sm text-yellow-700">
                {intl.formatMessage(i18n.connectionsUnavailable)}
              </p>
              <Button variant="outline" size="sm" onClick={() => void loadCustomConnections()}>
                <RefreshCw className="h-4 w-4" />
                {intl.formatMessage(i18n.retry)}
              </Button>
            </div>
          )}
          {connectionsLoaded && (
            <ProviderGrid
              providers={customProviders}
              isOnboarding={false}
              refreshProviders={loadCustomConnections}
              setView={setView}
              compactConnectionSetup
            />
          )}
        </CardContent>
      </Card>

      <SubagentTemplateSettings providers={configuredProviders} />
      <Button variant="outline" onClick={() => setVisionSettingsOpen(true)}>
        {intl.formatMessage(i18n.auxiliaryVision)}
      </Button>
      {visionSettingsOpen && (
        <CodeProModelModal
          visionOnly
          onClose={() => setVisionSettingsOpen(false)}
          onConfigureProvider={() => {
            setVisionSettingsOpen(false);
            setView('ConfigureProviders');
          }}
        />
      )}
      <ModelImageCapabilitySettings providers={configuredProviders} />
      <ImageGenerationSettings />
      <ModelContextSettings providers={configuredProviders} />
    </div>
  );
}
