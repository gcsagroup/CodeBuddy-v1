import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpenCheck,
  ChevronRight,
  LockKeyhole,
  MonitorCog,
  PackageCheck,
  PlugZap,
  RefreshCw,
  Search,
  Wrench,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { loadToolbox, type ToolboxLoadResult } from '../../acp/toolbox';
import { testConfigExtension } from '../../acp/extensions';
import { getInitialWorkingDir } from '../../utils/workingDir';
import type { ToolboxItem, ToolboxModel } from '../../types/toolbox';
import type { ToolboxSection } from '../../utils/toolboxRouting';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Switch } from '../ui/switch';
import { defineMessages, useIntl } from '../../i18n';
import ExtensionsSection from '../settings/extensions/ExtensionsSection';
import SkillManager, { type SkillManagerRequest } from '../skills/SkillManager';
import { useConfig } from '../ConfigContext';
import { applySkillChange, previewSkillChange, type ManagedSkill } from '../../acp/skillManagement';
import { localizeToolboxItem } from './toolboxLocalization';
import { capabilityExample } from './capabilityExamples';

const EMPTY_MODEL: ToolboxModel = { capabilities: [], methods: [], apps: [], external: [] };
type VisibleToolboxSection = Extract<
  ToolboxSection,
  'all' | 'capabilities' | 'methods' | 'external'
>;
const SECTIONS: VisibleToolboxSection[] = ['all', 'capabilities', 'methods', 'external'];
const ADVANCED_CAPABILITIES = new Set([
  'tom',
  'todo',
  'summarize',
  'code_execution',
  'codeexecution',
  'apps',
  'autovisualiser',
  'memory',
]);

const i18n = defineMessages({
  title: { id: 'toolbox.title', defaultMessage: 'Toolbox' },
  description: {
    id: 'toolbox.description',
    defaultMessage: 'Manage built-in tools, installed skills, and connected external MCP servers.',
  },
  search: { id: 'toolbox.search', defaultMessage: 'Search tools' },
  loading: { id: 'toolbox.loading', defaultMessage: 'Loading tools…' },
  retry: { id: 'toolbox.retry', defaultMessage: 'Try again' },
  noMatching: { id: 'toolbox.noMatching', defaultMessage: 'No matching tools' },
  noItems: { id: 'toolbox.noItems', defaultMessage: 'Nothing is configured in this section yet.' },
  tablist: { id: 'toolbox.sections', defaultMessage: 'Toolbox sections' },
  all: { id: 'toolbox.sectionAll', defaultMessage: 'All' },
  capabilities: { id: 'toolbox.sectionCapabilities', defaultMessage: 'Built-in capabilities' },
  methods: { id: 'toolbox.sectionMethods', defaultMessage: 'Skills' },
  apps: { id: 'toolbox.sectionApps', defaultMessage: 'My mini tools' },
  external: { id: 'toolbox.sectionExternal', defaultMessage: 'External MCP' },
  addSkill: { id: 'toolbox.addSkill', defaultMessage: 'Add skill' },
  addMcp: {
    id: 'extensionsSection.addCustomExtension',
    defaultMessage: 'Add custom extension',
  },
  builtIn: { id: 'skillManager.scope.builtin', defaultMessage: 'Built in' },
  required: { id: 'toolbox.required', defaultMessage: 'Required' },
  implementation: { id: 'toolbox.implementation', defaultMessage: 'Implementation' },
  availability: { id: 'toolbox.availability', defaultMessage: 'Availability' },
  inspectTools: { id: 'toolbox.inspectTools', defaultMessage: 'Read tool inventory' },
  discoveryFailed: { id: 'toolbox.discoveryFailed', defaultMessage: 'Tool discovery failed' },
  configuredTools: { id: 'toolbox.configuredTools', defaultMessage: 'Configured tool filter' },
  inventoryOnly: {
    id: 'toolbox.inventoryOnly',
    defaultMessage:
      'Discovery succeeded. This verifies the tool inventory, not successful execution of these tools.',
  },
  advanced: {
    id: 'toolbox.advancedCapabilities',
    defaultMessage: 'Advanced and compatibility capabilities',
  },
  example: { id: 'toolbox.detailExample', defaultMessage: 'Example use' },
  tools: { id: 'toolbox.detailTools', defaultMessage: 'Included tools' },
  toolsUnknown: {
    id: 'toolbox.detailToolsUnknown',
    defaultMessage:
      'No tool filter is configured. Read the inventory below to see the available tools.',
  },
  acceptance: { id: 'toolbox.detailAcceptance', defaultMessage: 'Acceptance status' },
  unverified: {
    id: 'toolbox.detailUnverified',
    defaultMessage:
      'Not verified for this installation. Enabling a capability does not prove that its actions succeed. Permissions and connection requirements are checked during each call.',
  },
  enabledUnverified: { id: 'toolbox.enabledUnverified', defaultMessage: 'Enabled · not verified' },
  globalDefault: {
    id: 'toolbox.globalDefault',
    defaultMessage: 'This switch controls the default availability for new tasks.',
  },
  computerSafety: {
    id: 'toolbox.computerSafety',
    defaultMessage:
      'Computer control can observe windows, inspect controls, capture screenshots, and perform bounded mouse and keyboard actions. High-risk actions still require separate approval.',
  },
  enableTool: { id: 'toolbox.enableTool', defaultMessage: 'Enable {name}' },
  disableTool: { id: 'toolbox.disableTool', defaultMessage: 'Disable {name}' },
  requiredTool: { id: 'toolbox.requiredTool', defaultMessage: '{name} is required' },
  installed: { id: 'toolbox.sourceInstalled', defaultMessage: 'Installed' },
  statusReady: { id: 'toolbox.statusReady', defaultMessage: 'Ready' },
  statusConfigured: {
    id: 'toolbox.statusConfigured',
    defaultMessage: 'Enabled, connection not verified',
  },
  statusDisabled: { id: 'toolbox.statusDisabled', defaultMessage: 'Disabled' },
  statusStarting: { id: 'toolbox.statusStarting', defaultMessage: 'Starting…' },
  statusStopping: { id: 'toolbox.statusStopping', defaultMessage: 'Stopping…' },
  statusSetup: { id: 'toolbox.statusSetup', defaultMessage: 'Setup needed' },
  statusPermission: { id: 'toolbox.statusPermission', defaultMessage: 'Permission needed' },
  statusFailed: { id: 'toolbox.statusFailed', defaultMessage: 'Failed' },
  usage: {
    id: 'toolbox.usage',
    defaultMessage: 'Used successfully {count, plural, one {# time} other {# times}}',
  },
});

function isToolboxSection(value: string | null): value is VisibleToolboxSection {
  return SECTIONS.some((section) => section === value);
}

function isBuiltInSkill(item: ToolboxItem): boolean {
  if (item.kind !== 'skill' || !item.skillSource) return false;
  return 'type' in item.skillSource
    ? item.skillSource.type === 'builtinSkill'
    : item.skillSource.source.rootKind === 'builtin';
}

function managedSkillFor(item: ToolboxItem): ManagedSkill | undefined {
  if (item.kind !== 'skill' || !item.skillSource || 'type' in item.skillSource) return undefined;
  return item.skillSource;
}

function ItemCard({
  item,
  onOpen,
  onToggle,
  toggling,
}: {
  item: ToolboxItem;
  onOpen: (item: ToolboxItem) => void;
  onToggle: (item: ToolboxItem) => void;
  toggling: boolean;
}) {
  const intl = useIntl();
  const statusMessages = {
    ready: i18n.statusReady,
    configured: i18n.statusConfigured,
    disabled: i18n.statusDisabled,
    setup: i18n.statusSetup,
    permission: i18n.statusPermission,
    failed: i18n.statusFailed,
  };
  const builtIn = isBuiltInSkill(item);
  const ItemIcon =
    item.kind === 'builtin'
      ? MonitorCog
      : item.kind === 'skill'
        ? builtIn
          ? BookOpenCheck
          : PackageCheck
        : PlugZap;
  const enabled = item.status !== 'disabled';
  const displayedStatus = toggling
    ? enabled
      ? i18n.statusStopping
      : i18n.statusStarting
    : item.kind === 'builtin' && item.status === 'configured'
      ? i18n.enabledUnverified
      : statusMessages[item.status];
  const toggleable = item.actions.includes(enabled ? 'disable' : 'enable');
  return (
    <Card className="group overflow-hidden border-border-secondary bg-background-primary py-0 shadow-none transition-colors hover:border-border-primary hover:bg-background-secondary">
      <div className="flex min-h-32 items-stretch">
        <button
          type="button"
          aria-label={item.name}
          onClick={() => onOpen(item)}
          className="flex min-w-0 flex-1 items-start gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-secondary bg-background-secondary text-text-secondary">
            <ItemIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-medium">{item.name}</h3>
              {item.kind === 'skill' && (
                <span className="rounded-md border border-border-secondary px-1.5 py-0.5 text-[11px] text-text-muted">
                  {intl.formatMessage(builtIn ? i18n.builtIn : i18n.installed)}
                </span>
              )}
              {item.kind === 'builtin' && (
                <span className="rounded-md border border-border-secondary px-1.5 py-0.5 text-[11px] text-text-muted">
                  {intl.formatMessage(i18n.builtIn)}
                </span>
              )}
              {item.locked && (
                <span className="inline-flex items-center gap-1 rounded-md border border-border-secondary px-1.5 py-0.5 text-[11px] text-text-muted">
                  <LockKeyhole className="size-3" />
                  {intl.formatMessage(i18n.required)}
                </span>
              )}
              <span
                aria-live="polite"
                className="rounded-md bg-background-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary"
              >
                {intl.formatMessage(displayedStatus)}
              </span>
            </div>
            <p className="mt-2 line-clamp-2 text-sm leading-5 text-text-secondary">
              {item.description}
            </p>
            {item.usage && (
              <p className="mt-3 text-xs text-text-muted">
                {intl.formatMessage(i18n.usage, { count: item.usage.successCount })}
              </p>
            )}
          </div>
          <ChevronRight className="mt-2 size-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" />
        </button>
        {(toggleable || item.locked) && (
          <div className="flex w-16 shrink-0 items-center justify-center border-l border-border-secondary">
            <Switch
              checked={enabled}
              disabled={item.locked || toggling || !toggleable}
              onCheckedChange={() => onToggle(item)}
              variant="mono"
              aria-label={intl.formatMessage(
                item.locked ? i18n.requiredTool : enabled ? i18n.disableTool : i18n.enableTool,
                { name: item.name }
              )}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

function BuiltInToolDetails({ item, onClose }: { item?: ToolboxItem; onClose: () => void }) {
  const intl = useIntl();
  const [inventory, setInventory] = useState<{ tools: string[]; error?: string }>();
  const [inspecting, setInspecting] = useState(false);
  useEffect(() => {
    setInventory(undefined);
    setInspecting(false);
  }, [item?.id]);
  const inspect = async () => {
    if (!item?.extensionSource || inspecting) return;
    setInspecting(true);
    try {
      const result = await testConfigExtension(item.extensionSource, {}, getInitialWorkingDir());
      setInventory({
        tools: result.tools,
        error: result.success
          ? undefined
          : (result.error ?? intl.formatMessage(i18n.discoveryFailed)),
      });
    } catch (error) {
      setInventory({ tools: [], error: String(error) });
    } finally {
      setInspecting(false);
    }
  };
  if (!item) return null;
  const technicalName =
    item.reference?.value === 'qwen_computer' ? 'Computer Use (qwen_computer)' : item.name;
  const example = capabilityExample(item.reference?.value ?? item.name, intl.locale);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>{item.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {example && (
            <div>
              <p className="text-xs text-text-muted">{intl.formatMessage(i18n.example)}</p>
              <p className="mt-1">{example}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-text-muted">{intl.formatMessage(i18n.configuredTools)}</p>
            {item.tools?.length ? (
              <ul className="mt-1 list-inside list-disc break-all">
                {item.tools.map((tool) => (
                  <li key={tool}>{tool}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1">
                {example && item.reference?.value === 'tom'
                  ? example
                  : intl.formatMessage(i18n.toolsUnknown)}
              </p>
            )}
          </div>
          {item.extensionSource && item.reference?.value !== 'tom' && (
            <div>
              <Button variant="outline" disabled={inspecting} onClick={() => void inspect()}>
                {intl.formatMessage(inspecting ? i18n.loading : i18n.inspectTools)}
              </Button>
              {inventory?.error && (
                <p role="alert" className="mt-2 text-text-secondary">
                  {inventory.error}
                </p>
              )}
              {inventory && !inventory.error && (
                <div className="mt-2">
                  <p>{intl.formatMessage(i18n.inventoryOnly)}</p>
                  <ul className="mt-2 list-inside list-disc break-all">
                    {inventory.tools.map((tool) => (
                      <li key={tool}>{tool}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <div>
            <p className="text-xs text-text-muted">{intl.formatMessage(i18n.acceptance)}</p>
            <p className="mt-1">{intl.formatMessage(i18n.unverified)}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{intl.formatMessage(i18n.implementation)}</p>
            <p className="mt-1 font-mono">{technicalName}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{intl.formatMessage(i18n.availability)}</p>
            <p className="mt-1">{intl.formatMessage(i18n.globalDefault)}</p>
          </div>
          {item.reference?.value === 'qwen_computer' && (
            <p>{intl.formatMessage(i18n.computerSafety)}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function ToolboxView() {
  const intl = useIntl();
  const { extensionsList, setExtensionEnabled } = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get('section');
  const selectedSection: VisibleToolboxSection = isToolboxSection(requestedSection)
    ? requestedSection
    : 'all';
  const [result, setResult] = useState<ToolboxLoadResult>({
    model: EMPTY_MODEL,
    errors: {},
    warnings: [],
  });
  const [loading, setLoading] = useState(true);
  const refreshVersion = useRef(0);
  const [query, setQuery] = useState(searchParams.get('query') ?? '');
  const [skillRequest, setSkillRequest] = useState<SkillManagerRequest>();
  const [controlledMcpKey, setControlledMcpKey] = useState<string>();
  const [controlledMcpAdd, setControlledMcpAdd] = useState(false);
  const [selectedBuiltIn, setSelectedBuiltIn] = useState<ToolboxItem>();
  const [togglingId, setTogglingId] = useState<string>();

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const next = await loadToolbox(getInitialWorkingDir());
      if (version === refreshVersion.current) {
        setResult(next);
        if (!next.errors.methods) {
          // Details must follow the same backend snapshot as the cards, including
          // when the user opens a card before its post-save refresh finishes.
          setSkillRequest((current) => {
            if (current?.type !== 'detail') return current;
            const source = current.skill.source;
            const skill = next.model.methods
              .map(managedSkillFor)
              .find(
                (candidate) =>
                  candidate?.source.rootKind === source.rootKind &&
                  candidate.source.rootId === source.rootId &&
                  candidate.source.relativePath === source.relativePath
              );
            return skill ? { type: 'detail', skill } : undefined;
          });
        }
      }
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, extensionsList]);

  const items = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const sectionItems =
      selectedSection === 'all'
        ? [...result.model.capabilities, ...result.model.methods, ...result.model.external]
        : result.model[selectedSection];
    return sectionItems
      .map((item) => ({ original: item, display: localizeToolboxItem(item, intl) }))
      .filter(({ original, display }) =>
        `${original.id} ${original.reference?.key ?? ''} ${original.reference?.value ?? ''} ${original.name} ${original.description} ${display.name} ${display.description}`
          .toLocaleLowerCase()
          .includes(normalized)
      )
      .map(({ display }) => display)
      .sort((a, b) => a.name.localeCompare(b.name, intl.locale));
  }, [query, result.model, selectedSection, intl]);
  const hasUnfilteredItems =
    selectedSection === 'all'
      ? result.model.capabilities.length +
          result.model.methods.length +
          result.model.external.length >
        0
      : result.model[selectedSection].length > 0;
  const builtInSkills = items.filter(isBuiltInSkill);
  const installedSkills = items.filter((item) => item.kind === 'skill' && !isBuiltInSkill(item));
  const joinHeading = (scope: string, noun: string) =>
    /^(zh|ja|ko)(-|$)/i.test(intl.locale) ? `${scope}${noun}` : `${scope} ${noun}`;
  const builtInSkillsHeading = joinHeading(
    intl.formatMessage(i18n.builtIn),
    intl.formatMessage(i18n.methods)
  );
  const installedSkillsHeading = joinHeading(
    intl.formatMessage(i18n.installed),
    intl.formatMessage(i18n.methods)
  );

  const openItem = (item: ToolboxItem) => {
    if (item.kind === 'builtin') {
      setSelectedBuiltIn(item);
      return;
    }
    const skill = managedSkillFor(item);
    if (skill) {
      setSkillRequest({ type: 'detail', skill });
      return;
    }
    if (item.kind === 'external') {
      setControlledMcpKey(item.reference?.value ?? item.name);
    }
  };

  const toggleItem = async (item: ToolboxItem) => {
    if (item.locked || togglingId) return;
    setTogglingId(item.id);
    try {
      const enabled = item.status === 'disabled';
      if (item.kind === 'skill') {
        const skill = managedSkillFor(item);
        if (!skill || skill.readOnly) return;
        const preview = await previewSkillChange(
          {
            operation: 'set_enabled',
            source: skill.source,
            expectedVersion: skill.version,
            enabled,
          },
          getInitialWorkingDir()
        );
        if (preview.hasConflict || preview.requiresConfirmation) {
          setSkillRequest({ type: 'detail', skill });
          return;
        }
        await applySkillChange(preview.previewToken);
      } else {
        const configKey = item.reference?.value;
        if (!configKey) return;
        await setExtensionEnabled(configKey, enabled);
      }
      await refresh();
    } finally {
      setTogglingId(undefined);
    }
  };

  const renderGrid = (entries: ToolboxItem[]) => (
    <div className="grid gap-3 lg:grid-cols-2">
      {entries.map((item) => (
        <ItemCard
          key={item.id}
          item={item}
          onOpen={openItem}
          onToggle={(entry) => void toggleItem(entry)}
          toggling={togglingId === item.id}
        />
      ))}
    </div>
  );

  const renderCardGrid = (entries: ToolboxItem[]) => {
    const advanced = entries.filter(
      (item) => item.kind === 'builtin' && ADVANCED_CAPABILITIES.has(item.reference?.value ?? '')
    );
    const basic = entries.filter((item) => !advanced.includes(item));
    return (
      <>
        {renderGrid(basic)}
        {advanced.length > 0 && (
          <details
            className="mt-5 rounded-lg border border-border-secondary p-4"
            open={query.trim() ? true : undefined}
          >
            <summary className="cursor-pointer text-sm font-medium">
              {intl.formatMessage(i18n.advanced)} ({advanced.length})
            </summary>
            <div className="mt-4">{renderGrid(advanced)}</div>
          </details>
        )}
      </>
    );
  };

  return (
    <MainPanelLayout>
      <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-16 pt-6 sm:px-6 sm:pt-12 lg:px-10">
        <div className="mx-auto max-w-6xl">
          <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-background-secondary">
                  <Wrench className="size-5 text-text-secondary" />
                </div>
                <h1 className="text-2xl font-medium">{intl.formatMessage(i18n.title)}</h1>
              </div>
              <p className="mt-2 text-sm text-text-secondary">
                {intl.formatMessage(i18n.description)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {(selectedSection === 'all' || selectedSection === 'methods') && (
                <Button onClick={() => setSkillRequest({ type: 'create' })}>
                  {intl.formatMessage(i18n.addSkill)}
                </Button>
              )}
              {(selectedSection === 'all' || selectedSection === 'external') && (
                <Button onClick={() => setControlledMcpAdd(true)}>
                  {intl.formatMessage(i18n.addMcp)}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => void refresh()}
                aria-label={intl.formatMessage(i18n.retry)}
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
          </div>

          {(Object.values(result.errors).length > 0 || result.warnings.length > 0) && (
            <div className="mb-4 space-y-1 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
              {[...new Set([...Object.values(result.errors), ...result.warnings])].map(
                (message) => (
                  <p key={message} className="flex items-center gap-2">
                    <AlertTriangle className="size-4" />
                    {message}
                  </p>
                )
              )}
            </div>
          )}

          <div
            role="tablist"
            aria-label={intl.formatMessage(i18n.tablist)}
            className="mb-5 grid w-full grid-cols-4 rounded-lg border border-border-secondary bg-background-secondary p-1 sm:inline-grid sm:w-auto"
          >
            {SECTIONS.map((section) => (
              <button
                key={section}
                role="tab"
                aria-selected={selectedSection === section}
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.set('section', section);
                  setSearchParams(next);
                }}
                className={`rounded-md px-4 py-2 text-sm transition-colors ${selectedSection === section ? 'bg-background-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {intl.formatMessage(i18n[section])}
              </button>
            ))}
          </div>

          <label className="mb-7 flex max-w-2xl items-center gap-2 rounded-lg border border-border-secondary bg-background-primary px-3 py-2.5 focus-within:ring-1 focus-within:ring-ring">
            <Search className="size-4 text-text-secondary" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={intl.formatMessage(i18n.search)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>

          {loading ? (
            <p className="text-sm text-text-secondary">{intl.formatMessage(i18n.loading)}</p>
          ) : items.length > 0 ? (
            selectedSection === 'methods' ? (
              <div className="space-y-8">
                {builtInSkills.length > 0 && (
                  <section>
                    <div className="mb-3 flex items-center gap-2">
                      <h2 className="text-sm font-medium">{builtInSkillsHeading}</h2>
                      <span className="text-xs text-text-muted">{builtInSkills.length}</span>
                    </div>
                    {renderCardGrid(builtInSkills)}
                  </section>
                )}
                {installedSkills.length > 0 && (
                  <section>
                    <div className="mb-3 flex items-center gap-2">
                      <h2 className="text-sm font-medium">{installedSkillsHeading}</h2>
                      <span className="text-xs text-text-muted">{installedSkills.length}</span>
                    </div>
                    {renderCardGrid(installedSkills)}
                  </section>
                )}
              </div>
            ) : (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-sm font-medium">
                    {intl.formatMessage(i18n[selectedSection])}
                  </h2>
                  <span className="text-xs text-text-muted">{items.length}</span>
                </div>
                {renderCardGrid(items)}
              </section>
            )
          ) : (
            <p className="text-sm text-text-secondary">
              {intl.formatMessage(hasUnfilteredItems ? i18n.noMatching : i18n.noItems)}
            </p>
          )}

          <SkillManager
            dialogOnly
            request={skillRequest}
            onRequestClose={() => setSkillRequest(undefined)}
            onChanged={() => void refresh()}
          />
          <ExtensionsSection
            allowedTypes={['stdio', 'streamable_http', 'sse']}
            hideList
            hideButtons
            controlledConfigKey={controlledMcpKey}
            controlledAddOpen={controlledMcpAdd}
            onControlledRequestClose={() => {
              setControlledMcpKey(undefined);
              setControlledMcpAdd(false);
              void refresh();
            }}
          />
          <BuiltInToolDetails
            key={selectedBuiltIn?.id}
            item={selectedBuiltIn}
            onClose={() => setSelectedBuiltIn(undefined)}
          />
        </div>
      </div>
    </MainPanelLayout>
  );
}
