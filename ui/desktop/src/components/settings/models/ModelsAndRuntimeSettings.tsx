import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Image, ScanEye, SlidersHorizontal, Plug, RefreshCw } from 'lucide-react';
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
import SettingsMenu from '../SettingsMenu';
import ExternalBackendSection from '../app/ExternalBackendSection';

const i18n = defineMessages({
  connections: { id: 'modelsAndRuntime.connections', defaultMessage: 'Models and connections' },
  subagents: { id: 'modelsAndRuntime.subagents', defaultMessage: 'Subagents' },
  subagentsDescription: {
    id: 'modelsAndRuntime.subagentsDescription',
    defaultMessage: 'Create reusable agents with a name, model and prompt.',
  },
  vision: { id: 'modelsAndRuntime.vision', defaultMessage: 'Image understanding' },
  visionDescription: {
    id: 'modelsAndRuntime.visionDescription',
    defaultMessage: 'Use the main model first, with a backup when needed.',
  },
  generation: { id: 'modelsAndRuntime.generation', defaultMessage: 'Image and video generation' },
  generationDescription: {
    id: 'modelsAndRuntime.generationDescription',
    defaultMessage: 'Configure the service used to generate images and videos.',
  },
  context: { id: 'modelsAndRuntime.context', defaultMessage: 'Context capacity' },
  contextDescription: {
    id: 'modelsAndRuntime.contextDescription',
    defaultMessage: 'Adjust model context limits when service information is unavailable.',
  },
  auxiliaryVision: {
    id: 'modelsAndRuntime.auxiliaryVision',
    defaultMessage: 'Backup image model settings',
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
  onDirtyChange?: (dirty: boolean) => void;
  active?: boolean;
}

export default function ModelsAndRuntimeSettings({
  setView,
  onDirtyChange,
  active = true,
}: ModelsAndRuntimeSettingsProps) {
  const intl = useIntl();
  const [visionSettingsOpen, setVisionSettingsOpen] = useState(false);
  const [subagentDirty, setSubagentDirty] = useState(false);
  const [subagentEditing, setSubagentEditing] = useState(false);
  const handleDirtyChange = useCallback(
    (dirty: boolean) => {
      setSubagentDirty(dirty);
      onDirtyChange?.(dirty);
    },
    [onDirtyChange]
  );
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  useEffect(() => {
    if (!active) setVisionSettingsOpen(false);
  }, [active]);

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

  const connections = (
    <div className="space-y-4 pb-8">
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

      <ExternalBackendSection />

      <p className="text-xs text-text-muted">
        {intl.formatMessage(i18n.codeBuddyModel)} · {intl.formatMessage(i18n.inDevelopment)}
      </p>
    </div>
  );
  return (
    <>
      <SettingsMenu
        visible={active}
        items={[
          {
            id: 'connections',
            title: intl.formatMessage(i18n.connections),
            description: intl.formatMessage(i18n.customConnectionsDescription),
            icon: <Plug className="h-5 w-5" />,
            content: connections,
          },
          {
            id: 'subagents',
            keepAlive: true,
            dirty: subagentDirty,
            hideBack: subagentEditing,
            title: intl.formatMessage(i18n.subagents),
            description: intl.formatMessage(i18n.subagentsDescription),
            icon: <Bot className="h-5 w-5" />,
            content: (
              <SubagentTemplateSettings
                providers={customProviders}
                onDirtyChange={handleDirtyChange}
                onEditingChange={setSubagentEditing}
              />
            ),
          },
          {
            id: 'vision',
            keepAlive: true,
            title: intl.formatMessage(i18n.vision),
            description: intl.formatMessage(i18n.visionDescription),
            icon: <ScanEye className="h-5 w-5" />,
            content: (
              <div className="space-y-4">
                <p className="text-sm text-text-secondary">
                  {intl.formatMessage(i18n.visionDescription)}
                </p>
                <Button variant="outline" onClick={() => setVisionSettingsOpen(true)}>
                  {intl.formatMessage(i18n.auxiliaryVision)}
                </Button>
                <ModelImageCapabilitySettings providers={customProviders} />
              </div>
            ),
          },
          {
            id: 'generation',
            keepAlive: true,
            title: intl.formatMessage(i18n.generation),
            description: intl.formatMessage(i18n.generationDescription),
            icon: <Image className="h-5 w-5" />,
            content: <ImageGenerationSettings />,
          },
          {
            id: 'context',
            keepAlive: true,
            title: intl.formatMessage(i18n.context),
            description: intl.formatMessage(i18n.contextDescription),
            icon: <SlidersHorizontal className="h-5 w-5" />,
            content: <ModelContextSettings providers={customProviders} />,
          },
        ]}
      />
      {active && visionSettingsOpen && (
        <CodeProModelModal
          visionOnly
          onClose={() => setVisionSettingsOpen(false)}
          onConfigureProvider={() => {
            setVisionSettingsOpen(false);
            setView('ConfigureProviders');
          }}
        />
      )}
    </>
  );
}
