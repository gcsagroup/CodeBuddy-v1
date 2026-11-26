import './runtime-settings.css';
import { selectNativeText } from '../../../utils/nativeLocalization';
import { SpeechSettings } from './SpeechSettings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Image, ScanEye, SlidersHorizontal, Plug, RefreshCw, Layers3, Mic } from 'lucide-react';
import type { View } from '../../../utils/navigationUtils';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { acpListProviderDetails } from '../../../acp/providers';
import type { ProviderDetails } from '../../../types/providers';
import SubagentTemplateSettings from './SubagentTemplateSettings';
import ProviderGrid from '../providers/ProviderGrid';
import VisionSettings from './VisionSettings';
import ModelContextSettings from './ModelContextSettings';
import CompactionSettings from './CompactionSettings';
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
    defaultMessage: 'Choose which model reads images and screenshots.',
  },
  generation: { id: 'modelsAndRuntime.generation', defaultMessage: 'Image and video generation' },
  generationDescription: {
    id: 'modelsAndRuntime.generationDescription',
    defaultMessage: 'Configure the service used to generate images and videos.',
  },
  context: { id: 'modelsAndRuntime.context', defaultMessage: 'Context capacity' },
  compaction: { id: 'modelsAndRuntime.compaction', defaultMessage: 'Context compaction' },
  compactionDescription: {
    id: 'modelsAndRuntime.compactionDescription',
    defaultMessage: 'Choose an optional backup model for context compaction.',
  },
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
    defaultMessage: 'Manage local, LAN and self-hosted model connections.',
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
  const [subagentDirty, setSubagentDirty] = useState(false);
  const [compactionDirty, setCompactionDirty] = useState(false);
  const [speechDirty, setSpeechDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(subagentDirty || compactionDirty || speechDirty);
  }, [subagentDirty, compactionDirty, speechDirty, onDirtyChange]);
  const [subagentEditing, setSubagentEditing] = useState(false);
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const connectionRead = useRef(0);

  const loadCustomConnections = useCallback(async () => {
    const version = ++connectionRead.current;
    setConnectionsLoading(true);
    setConnectionsFailed(false);
    try {
      const next = await acpListProviderDetails();
      if (version !== connectionRead.current) return;
      setProviders(next);
      setConnectionsLoaded(true);
    } catch {
      if (version !== connectionRead.current) return;
      setConnectionsFailed(true);
    } finally {
      if (version === connectionRead.current) setConnectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const requestVersion = connectionRead;
    void loadCustomConnections();
    const refresh = () => { void loadCustomConnections(); };
    window.addEventListener('codebuddy:model-inventory-updated', refresh);
    return () => {
      ++requestVersion.current;
      window.removeEventListener('codebuddy:model-inventory-updated', refresh);
    };
  }, [active, loadCustomConnections]);

  const customProviders = useMemo(
    () =>
      providers.filter(
        (provider) => provider.provider_type === 'Custom' && provider.category !== 'agent'
      ),
    [providers]
  );

  const connectionFeedback = (
    <>
      {connectionsLoading && !connectionsLoaded && (
        <p role="status" className="py-6 text-center text-sm text-text-muted">
          {intl.formatMessage(i18n.loadingConnections)}
        </p>
      )}
      {connectionsFailed && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-4"
        >
          <p className="text-sm text-yellow-700">
            {intl.formatMessage(i18n.connectionsUnavailable)}
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadCustomConnections()}>
            <RefreshCw className="h-4 w-4" />
            {intl.formatMessage(i18n.retry)}
          </Button>
        </div>
      )}
    </>
  );

  const connections = (
    <div className="space-y-4 pb-8">
      <Card className="rounded-lg">
        <CardHeader className="pb-3">
          <CardTitle>{intl.formatMessage(i18n.customConnections)}</CardTitle>
          <CardDescription>{intl.formatMessage(i18n.customConnectionsDescription)}</CardDescription>
        </CardHeader>
        <CardContent>
          {connectionFeedback}
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
    <div className="runtime-settings">
      <SettingsMenu
        groups={[
          {
            title: selectNativeText(intl.locale, 'Model services', '模型服务', '模型服務'),
            ids: ['connections', 'generation', 'speech'],
          },
          {
            title: selectNativeText(intl.locale, 'Model roles', '模型分工', '模型分工'),
            ids: ['vision', 'subagents'],
          },
          {
            title: selectNativeText(intl.locale, 'Context', '上下文', '上下文'),
            ids: ['compaction', 'context'],
          },
        ]}
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
            id: 'speech',
            keepAlive: true,
            dirty: speechDirty,
            title: selectNativeText(intl.locale, 'Speech recognition and synthesis', '语音识别与合成', '語音辨識與合成'),
            description: selectNativeText(intl.locale, 'Speak to compose messages. Manage your speech service.', '按住说话，轻松输入。管理语音识别服务。', '按住說話，輕鬆輸入。管理語音辨識服務。'),
            icon: <Mic className="h-5 w-5" />,
            content: <SpeechSettings onDirtyChange={setSpeechDirty} />,
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
                onDirtyChange={setSubagentDirty}
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
            content: <VisionSettings providers={customProviders} />,
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
            id: 'compaction',
            keepAlive: true,
            dirty: compactionDirty,
            title: intl.formatMessage(i18n.compaction),
            description: intl.formatMessage(i18n.compactionDescription),
            icon: <Layers3 className="h-5 w-5" />,
            content: (
              <CompactionSettings providers={customProviders} onDirtyChange={setCompactionDirty} />
            ),
          },
          {
            id: 'context',
            keepAlive: true,
            title: intl.formatMessage(i18n.context),
            description: intl.formatMessage(i18n.contextDescription),
            icon: <SlidersHorizontal className="h-5 w-5" />,
            content: connectionsLoaded ? (
              <ModelContextSettings providers={customProviders} />
            ) : (
              connectionFeedback
            ),
          },
        ]}
      />
    </div>
  );
}
