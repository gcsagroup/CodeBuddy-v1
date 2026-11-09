import React, { useEffect, useRef, useState } from 'react';
import { Input } from '../../../../../ui/input';
import { Select } from '../../../../../ui/Select';
import { Button } from '../../../../../ui/button';
import { SecureStorageNotice } from '../SecureStorageNotice';
import type { UpdateCustomProviderRequest } from '../../../../../../types/providers';
import type { ProviderTemplateDto } from '@aaif/goose-sdk';
import { Plus, X, Trash2, ExternalLink, Search, Settings } from 'lucide-react';
import { cn } from '../../../../../../utils';
import ProviderCatalogPicker from '../ProviderCatalogPicker';
import { defineMessages, useIntl } from '../../../../../../i18n';
import { acpErrorCode, acpErrorData, acpErrorMessage } from '../../../../../../acp/errors';

const i18n = defineMessages({
  chooseSetup: {
    id: 'customProviderForm.chooseSetup',
    defaultMessage: "Choose how you'd like to set up your provider.",
  },
  startFromTemplate: {
    id: 'customProviderForm.startFromTemplate',
    defaultMessage: 'Start from a provider template',
  },
  startFromTemplateDesc: {
    id: 'customProviderForm.startFromTemplateDesc',
    defaultMessage: "Pick a known provider and we'll auto-fill the configuration",
  },
  configureManually: {
    id: 'customProviderForm.configureManually',
    defaultMessage: 'Configure manually',
  },
  configureManuallyDesc: {
    id: 'customProviderForm.configureManuallyDesc',
    defaultMessage: 'Enter all provider details yourself',
  },
  cancel: {
    id: 'customProviderForm.cancel',
    defaultMessage: 'Cancel',
  },
  back: {
    id: 'customProviderForm.back',
    defaultMessage: '← Back',
  },
  usingTemplate: {
    id: 'customProviderForm.usingTemplate',
    defaultMessage: 'Using template: {name}',
  },
  docs: {
    id: 'customProviderForm.docs',
    defaultMessage: 'Docs',
  },
  clear: {
    id: 'customProviderForm.clear',
    defaultMessage: 'Clear',
  },
  providerType: {
    id: 'customProviderForm.providerType',
    defaultMessage: 'Provider Type',
  },
  openaiCompatible: {
    id: 'customProviderForm.openaiCompatible',
    defaultMessage: 'OpenAI Compatible',
  },
  anthropicCompatible: {
    id: 'customProviderForm.anthropicCompatible',
    defaultMessage: 'Anthropic Compatible',
  },
  ollamaCompatible: {
    id: 'customProviderForm.ollamaCompatible',
    defaultMessage: 'Ollama Compatible',
  },
  displayName: {
    id: 'customProviderForm.displayName',
    defaultMessage: 'Display Name',
  },
  displayNamePlaceholder: {
    id: 'customProviderForm.displayNamePlaceholder',
    defaultMessage: 'Your Provider Name',
  },
  defaultDisplayName: {
    id: 'customProviderForm.defaultDisplayName',
    defaultMessage: 'Custom connection',
  },
  apiUrl: {
    id: 'customProviderForm.apiUrl',
    defaultMessage: 'API URL',
  },
  apiUrlPlaceholder: {
    id: 'customProviderForm.apiUrlPlaceholder',
    defaultMessage: 'https://api.example.com',
  },
  apiBasePath: {
    id: 'customProviderForm.apiBasePath',
    defaultMessage: 'API Base Path (optional)',
  },
  apiBasePathPlaceholder: {
    id: 'customProviderForm.apiBasePathPlaceholder',
    defaultMessage: 'e.g., v1/chat/completions or project_id/v1',
  },
  apiBasePathHint: {
    id: 'customProviderForm.apiBasePathHint',
    defaultMessage:
      'Override the generation path required by your provider. A blank path uses Responses for the official OpenAI address and Chat Completions for compatible services. Loading models does not verify this path.',
  },
  authentication: {
    id: 'customProviderForm.authentication',
    defaultMessage: 'Authentication',
  },
  authHint: {
    id: 'customProviderForm.authHint',
    defaultMessage: "Local LLMs like Ollama typically don't require an API key.",
  },
  requiresApiKey: {
    id: 'customProviderForm.requiresApiKey',
    defaultMessage: 'This provider requires an API key',
  },
  apiKey: {
    id: 'customProviderForm.apiKey',
    defaultMessage: 'API Key',
  },
  apiKeyPlaceholderExisting: {
    id: 'customProviderForm.apiKeyPlaceholderExisting',
    defaultMessage: 'Leave blank to keep existing key',
  },
  apiKeyPlaceholderNew: {
    id: 'customProviderForm.apiKeyPlaceholderNew',
    defaultMessage: 'Your API key',
  },
  availableModels: {
    id: 'customProviderForm.availableModels',
    defaultMessage: 'Available Models (comma-separated)',
  },
  modelsPlaceholder: {
    id: 'customProviderForm.modelsPlaceholder',
    defaultMessage: 'model-a, model-b, model-c',
  },
  toolCalling: {
    id: 'customProviderForm.toolCalling',
    defaultMessage: 'Tool calling',
  },
  reasoning: {
    id: 'customProviderForm.reasoning',
    defaultMessage: 'Reasoning',
  },
  attachments: {
    id: 'customProviderForm.attachments',
    defaultMessage: 'Attachments',
  },
  supportsStreaming: {
    id: 'customProviderForm.supportsStreaming',
    defaultMessage: 'Provider supports streaming responses',
  },
  customHeaders: {
    id: 'customProviderForm.customHeaders',
    defaultMessage: 'Custom Headers',
  },
  customHeadersHint: {
    id: 'customProviderForm.customHeadersHint',
    defaultMessage:
      'Add custom HTTP headers to include in requests to the provider. Click the "+" button to add after filling both fields.',
  },
  headerNamePlaceholder: {
    id: 'customProviderForm.headerNamePlaceholder',
    defaultMessage: 'Header name',
  },
  valuePlaceholder: {
    id: 'customProviderForm.valuePlaceholder',
    defaultMessage: 'Value',
  },
  add: {
    id: 'customProviderForm.add',
    defaultMessage: 'Add',
  },
  headerBothRequired: {
    id: 'customProviderForm.headerBothRequired',
    defaultMessage: 'Both header name and value must be entered',
  },
  headerNoSpaces: {
    id: 'customProviderForm.headerNoSpaces',
    defaultMessage: 'Header name cannot contain spaces',
  },
  headerDuplicate: {
    id: 'customProviderForm.headerDuplicate',
    defaultMessage: 'A header with this name already exists',
  },
  displayNameRequired: {
    id: 'customProviderForm.displayNameRequired',
    defaultMessage: 'Display name is required',
  },
  apiUrlRequired: {
    id: 'customProviderForm.apiUrlRequired',
    defaultMessage: 'API URL is required',
  },
  apiKeyRequired: {
    id: 'customProviderForm.apiKeyRequired',
    defaultMessage: 'API key is required',
  },
  modelsRequired: {
    id: 'customProviderForm.modelsRequired',
    defaultMessage: 'At least one model is required',
  },
  submitError: {
    id: 'customProviderForm.submitError',
    defaultMessage: 'Connection verification did not complete. Check your connection settings and try again.',
  },
  verificationFailed: {
    id: 'customProviderForm.verificationFailed',
    defaultMessage: 'Verification failed',
  },
  verificationUnconfirmed: {
    id: 'customProviderForm.verificationUnconfirmed',
    defaultMessage: 'Verification result unconfirmed',
  },
  notSaved: {
    id: 'customProviderForm.notSaved',
    defaultMessage: 'The connection was not saved. Your entries are retained in this form.',
  },
  saveUnconfirmed: {
    id: 'customProviderForm.saveUnconfirmed',
    defaultMessage: 'The save result could not be confirmed. Your entries are retained; check the connection list before retrying.',
  },
  diagnosticDetails: {
    id: 'customProviderForm.diagnosticDetails',
    defaultMessage: 'Diagnostic details',
  },
  verifying: {
    id: 'customProviderForm.verifying',
    defaultMessage: 'Verifying…',
  },
  pathNotFound: {
    id: 'customProviderForm.pathNotFound',
    defaultMessage: 'The model endpoint was not found or is not accessible to this account. Verify the API address, base path and model ID.',
  },
  requestRejected: {
    id: 'customProviderForm.requestRejected',
    defaultMessage: 'The service rejected the validation request. Verify the API format, tool support and thinking settings for this model.',
  },
  permissionDenied: {
    id: 'customProviderForm.permissionDenied',
    defaultMessage: 'Access was denied. Verify that this API key has permission to use the selected model.',
  },
  rateLimited: {
    id: 'customProviderForm.rateLimited',
    defaultMessage: 'The service limited this request. Check the account quota and request limits, then retry.',
  },
  serviceUnavailable: {
    id: 'customProviderForm.serviceUnavailable',
    defaultMessage: 'The model service returned a server error. Retry later or check the service status.',
  },
  toolsUnsupported: {
    id: 'customProviderForm.toolsUnsupported',
    defaultMessage: 'This model does not support tool calling. Select a model with tool support to use CodeBuddy tasks.',
  },
  deleteFailed: {
    id: 'customProviderForm.deleteFailed',
    defaultMessage: 'Could not delete this connection. Stop any tasks using it and try again.',
  },
  deleteConfirmation: {
    id: 'customProviderForm.deleteConfirmation',
    defaultMessage:
      'Are you sure you want to delete this custom provider? This will permanently remove the provider and its stored API key. This action cannot be undone.',
  },
  confirmDelete: {
    id: 'customProviderForm.confirmDelete',
    defaultMessage: 'Confirm Delete',
  },
  deleteProvider: {
    id: 'customProviderForm.deleteProvider',
    defaultMessage: 'Delete Provider',
  },
  updateProvider: {
    id: 'customProviderForm.updateProvider',
    defaultMessage: 'Verify and save',
  },
  createProvider: {
    id: 'customProviderForm.createProvider',
    defaultMessage: 'Verify and add',
  },
  testConnection: {
    id: 'customProviderForm.loadModels',
    defaultMessage: 'Load models',
  },
  testingConnection: {
    id: 'customProviderForm.loadingModels',
    defaultMessage: 'Loading models…',
  },
  discoveredModels: {
    id: 'customProviderForm.discoveredModels',
    defaultMessage: 'Discovered models',
  },
  discoveryFailed: {
    id: 'customProviderForm.discoveryFailed',
    defaultMessage: 'Could not verify this connection. Check the settings and try again.',
  },
  modelId: {
    id: 'customProviderForm.modelId',
    defaultMessage: 'Model ID',
  },
  localOllama: {
    id: 'customProviderForm.localOllama',
    defaultMessage: 'Local Ollama',
  },
  localConnection: {
    id: 'customProviderForm.localConnection',
    defaultMessage: 'Local connection',
  },
  compatibleApi: {
    id: 'customProviderForm.compatibleApi',
    defaultMessage: 'OpenAI-compatible API',
  },
  customOpenAiEndpoint: {
    id: 'customProviderForm.customOpenAiEndpoint',
    defaultMessage: 'Custom OpenAI endpoint',
  },
  invalidCredentials: {
    id: 'customProviderForm.invalidCredentials',
    defaultMessage: 'The API key was rejected. Check it and try again.',
  },
  credentialsNotVerified: {
    id: 'customProviderForm.credentialsNotVerified',
    defaultMessage:
      "This address also works without the API key, so the key could not be verified. Turn off authentication or use the provider's authenticated API address.",
  },
  endpointUnreachable: {
    id: 'customProviderForm.endpointUnreachable',
    defaultMessage:
      'Could not reach this address. Check that the service is running and try again.',
  },
  noModels: {
    id: 'customProviderForm.noModels',
    defaultMessage: 'The service is reachable, but it has no models available.',
  },
  modelUnavailable: {
    id: 'customProviderForm.modelUnavailable',
    defaultMessage: 'The selected model could not complete a test request.',
  },
  apiKeyRequiredForConnection: {
    id: 'customProviderForm.apiKeyRequiredForConnection',
    defaultMessage: 'Enter the API key again, then test the connection.',
  },
  modelListUnavailable: {
    id: 'customProviderForm.modelListUnavailable',
    defaultMessage: 'The address responded, but its model list could not be loaded.',
  },
  invalidResponse: {
    id: 'customProviderForm.invalidConnectionResponse',
    defaultMessage: 'The address did not return a valid model response.',
  },
  responseTooLarge: {
    id: 'customProviderForm.connectionResponseTooLarge',
    defaultMessage: 'The address returned too much data. Check that this is a model API address.',
  },
  connectionTestHint: {
    id: 'customProviderForm.modelDiscoveryHint',
    defaultMessage:
      'Verification sends a real model request and may use a small number of tokens. The connection is saved only after verification succeeds.',
  },
  connectionReady: {
    id: 'customProviderForm.modelsLoaded',
    defaultMessage: 'Model list loaded. Select a model, then verify the connection before adding it.',
  },
});

type Step = 'choice' | 'catalog' | 'form';

type CompactProviderPreset = {
  id: string;
  label: string;
  engine: 'openai_compatible' | 'ollama_compatible';
  displayName: string;
  apiUrl: string;
  basePath?: string;
  requiresAuth: boolean;
};

const COMPACT_PROVIDER_PRESETS: CompactProviderPreset[] = [
  {
    id: 'custom_openai',
    label: 'OpenAI-compatible API',
    engine: 'openai_compatible',
    displayName: '',
    apiUrl: '',
    requiresAuth: true,
  },
  {
    id: 'local_ollama',
    label: 'Local Ollama',
    engine: 'ollama_compatible',
    displayName: 'Local Ollama',
    apiUrl: 'http://127.0.0.1:11434',
    requiresAuth: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    engine: 'openai_compatible',
    displayName: 'OpenAI',
    apiUrl: 'https://api.openai.com',
    basePath: '/v1/responses',
    requiresAuth: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    engine: 'openai_compatible',
    displayName: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com',
    requiresAuth: true,
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    engine: 'openai_compatible',
    displayName: 'SiliconFlow',
    apiUrl: 'https://api.siliconflow.cn/v1',
    requiresAuth: true,
  },
  {
    id: 'moonshot',
    label: 'Kimi / Moonshot',
    engine: 'openai_compatible',
    displayName: 'Kimi / Moonshot',
    apiUrl: 'https://api.moonshot.cn/v1',
    requiresAuth: true,
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI',
    engine: 'openai_compatible',
    displayName: 'Zhipu AI',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    requiresAuth: true,
  },
  {
    id: 'alibaba_model_studio',
    label: 'Alibaba Cloud Model Studio',
    engine: 'openai_compatible',
    displayName: 'Alibaba Cloud Model Studio',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresAuth: true,
  },
];

const DEFAULT_COMPACT_PROVIDER_PRESET = COMPACT_PROVIDER_PRESETS[0];

function compactPresetForInitialData(initialData: UpdateCustomProviderRequest) {
  const normalizedUrl = initialData.api_url.trim().replace(/\/$/, '').toLowerCase();
  return (
    COMPACT_PROVIDER_PRESETS.find(
      (preset) => preset.apiUrl && preset.apiUrl.replace(/\/$/, '').toLowerCase() === normalizedUrl
    ) ??
    COMPACT_PROVIDER_PRESETS.find((preset) =>
      initialData.engine.includes('ollama')
        ? preset.id === 'local_ollama'
        : preset.id === 'custom_openai'
    )!
  );
}

interface CustomProviderFormProps {
  onSubmit: (data: UpdateCustomProviderRequest, selectedModel?: string) => void | Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
  initialData: UpdateCustomProviderRequest | null;
  isEditable?: boolean;
  compactSetup?: boolean;
  discoverModels?: (data: UpdateCustomProviderRequest) => Promise<string[]>;
  existingProviderNames?: string[];
}

export default function CustomProviderForm({
  onSubmit,
  onCancel,
  onDelete,
  initialData,
  isEditable,
  compactSetup = false,
  discoverModels,
  existingProviderNames = [],
}: CustomProviderFormProps) {
  const intl = useIntl();
  const suggestName = (base: string) => {
    const existing = new Set(existingProviderNames.map((name) => name.trim().toLowerCase()));
    let candidate = base;
    for (let number = 2; existing.has(candidate.toLowerCase()); number += 1) {
      candidate = `${base} ${number}`;
    }
    return candidate;
  };
  const defaultName = intl.formatMessage(i18n.defaultDisplayName);
  const [compactPresetId, setCompactPresetId] = useState(DEFAULT_COMPACT_PROVIDER_PRESET.id);
  const [engine, setEngine] = useState<string>(
    compactSetup ? DEFAULT_COMPACT_PROVIDER_PRESET.engine : 'openai_compatible'
  );
  const [displayName, setDisplayName] = useState(
    () => initialData?.display_name ?? suggestName(defaultName)
  );
  const [nameEdited, setNameEdited] = useState(false);
  const [apiUrl, setApiUrl] = useState(compactSetup ? DEFAULT_COMPACT_PROVIDER_PRESET.apiUrl : '');
  const [basePath, setBasePath] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [requiresAuth, setRequiresAuth] = useState(
    compactSetup ? DEFAULT_COMPACT_PROVIDER_PRESET.requiresAuth : false
  );
  const [supportsStreaming, setSupportsStreaming] = useState(true);
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([]);
  const [newHeaderKey, setNewHeaderKey] = useState('');
  const [newHeaderValue, setNewHeaderValue] = useState('');
  const [headerValidationError, setHeaderValidationError] = useState<string | null>(null);
  const [invalidHeaderFields, setInvalidHeaderFields] = useState<{ key: boolean; value: boolean }>({
    key: false,
    value: false,
  });
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<{ message: string; details: string; rejected: boolean } | null>(null);
  const [deleteError, setDeleteError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitInFlightRef = useRef(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [discoveryStatus, setDiscoveryStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    'idle'
  );

  const clearFieldError = (field: string) => {
    setValidationErrors((previous) => {
      if (!previous[field]) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
  };

  const resetConnectionTest = () => {
    setSubmitError(null);
    if (!compactSetup) return;
    setDiscoveryStatus('idle');
    setDiscoveredModels([]);
    setSelectedModel('');
    setConnectionError(null);
    setModels('');
  };

  // Template + step state
  const [selectedTemplate, setSelectedTemplate] = useState<ProviderTemplateDto | null>(null);
  const [step, setStep] = useState<Step>(initialData || compactSetup ? 'form' : 'choice');

  useEffect(() => {
    if (initialData) {
      const engineMap: Record<string, string> = {
        openai: 'openai_compatible',
        openai_compatible: 'openai_compatible',
        anthropic: 'anthropic_compatible',
        anthropic_compatible: 'anthropic_compatible',
        ollama: 'ollama_compatible',
        ollama_compatible: 'ollama_compatible',
      };
      setEngine(engineMap[initialData.engine] || 'openai_compatible');
      if (compactSetup) {
        setCompactPresetId(compactPresetForInitialData(initialData).id);
      }
      setDisplayName(initialData.display_name);
      setApiUrl(initialData.api_url);
      setBasePath(initialData.base_path ?? '');
      setModels(initialData.models.join(', '));
      setSelectedModel(initialData.models[0] ?? '');
      setSupportsStreaming(initialData.supports_streaming ?? true);
      setRequiresAuth(initialData.requires_auth ?? true);

      if (initialData.headers) {
        const headerList = Object.entries(initialData.headers).map(([key, value]) => ({
          key,
          value,
        }));
        setHeaders(headerList);
      }

      setStep('form');
    }
  }, [compactSetup, initialData]);

  const handleTemplateSelect = (template: ProviderTemplateDto) => {
    setSelectedTemplate(template);

    // Prefill fields from template
    if (!nameEdited) setDisplayName(suggestName(template.name));
    setApiUrl(template.apiUrl);
    setBasePath('');
    setSupportsStreaming(template.supportsStreaming);
    setRequiresAuth(true);

    const formatToEngine: Record<string, string> = {
      openai: 'openai_compatible',
      anthropic: 'anthropic_compatible',
      ollama: 'ollama_compatible',
    };
    setEngine(formatToEngine[template.format] || 'openai_compatible');

    const templateModels = template.models.filter((m) => !m.deprecated).map((m) => m.id);
    setModels(templateModels.join(', '));

    setStep('form');
  };

  const handleClearTemplate = () => {
    setSelectedTemplate(null);
    setDisplayName(suggestName(defaultName));
    setNameEdited(false);
    setApiUrl('');
    setBasePath('');
    setModels('');
    setEngine('openai_compatible');
    setSupportsStreaming(true);
    setRequiresAuth(false);
    setStep('choice');
  };

  const handleRequiresAuthChange = (checked: boolean) => {
    setRequiresAuth(checked);
    resetConnectionTest();
    if (!checked) {
      setApiKey('');
      clearFieldError('apiKey');
    }
  };

  const buildRequest = (modelList: string[]): UpdateCustomProviderRequest => ({
    engine,
    display_name: displayName,
    api_url: apiUrl,
    api_key: apiKey,
    models: modelList,
    supports_streaming: supportsStreaming,
    requires_auth: requiresAuth,
    headers: Object.fromEntries(
      headers
        .filter((header) => header.key.trim() && header.value.trim())
        .map((header) => [header.key.trim(), header.value.trim()])
    ),
    catalog_provider_id:
      selectedTemplate?.providerId ?? initialData?.catalog_provider_id ?? undefined,
    base_path: basePath || undefined,
  });

  const handleDiscoverModels = async () => {
    setDiscoveryStatus('loading');
    setDiscoveredModels([]);
    setSelectedModel('');
    setConnectionError(null);
    try {
      if (!discoverModels) throw new Error('Model discovery is unavailable');
      const discovered = [
        ...new Set((await discoverModels(buildRequest([]))).map((id) => id.trim())),
      ].filter(Boolean);
      if (discovered.length === 0) throw new Error('No models returned');
      setDiscoveredModels(discovered);
      setSelectedModel(discovered[0]);
      setModels(discovered.join(', '));
      setDiscoveryStatus('ready');
    } catch (error) {
      setModels('');
      const code = acpErrorCode(error);
      const knownMessages: Record<string, string> = {
        custom_provider_invalid_credentials: intl.formatMessage(i18n.invalidCredentials),
        custom_provider_api_key_required: intl.formatMessage(i18n.apiKeyRequiredForConnection),
        custom_provider_credentials_not_verified: intl.formatMessage(i18n.credentialsNotVerified),
        custom_provider_endpoint_unreachable: intl.formatMessage(i18n.endpointUnreachable),
        custom_provider_model_unavailable: intl.formatMessage(i18n.modelUnavailable),
        custom_provider_model_list_unavailable: intl.formatMessage(i18n.modelListUnavailable),
        custom_provider_invalid_response: intl.formatMessage(i18n.invalidResponse),
        custom_provider_response_too_large: intl.formatMessage(i18n.responseTooLarge),
        custom_provider_no_models: intl.formatMessage(i18n.noModels),
      };
      const knownMessage = code ? knownMessages[code] : undefined;
      setConnectionError(
        knownMessage ?? acpErrorMessage(error) ?? intl.formatMessage(i18n.discoveryFailed)
      );
      setDiscoveryStatus('failed');
    }
  };

  const handleAddHeader = () => {
    const keyEmpty = !newHeaderKey.trim();
    const valueEmpty = !newHeaderValue.trim();
    const keyHasSpaces = newHeaderKey.includes(' ');
    const normalizedNewKey = newHeaderKey.trim().toLowerCase();
    const isDuplicate = headers.some((h) => h.key.trim().toLowerCase() === normalizedNewKey);

    if (keyEmpty || valueEmpty) {
      setInvalidHeaderFields({ key: keyEmpty, value: valueEmpty });
      setHeaderValidationError(intl.formatMessage(i18n.headerBothRequired));
      return;
    }

    if (keyHasSpaces) {
      setInvalidHeaderFields({ key: true, value: false });
      setHeaderValidationError(intl.formatMessage(i18n.headerNoSpaces));
      return;
    }

    if (isDuplicate) {
      setInvalidHeaderFields({ key: true, value: false });
      setHeaderValidationError(intl.formatMessage(i18n.headerDuplicate));
      return;
    }

    setHeaderValidationError(null);
    setInvalidHeaderFields({ key: false, value: false });
    setHeaders([...headers, { key: newHeaderKey, value: newHeaderValue }]);
    resetConnectionTest();
    setNewHeaderKey('');
    setNewHeaderValue('');
  };

  const handleRemoveHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
    resetConnectionTest();
  };

  const handleHeaderChange = (index: number, field: 'key' | 'value', value: string) => {
    if (field === 'key') {
      if (value.includes(' ')) return;
      const normalizedValue = value.trim().toLowerCase();
      const isDuplicate = headers.some(
        (h, i) => i !== index && h.key.trim().toLowerCase() === normalizedValue
      );
      if (isDuplicate && normalizedValue !== '') return;
      const updatedHeaders = [...headers];
      updatedHeaders[index].key = value;
      setHeaders(updatedHeaders);
      resetConnectionTest();
      return;
    }
    const updatedHeaders = [...headers];
    updatedHeaders[index][field] = value;
    setHeaders(updatedHeaders);
    resetConnectionTest();
  };

  const clearHeaderValidation = () => {
    setHeaderValidationError(null);
    setInvalidHeaderFields({ key: false, value: false });
  };

  const handleHeaderKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddHeader();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlightRef.current) return;
    const form = e.currentTarget;
    setSubmitError(null);
    setValidationErrors({});

    const errors: Record<string, string> = {};
    if (!displayName.trim()) errors.displayName = intl.formatMessage(i18n.displayNameRequired);
    if (!apiUrl.trim()) errors.apiUrl = intl.formatMessage(i18n.apiUrlRequired);
    const existingHadAuth = initialData && (initialData.requires_auth ?? true);
    if (requiresAuth && !apiKey.trim() && !existingHadAuth)
      errors.apiKey = intl.formatMessage(i18n.apiKeyRequired);
    const modelList = models
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m);
    if (!modelList.length) errors.models = intl.formatMessage(i18n.modelsRequired);

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      // Wait for aria-invalid and the associated error text to reach the DOM.
      requestAnimationFrame(() => {
        if (!form.isConnected) return;
        const field = form.querySelector<HTMLElement>('[aria-invalid="true"]');
        field?.focus({ preventScroll: true });
        field?.scrollIntoView({ block: 'center' });
      });
      return;
    }

    const orderedModelList = selectedModel
      ? [selectedModel, ...modelList.filter((model) => model !== selectedModel)]
      : modelList;

    let allHeaders = [...headers];

    if (newHeaderKey.trim() && newHeaderValue.trim()) {
      const keyHasSpaces = newHeaderKey.includes(' ');
      const normalizedPendingKey = newHeaderKey.trim().toLowerCase();
      const isDuplicate = headers.some((h) => h.key.trim().toLowerCase() === normalizedPendingKey);

      if (!keyHasSpaces && !isDuplicate) {
        allHeaders.push({ key: newHeaderKey, value: newHeaderValue });
      }
    }

    const headersObject = allHeaders.reduce(
      (acc, header) => {
        if (header.key.trim() && header.value.trim()) {
          acc[header.key.trim()] = header.value.trim();
        }
        return acc;
      },
      {} as Record<string, string>
    );

    submitInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      const request = { ...buildRequest(orderedModelList), headers: headersObject };
      if (selectedModel) await onSubmit(request, selectedModel);
      else await onSubmit(request);
    } catch (error) {
      const data = acpErrorData(error);
      const status = typeof data?.httpStatus === 'number' && Number.isInteger(data.httpStatus) && data.httpStatus >= 400 && data.httpStatus <= 599 ? data.httpStatus : undefined;
      const code = acpErrorCode(error);
      const byCode: Record<string, typeof i18n.submitError> = {
        custom_provider_invalid_credentials: i18n.invalidCredentials,
        custom_provider_api_key_required: i18n.apiKeyRequiredForConnection,
        custom_provider_endpoint_unreachable: i18n.endpointUnreachable,
        custom_provider_model_unavailable: i18n.modelUnavailable,
        custom_provider_permission_denied: i18n.permissionDenied,
        custom_provider_tools_unsupported: i18n.toolsUnsupported,
        custom_provider_invalid_response: i18n.invalidResponse,
        custom_provider_response_too_large: i18n.responseTooLarge,
        custom_provider_model_list_unavailable: i18n.modelListUnavailable,
      };
      const reason = status === 404 ? i18n.pathNotFound
        : status === 400 || status === 422 ? i18n.requestRejected
          : status === 401 ? i18n.invalidCredentials : status === 403 ? i18n.permissionDenied
            : status === 429 ? i18n.rateLimited : status && status >= 500 ? i18n.serviceUnavailable
              : byCode[code ?? ''] ?? i18n.submitError;
      // Only bounded structured identifiers belong in diagnostics. Upstream text
      // can echo request headers or credentials and must not enter this panel.
      const identifiers = [data?.upstreamCode, data?.upstreamParam].filter(
        (value): value is string => typeof value === 'string' && /^[A-Za-z0-9_.[\]-]{1,80}$/.test(value)
      );
      setSubmitError({ message: intl.formatMessage(reason), details: [status ? `HTTP ${status}` : '', ...identifiers].filter(Boolean).join(' · '), rejected: code !== null && Object.prototype.hasOwnProperty.call(byCode, code) });
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  // Aggregate capability badges for template models
  const templateModelCapabilities = selectedTemplate?.models
    .filter((m) => !m.deprecated)
    .reduce(
      (acc, m) => {
        if (m.capabilities.toolCall) acc.tool_call = true;
        if (m.capabilities.reasoning) acc.reasoning = true;
        if (m.capabilities.attachment) acc.attachment = true;
        return acc;
      },
      { tool_call: false, reasoning: false, attachment: false }
    );

  // -- Step: Choice --
  if (step === 'choice') {
    return (
      <div className="mt-4 space-y-3">
        <p className="text-sm text-textSubtle">{intl.formatMessage(i18n.chooseSetup)}</p>
        <button
          type="button"
          onClick={() => setStep('catalog')}
          className="w-full p-4 text-left border border-border rounded-lg hover:bg-surfaceHover hover:border-primary transition-colors group"
        >
          <div className="flex items-center gap-3">
            <Search className="w-5 h-5 text-primary flex-shrink-0" />
            <div>
              <div className="font-medium text-textStandard">
                {intl.formatMessage(i18n.startFromTemplate)}
              </div>
              <div className="text-sm text-textSubtle mt-0.5">
                {intl.formatMessage(i18n.startFromTemplateDesc)}
              </div>
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setStep('form')}
          className="w-full p-4 text-left border border-border rounded-lg hover:bg-surfaceHover hover:border-primary transition-colors group"
        >
          <div className="flex items-center gap-3">
            <Settings className="w-5 h-5 text-textSubtle flex-shrink-0" />
            <div>
              <div className="font-medium text-textStandard">
                {intl.formatMessage(i18n.configureManually)}
              </div>
              <div className="text-sm text-textSubtle mt-0.5">
                {intl.formatMessage(i18n.configureManuallyDesc)}
              </div>
            </div>
          </div>
        </button>
        <div className="flex justify-end pt-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            {intl.formatMessage(i18n.cancel)}
          </Button>
        </div>
      </div>
    );
  }

  // -- Step: Catalog picker --
  if (step === 'catalog') {
    return (
      <div className="mt-4">
        <ProviderCatalogPicker onSelect={handleTemplateSelect} onCancel={onCancel} embedded />
        <div className="flex justify-between pt-4">
          <Button type="button" variant="ghost" onClick={() => setStep('choice')}>
            {intl.formatMessage(i18n.back)}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {intl.formatMessage(i18n.cancel)}
          </Button>
        </div>
      </div>
    );
  }

  // -- Step: Form --
  return (
    <form onSubmit={handleSubmit} className="mt-4" aria-busy={isSubmitting}>
      <fieldset disabled={isSubmitting} className="space-y-4 min-w-0">
      {/* Template info banner */}
      {selectedTemplate && (
        <div className="p-3 bg-surfaceHover border border-border rounded-lg">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <div className="font-medium text-textStandard">
                {intl.formatMessage(i18n.usingTemplate, { name: selectedTemplate.name })}
              </div>
              <div className="text-textSubtle mt-1">{selectedTemplate.apiUrl}</div>
            </div>
            <div className="flex items-center gap-2">
              {selectedTemplate.docUrl && (
                <a
                  href={selectedTemplate.docUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline text-sm flex items-center gap-1"
                >
                  {intl.formatMessage(i18n.docs)} <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClearTemplate}
                className="text-textSubtle hover:text-textStandard"
              >
                {intl.formatMessage(i18n.clear)}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Back to choice (create without template only) */}
      {!compactSetup && !initialData && !selectedTemplate && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setStep('choice')}>
          {intl.formatMessage(i18n.back)}
        </Button>
      )}

      {/* Provider type dropdown */}
      {isEditable && (
        <div>
          <label
            htmlFor="provider-select"
            className="flex items-center text-sm font-medium text-text-primary mb-2"
          >
            {intl.formatMessage(i18n.providerType)}
            <span aria-hidden="true" className="text-red-500 ml-1">
              *
            </span>
          </label>
          <Select
            inputId="provider-select"
            aria-label={intl.formatMessage(i18n.providerType)}
            aria-invalid={!!validationErrors.providerType}
            aria-describedby={validationErrors.providerType ? 'provider-select-error' : undefined}
            options={
              compactSetup
                ? COMPACT_PROVIDER_PRESETS.map((preset) => ({
                    value: preset.id,
                    label: preset.label,
                  }))
                : [
                    {
                      value: 'ollama_compatible',
                      label: intl.formatMessage(i18n.ollamaCompatible),
                    },
                    {
                      value: 'openai_compatible',
                      label: intl.formatMessage(i18n.openaiCompatible),
                    },
                    {
                      value: 'anthropic_compatible',
                      label: intl.formatMessage(i18n.anthropicCompatible),
                    },
                  ]
            }
            value={
              compactSetup
                ? {
                    value: compactPresetId,
                    label:
                      COMPACT_PROVIDER_PRESETS.find((preset) => preset.id === compactPresetId)
                        ?.label ?? DEFAULT_COMPACT_PROVIDER_PRESET.label,
                  }
                : {
                    value: engine,
                    label:
                      engine === 'openai_compatible'
                        ? intl.formatMessage(i18n.openaiCompatible)
                        : engine === 'anthropic_compatible'
                          ? intl.formatMessage(i18n.anthropicCompatible)
                          : intl.formatMessage(i18n.ollamaCompatible),
                  }
            }
            onChange={(option: unknown) => {
              const selectedOption = option as { value: string; label: string } | null;
              if (selectedOption) {
                resetConnectionTest();
                setValidationErrors({});
                if (compactSetup) {
                  const preset = COMPACT_PROVIDER_PRESETS.find(
                    (candidate) => candidate.id === selectedOption.value
                  );
                  if (preset) {
                    setCompactPresetId(preset.id);
                    setEngine(preset.engine);
                    setApiUrl(preset.apiUrl);
                    setBasePath(preset.basePath ?? '');
                    if (!initialData && !nameEdited)
                      setDisplayName(suggestName(preset.displayName || defaultName));
                    setRequiresAuth(preset.requiresAuth);
                    setApiKey('');
                  }
                } else {
                  setEngine(selectedOption.value);
                }
              }
            }}
            isSearchable={false}
          />
          {validationErrors.providerType && (
            <p id="provider-select-error" className="text-red-500 text-sm mt-1">
              {validationErrors.providerType}
            </p>
          )}
        </div>
      )}

      {/* Display name */}
      {isEditable && (
        <div>
          <label
            htmlFor="display-name"
            className="flex items-center text-sm font-medium text-text-primary mb-2"
          >
            {intl.formatMessage(i18n.displayName)}
            <span aria-hidden="true" className="text-red-500 ml-1">
              *
            </span>
          </label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setNameEdited(true);
              if (e.target.value.trim()) clearFieldError('displayName');
            }}
            placeholder={intl.formatMessage(i18n.displayNamePlaceholder)}
            aria-invalid={!!validationErrors.displayName}
            aria-describedby={validationErrors.displayName ? 'display-name-error' : undefined}
            className={validationErrors.displayName ? 'border-red-500' : ''}
          />
          {validationErrors.displayName && (
            <p id="display-name-error" className="text-red-500 text-sm mt-1">
              {validationErrors.displayName}
            </p>
          )}
        </div>
      )}

      {/* API URL */}
      {isEditable && (
        <div>
          <label
            htmlFor="api-url"
            className="flex items-center text-sm font-medium text-text-primary mb-2"
          >
            {intl.formatMessage(i18n.apiUrl)}
            <span aria-hidden="true" className="text-red-500 ml-1">
              *
            </span>
          </label>
          <Input
            id="api-url"
            value={apiUrl}
            onChange={(e) => {
              setApiUrl(e.target.value);
              if (e.target.value.trim()) clearFieldError('apiUrl');
              resetConnectionTest();
            }}
            placeholder={intl.formatMessage(i18n.apiUrlPlaceholder)}
            aria-invalid={!!validationErrors.apiUrl}
            aria-describedby={validationErrors.apiUrl ? 'api-url-error' : undefined}
            className={validationErrors.apiUrl ? 'border-red-500' : ''}
          />
          {validationErrors.apiUrl && (
            <p id="api-url-error" className="text-red-500 text-sm mt-1">
              {validationErrors.apiUrl}
            </p>
          )}
        </div>
      )}

      {/* Base Path */}
      {isEditable && (
        <div>
          <label
            htmlFor="base-path"
            className="flex items-center text-sm font-medium text-text-primary mb-2"
          >
            {intl.formatMessage(i18n.apiBasePath)}
          </label>
          <Input
            id="base-path"
            value={basePath}
            onChange={(e) => {
              setBasePath(e.target.value);
              resetConnectionTest();
            }}
            placeholder={intl.formatMessage(i18n.apiBasePathPlaceholder)}
          />
          <p className="text-xs text-textSubtle mt-1">{intl.formatMessage(i18n.apiBasePathHint)}</p>
        </div>
      )}

      {/* Authentication */}
      <div>
        <label className="block text-sm font-medium text-text-primary mb-2">
          {intl.formatMessage(i18n.authentication)}
        </label>
        <p className="text-sm text-text-secondary mb-3">{intl.formatMessage(i18n.authHint)}</p>
        <div className="flex items-center space-x-2">
          <input
            type="checkbox"
            id="requires-auth"
            checked={requiresAuth}
            onChange={(e) => handleRequiresAuthChange(e.target.checked)}
            className="rounded border-border-primary"
          />
          <label htmlFor="requires-auth" className="text-sm text-text-secondary">
            {intl.formatMessage(i18n.requiresApiKey)}
          </label>
        </div>

        {requiresAuth && (
          <div className="mt-3">
            <label
              htmlFor="api-key"
              className="flex items-center text-sm font-medium text-text-primary mb-2"
            >
              {intl.formatMessage(i18n.apiKey)}
              {selectedTemplate?.envVar && (
                <span className="text-textSubtle ml-1 font-normal">
                  ({selectedTemplate.envVar})
                </span>
              )}
              {!initialData && (
                <span aria-hidden="true" className="text-red-500 ml-1">
                  *
                </span>
              )}
            </label>
            <Input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (e.target.value.trim()) clearFieldError('apiKey');
                resetConnectionTest();
              }}
              placeholder={
                initialData
                  ? intl.formatMessage(i18n.apiKeyPlaceholderExisting)
                  : intl.formatMessage(i18n.apiKeyPlaceholderNew)
              }
              aria-invalid={!!validationErrors.apiKey}
              aria-describedby={validationErrors.apiKey ? 'api-key-error' : undefined}
              className={validationErrors.apiKey ? 'border-red-500' : ''}
            />
            {validationErrors.apiKey && (
              <p id="api-key-error" className="text-red-500 text-sm mt-1">
                {validationErrors.apiKey}
              </p>
            )}
          </div>
        )}
      </div>

      {compactSetup && isEditable && (
        <div className="space-y-3 rounded-md border border-border-primary p-3">
          <p className="text-xs text-textSubtle">{intl.formatMessage(i18n.connectionTestHint)}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleDiscoverModels()}
            disabled={discoveryStatus === 'loading' || !apiUrl.trim()}
          >
            {intl.formatMessage(
              discoveryStatus === 'loading' ? i18n.testingConnection : i18n.testConnection
            )}
          </Button>
          {discoveryStatus === 'ready' && (
            <div>
              <p role="status" className="mb-2 text-sm text-green-600">
                {intl.formatMessage(i18n.connectionReady)}
              </p>
              <label htmlFor="discovered-models" className="mb-2 block text-sm font-medium">
                {intl.formatMessage(i18n.discoveredModels)}
              </label>
              <select
                id="discovered-models"
                className="h-10 w-full rounded-md border border-border-primary bg-background-primary px-3 text-sm"
                value={selectedModel}
                onChange={(event) => {
                  setSelectedModel(event.target.value);
                  setSubmitError(null);
                }}
              >
                {discoveredModels.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
              </select>
            </div>
          )}
          {discoveryStatus === 'failed' && (
            <p role="alert" className="text-sm text-red-500">
              {connectionError ?? intl.formatMessage(i18n.discoveryFailed)}
            </p>
          )}
        </div>
      )}

      {/* Models */}
      {isEditable && !compactSetup && (
        <div>
          <label
            htmlFor="available-models"
            className="flex items-center text-sm font-medium text-text-primary mb-2"
          >
            {intl.formatMessage(i18n.availableModels)}
            <span aria-hidden="true" className="text-red-500 ml-1">
              *
            </span>
          </label>
          <Input
            id="available-models"
            value={models}
            onChange={(e) => {
              setModels(e.target.value);
              if (e.target.value.split(',').some((value) => value.trim()))
                clearFieldError('models');
            }}
            placeholder={intl.formatMessage(i18n.modelsPlaceholder)}
            aria-invalid={!!validationErrors.models}
            aria-describedby={validationErrors.models ? 'available-models-error' : undefined}
            className={validationErrors.models ? 'border-red-500' : ''}
          />
          {validationErrors.models && (
            <p id="available-models-error" className="text-red-500 text-sm mt-1">
              {validationErrors.models}
            </p>
          )}
          {/* Capability badges when template is active */}
          {selectedTemplate && templateModelCapabilities && (
            <div className="flex gap-2 mt-2">
              {templateModelCapabilities.tool_call && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                  {intl.formatMessage(i18n.toolCalling)}
                </span>
              )}
              {templateModelCapabilities.reasoning && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">
                  {intl.formatMessage(i18n.reasoning)}
                </span>
              )}
              {templateModelCapabilities.attachment && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                  {intl.formatMessage(i18n.attachments)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Streaming */}
      {isEditable && (
        <div className="flex items-center space-x-2 mb-10">
          <input
            type="checkbox"
            id="supports-streaming"
            checked={supportsStreaming}
            onChange={(e) => setSupportsStreaming(e.target.checked)}
            className="rounded border-border-primary"
          />
          <label htmlFor="supports-streaming" className="text-sm text-text-secondary">
            {intl.formatMessage(i18n.supportsStreaming)}
          </label>
        </div>
      )}

      {/* Custom headers */}
      {isEditable && (
        <div>
          <label className="text-sm font-medium text-textStandard mb-2 block">
            {intl.formatMessage(i18n.customHeaders)}
          </label>
          <p className="text-xs text-textSubtle mb-4">
            {intl.formatMessage(i18n.customHeadersHint)}
          </p>
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
            {headers.map((header, index) => (
              <React.Fragment key={index}>
                <Input
                  value={header.key}
                  onChange={(e) => handleHeaderChange(index, 'key', e.target.value)}
                  placeholder={intl.formatMessage(i18n.headerNamePlaceholder)}
                  className="w-full text-textStandard border-borderSubtle hover:border-borderStandard"
                />
                <Input
                  value={header.value}
                  onChange={(e) => handleHeaderChange(index, 'value', e.target.value)}
                  placeholder={intl.formatMessage(i18n.valuePlaceholder)}
                  className="w-full text-textStandard border-borderSubtle hover:border-borderStandard"
                />
                <Button
                  onClick={() => handleRemoveHeader(index)}
                  variant="ghost"
                  type="button"
                  className="group p-2 h-auto text-iconSubtle hover:bg-transparent"
                >
                  <X className="h-3 w-3 text-gray-400 group-hover:text-white group-hover:drop-shadow-sm transition-all" />
                </Button>
              </React.Fragment>
            ))}

            <Input
              value={newHeaderKey}
              onChange={(e) => {
                setNewHeaderKey(e.target.value);
                clearHeaderValidation();
              }}
              onKeyDown={handleHeaderKeyDown}
              placeholder={intl.formatMessage(i18n.headerNamePlaceholder)}
              className={cn(
                'w-full text-textStandard border-borderSubtle hover:border-borderStandard',
                invalidHeaderFields.key && 'border-red-500 focus:border-red-500'
              )}
            />
            <Input
              value={newHeaderValue}
              onChange={(e) => {
                setNewHeaderValue(e.target.value);
                clearHeaderValidation();
              }}
              onKeyDown={handleHeaderKeyDown}
              placeholder={intl.formatMessage(i18n.valuePlaceholder)}
              className={cn(
                'w-full text-textStandard border-borderSubtle hover:border-borderStandard',
                invalidHeaderFields.value && 'border-red-500 focus:border-red-500'
              )}
            />
            <Button
              onClick={handleAddHeader}
              variant="ghost"
              type="button"
              className="flex items-center justify-start gap-1 px-2 pr-4 text-sm rounded-full text-textStandard bg-background-primary border border-borderSubtle hover:border-borderStandard transition-colors min-w-[60px] h-9 [&>svg]:!size-4"
            >
              <Plus /> {intl.formatMessage(i18n.add)}
            </Button>
          </div>
          {headerValidationError && (
            <div className="mt-2 text-red-500 text-sm">{headerValidationError}</div>
          )}
        </div>
      )}

      <SecureStorageNotice />

      {Object.keys(validationErrors).length > 0 && (
        <p role="alert" className="text-text-secondary text-sm">
          {Object.values(validationErrors)[0]}
        </p>
      )}

      {submitError && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          <p className="font-medium">{intl.formatMessage(submitError.rejected ? i18n.verificationFailed : i18n.verificationUnconfirmed)}</p>
          <p className="mt-1">{submitError.message}</p>
          <p className="mt-1">{intl.formatMessage(submitError.rejected ? i18n.notSaved : i18n.saveUnconfirmed)}</p>
          {submitError.details && <details className="mt-2">
            <summary className="cursor-pointer">{intl.formatMessage(i18n.diagnosticDetails)}</summary>
            <p className="mt-1 break-words font-mono text-xs">{submitError.details}</p>
          </details>}
        </div>
      )}

      {showDeleteConfirmation ? (
        <div className="pt-4 space-y-3">
          {deleteError && <p role="alert">{intl.formatMessage(i18n.deleteFailed)}</p>}
          <div className="px-4 py-3 bg-red-900/20 border border-red-500/30 rounded">
            <p className="text-red-400 text-sm">{intl.formatMessage(i18n.deleteConfirmation)}</p>
          </div>
          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => {
                setDeleteError(false);
                setShowDeleteConfirmation(false);
              }}
            >
              {intl.formatMessage(i18n.cancel)}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isSubmitting}
              onClick={async () => {
                if (isSubmitting) return;
                setIsSubmitting(true);
                setSubmitError(null);
                setDeleteError(false);
                try {
                  await onDelete?.();
                } catch {
                  setDeleteError(true);
                } finally {
                  setIsSubmitting(false);
                }
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {intl.formatMessage(i18n.confirmDelete)}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end space-x-2 pt-4">
          {initialData && onDelete && (
            <Button
              type="button"
              variant="outline"
              className="text-red-500 hover:text-red-600 mr-auto"
              onClick={() => setShowDeleteConfirmation(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {intl.formatMessage(i18n.deleteProvider)}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onCancel}>
            {intl.formatMessage(i18n.cancel)}
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || (compactSetup && !initialData && discoveryStatus !== 'ready')}
          >
            {isSubmitting ? intl.formatMessage(i18n.verifying) : initialData
              ? intl.formatMessage(i18n.updateProvider)
              : intl.formatMessage(i18n.createProvider)}
          </Button>
        </div>
      )}
      </fieldset>
    </form>
  );
}
