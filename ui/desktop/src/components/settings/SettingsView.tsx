import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  Bot,
  Brain,
  Cable,
  Keyboard,
  KeyRound,
  MessageSquare,
  Search,
  Mic,
  ShieldCheck,
} from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { View, ViewOptions } from '../../utils/navigationUtils';
import ModelsAndRuntimeSettings from './models/ModelsAndRuntimeSettings';
import ExternalBackendSection from './app/ExternalBackendSection';
import AppSettingsSection from './app/AppSettingsSection';
import type { ExtensionConfig } from '../../types/extensions';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import ChatSettingsSection from './chat/ChatSettingsSection';
import KeyboardShortcutsSection from './keyboard/KeyboardShortcutsSection';
import AuthSettingsSection from './auth/AuthSettingsSection';
import { trackSettingsTabViewed } from '../../utils/analytics';
import { defineMessages, useIntl } from '../../i18n';
import MemorySettingsSection from './memory/MemorySettingsSection';
import InputSettingsSection from './input/InputSettingsSection';
import SecurityAndPermissionsSection from './security/SecurityAndPermissionsSection';
import {
  matchesSettingsQuery,
  resolveSettingsPage,
  settingsNavigationItems,
  type SettingsGroupId,
  type SettingsPageId,
} from './settingsNavigation';

const i18n = defineMessages({
  title: {
    id: 'settingsView.title',
    defaultMessage: 'Settings',
  },
  searchPlaceholder: {
    id: 'settingsCenter.searchPlaceholder',
    defaultMessage: 'Search settings',
  },
  noSearchResults: {
    id: 'settingsCenter.noSearchResults',
    defaultMessage: 'No matching settings',
  },
  groupCommon: {
    id: 'settingsCenter.groupCommon',
    defaultMessage: 'Common',
  },
  groupAi: {
    id: 'settingsCenter.groupAi',
    defaultMessage: 'AI',
  },
  groupConnections: {
    id: 'settingsCenter.groupConnections',
    defaultMessage: 'Connections and security',
  },
  pageApp: {
    id: 'settingsCenter.pageApp',
    defaultMessage: 'General',
  },
  pageKeyboard: {
    id: 'settingsCenter.pageKeyboard',
    defaultMessage: 'Keyboard shortcuts',
  },
  pageModels: {
    id: 'settingsCenter.pageModels',
    defaultMessage: 'Models and runtime',
  },
  pageChat: {
    id: 'settingsCenter.pageChat',
    defaultMessage: 'Behavior and responses',
  },
  pageMemory: {
    id: 'settingsCenter.pageMemory',
    defaultMessage: 'Memory',
  },
  pageSharing: {
    id: 'settingsCenter.pageSharing',
    defaultMessage: 'Tools and connections',
  },
  pageAuth: {
    id: 'settingsCenter.pageAuth',
    defaultMessage: 'Accounts and credentials',
  },
  pageInput: { id: 'settingsCenter.pageInput', defaultMessage: 'Input' },
  pageSecurity: {
    id: 'settingsCenter.pageSecurity',
    defaultMessage: 'Security and permissions',
  },
});

const settingsGroups: Array<{
  id: SettingsGroupId;
  message: (typeof i18n)[keyof typeof i18n];
}> = [
  { id: 'common', message: i18n.groupCommon },
  { id: 'ai', message: i18n.groupAi },
  { id: 'connections', message: i18n.groupConnections },
];

const pageMessages: Record<SettingsPageId, (typeof i18n)[keyof typeof i18n]> = {
  app: i18n.pageApp,
  keyboard: i18n.pageKeyboard,
  models: i18n.pageModels,
  chat: i18n.pageChat,
  memory: i18n.pageMemory,
  sharing: i18n.pageSharing,
  auth: i18n.pageAuth,
  input: i18n.pageInput,
  security: i18n.pageSecurity,
};

function SettingsPageIcon({ page }: { page: SettingsPageId }) {
  const className = 'h-4 w-4 shrink-0';

  switch (page) {
    case 'app':
      return <AppWindow className={className} />;
    case 'keyboard':
      return <Keyboard className={className} />;
    case 'models':
      return <Bot className={className} />;
    case 'chat':
      return <MessageSquare className={className} />;
    case 'memory':
      return <Brain className={className} />;
    case 'sharing':
      return <Cable className={className} />;
    case 'auth':
      return <KeyRound className={className} />;
    case 'input':
      return <Mic className={className} />;
    case 'security':
      return <ShieldCheck className={className} />;
  }
}

export type SettingsViewOptions = {
  deepLinkConfig?: ExtensionConfig;
  showEnvVars?: boolean;
  section?: string;
};

export default function SettingsView({
  onClose,
  setView,
  viewOptions,
}: {
  onClose: () => void;
  setView: (view: View, viewOptions?: ViewOptions) => void;
  viewOptions: SettingsViewOptions;
}) {
  const initialPage = resolveSettingsPage(viewOptions.section) ?? 'models';
  const [activePage, setActivePage] = useState<SettingsPageId>(initialPage);
  const [searchQuery, setSearchQuery] = useState('');
  const hasTrackedInitialPage = useRef(false);
  const intl = useIntl();

  const filteredNavigationItems = useMemo(
    () => settingsNavigationItems.filter((item) => matchesSettingsQuery(item, searchQuery)),
    [searchQuery]
  );

  const handlePageChange = (page: SettingsPageId) => {
    setActivePage(page);
    trackSettingsTabViewed(page);
  };

  useEffect(() => {
    const targetPage = resolveSettingsPage(viewOptions.section);
    if (targetPage) {
      setActivePage(targetPage);
    }
  }, [viewOptions.section]);

  useEffect(() => {
    if (!hasTrackedInitialPage.current) {
      trackSettingsTabViewed(activePage);
      hasTrackedInitialPage.current = true;
    }
  }, [activePage]);

  const activeContent = (() => {
    switch (activePage) {
      case 'models':
        return <ModelsAndRuntimeSettings setView={setView} />;
      case 'chat':
        return <ChatSettingsSection />;
      case 'sharing':
        return <ExternalBackendSection />;
      case 'input':
        return <InputSettingsSection />;
      case 'security':
        return <SecurityAndPermissionsSection />;
      case 'keyboard':
        return <KeyboardShortcutsSection />;
      case 'auth':
        return <AuthSettingsSection />;
      case 'memory':
        return <MemorySettingsSection />;
      case 'app':
        return (
          <div className="space-y-8 pb-8">
            <AppSettingsSection scrollToSection={viewOptions.section} />
          </div>
        );
    }
  })();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="settings-dialog"
        aria-describedby={undefined}
        overlayClassName="bg-black/25 backdrop-blur-[1px]"
        className="h-[min(88vh,960px)] max-h-[calc(100vh-1rem)] w-[min(92vw,1200px)] !max-w-none gap-0 overflow-hidden rounded-2xl border-border-subtle p-0 shadow-2xl"
      >
        <DialogTitle className="sr-only">{intl.formatMessage(i18n.title)}</DialogTitle>
        <div className="flex h-full min-h-0 bg-background-primary">
          <aside
            data-testid="settings-navigation"
            className="flex w-64 shrink-0 flex-col border-r border-border-subtle bg-background-default/70"
          >
            <header className="space-y-4 border-b border-border-subtle px-5 pb-5 pt-6">
              <h1 className="text-2xl font-semibold text-text-primary">
                {intl.formatMessage(i18n.title)}
              </h1>
              <label className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-background-primary px-3 py-2 focus-within:border-border-default">
                <Search className="h-4 w-4 text-text-muted" />
                <input
                  data-testid="settings-search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={intl.formatMessage(i18n.searchPlaceholder)}
                  aria-label={intl.formatMessage(i18n.searchPlaceholder)}
                  className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                />
              </label>
            </header>
            <ScrollArea className="min-h-0 flex-1 px-3 py-5">
              <nav aria-label={intl.formatMessage(i18n.title)} className="space-y-5">
                {settingsGroups.map((group) => {
                  const items = filteredNavigationItems.filter((item) => item.group === group.id);
                  if (items.length === 0) return null;

                  return (
                    <section key={group.id}>
                      <h2 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        {intl.formatMessage(group.message)}
                      </h2>
                      <div className="space-y-1">
                        {items.map((item) => {
                          const selected = activePage === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              data-testid={`settings-nav-${item.id}`}
                              aria-current={selected ? 'page' : undefined}
                              onClick={() => handlePageChange(item.id)}
                              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                                selected
                                  ? 'bg-background-muted font-medium text-text-primary'
                                  : 'text-text-secondary hover:bg-background-muted/60 hover:text-text-primary'
                              }`}
                            >
                              <SettingsPageIcon page={item.id} />
                              <span>{intl.formatMessage(pageMessages[item.id])}</span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}

                {filteredNavigationItems.length === 0 && (
                  <p className="px-3 py-8 text-center text-sm text-text-muted">
                    {intl.formatMessage(i18n.noSearchResults)}
                  </p>
                )}
              </nav>
            </ScrollArea>
          </aside>

          <main className="min-w-0 flex-1 bg-background-primary pt-8">
            <ScrollArea className="h-full">
              <div className="mx-auto w-full max-w-5xl px-8 pb-8 pt-2">
                <h2 className="mb-5 text-2xl font-semibold text-text-primary">
                  {intl.formatMessage(pageMessages[activePage])}
                </h2>
                {activeContent}
              </div>
            </ScrollArea>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
