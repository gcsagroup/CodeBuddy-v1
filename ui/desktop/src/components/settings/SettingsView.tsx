import PetSettings from '../../pets/PetSettings';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  Cpu,
  ChevronDown,
  PawPrint,
  Brain,
  Keyboard,
  KeyRound,
  MessageSquare,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { View, ViewOptions } from '../../utils/navigationUtils';
import ModelsAndRuntimeSettings from './models/ModelsAndRuntimeSettings';
import AppSettingsSection from './app/AppSettingsSection';
import type { ExtensionConfig } from '../../types/extensions';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import ChatSettingsSection from './chat/ChatSettingsSection';
import KeyboardShortcutsSection from './keyboard/KeyboardShortcutsSection';
import AuthSettingsSection from './auth/AuthSettingsSection';
import { trackSettingsTabViewed } from '../../utils/analytics';
import { defineMessages, useIntl } from '../../i18n';
import MemorySettingsSection from './memory/MemorySettingsSection';
import SecurityAndPermissionsSection from './security/SecurityAndPermissionsSection';
import {
  matchesSettingsQuery,
  resolveSettingsPage,
  settingsNavigationItems,
  type SettingsGroupId,
  type SettingsPageId,
} from './settingsNavigation';

const i18n = defineMessages({
  pagePets: { id: 'settingsCenter.pagePets', defaultMessage: 'Virtual pets' },
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
  pageAuth: {
    id: 'settingsCenter.pageAuth',
    defaultMessage: 'Accounts and credentials',
  },
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
  pets: i18n.pagePets,
  app: i18n.pageApp,
  keyboard: i18n.pageKeyboard,
  models: i18n.pageModels,
  chat: i18n.pageChat,
  memory: i18n.pageMemory,
  auth: i18n.pageAuth,
  security: i18n.pageSecurity,
};

function SettingsPageIcon({ page }: { page: SettingsPageId }) {
  const className = 'h-4 w-4 shrink-0';

  switch (page) {
    case 'pets':
      return <PawPrint className={className} />;
    case 'app':
      return <AppWindow className={className} />;
    case 'keyboard':
      return <Keyboard className={className} />;
    case 'models':
      return <Cpu className={className} />;
    case 'chat':
      return <MessageSquare className={className} />;
    case 'memory':
      return <Brain className={className} />;
    case 'auth':
      return <KeyRound className={className} />;
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
  const [visitedEditors, setVisitedEditors] = useState<SettingsPageId[]>([initialPage]);
  const [searchQuery, setSearchQuery] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const compactNavButton = useRef<HTMLButtonElement>(null);
  const [subagentDirty, setSubagentDirty] = useState(false);
  const hasTrackedInitialPage = useRef(false);
  const intl = useIntl();

  const confirmDiscard = () =>
    !subagentDirty ||
    window.confirm(
      intl.formatMessage({
        id: 'promptsSettings.confirmUnsavedBack',
        defaultMessage: 'You have unsaved changes. Are you sure you want to go back?',
      })
    );
  const leaveSettings = (view: View, options?: ViewOptions) => {
    if (confirmDiscard()) setView(view, options);
  };

  const filteredNavigationItems = useMemo(
    () =>
      settingsNavigationItems.filter((item) =>
        matchesSettingsQuery(
          { ...item, keywords: [...item.keywords, intl.formatMessage(pageMessages[item.id])] },
          searchQuery
        )
      ),
    [searchQuery, intl]
  );

  const handlePageChange = (page: SettingsPageId) => {
    setActivePage(page);
    setNavigationOpen(false);
    setSearchQuery('');
    if (compactNavButton.current?.offsetWidth) compactNavButton.current.focus();
    trackSettingsTabViewed(page);
  };

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activePage]);

  useEffect(() => {
    if (activePage === 'models' || activePage === 'chat') {
      setVisitedEditors((pages) => (pages.includes(activePage) ? pages : [...pages, activePage]));
    }
  }, [activePage]);

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
      case 'pets':
        return <PetSettings />;
      case 'models':
      case 'chat':
        return null;
      case 'security':
        return <SecurityAndPermissionsSection />;
      case 'keyboard':
        return <KeyboardShortcutsSection />;
      case 'auth':
        return <AuthSettingsSection />;
      case 'memory':
        return <MemorySettingsSection />;
      case 'app':
        return <AppSettingsSection scrollToSection={viewOptions.section} />;
    }
  })();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && confirmDiscard()) onClose();
      }}
    >
      <DialogContent
        data-testid="settings-dialog"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (navigationOpen && compactNavButton.current?.offsetWidth) {
            event.preventDefault();
            setNavigationOpen(false);
            compactNavButton.current.focus();
          }
        }}
        overlayClassName="bg-black/25 backdrop-blur-[1px]"
        className="h-[min(88vh,800px)] max-sm:h-[calc(100dvh-1rem)] w-[min(calc(100vw-1rem),1080px)] !max-w-none gap-0 overflow-hidden rounded-2xl border-border-primary p-0 shadow-xl [&>button]:z-20"
      >
        <DialogTitle className="sr-only">{intl.formatMessage(i18n.title)}</DialogTitle>
        <div className="flex h-full min-h-0 flex-col bg-background-primary sm:flex-row">
          <aside
            data-testid="settings-navigation"
            className="relative z-10 flex min-h-0 shrink-0 flex-col border-b border-border-primary bg-background-secondary sm:w-52 sm:border-r sm:border-b-0 md:w-56"
          >
            <header className="flex flex-wrap items-center gap-2 px-4 py-3 max-sm:pr-14 sm:block sm:space-y-4 sm:px-4 sm:pt-6">
              <h1 className="w-full text-base font-semibold tracking-tight text-text-primary sm:px-2 sm:text-xl">
                {intl.formatMessage(i18n.title)}
              </h1>
              <button
                type="button"
                ref={compactNavButton}
                aria-expanded={navigationOpen}
                aria-controls="settings-category-nav"
                onClick={() => setNavigationOpen(!navigationOpen)}
                className="flex items-center gap-2 rounded-lg border border-border-primary bg-background-primary px-2.5 py-2 text-sm font-medium text-text-primary sm:hidden"
              >
                <SettingsPageIcon page={activePage} />
                {intl.formatMessage(pageMessages[activePage])}
                <ChevronDown className="size-3.5" aria-hidden />
              </button>
              <label className="flex min-w-28 flex-1 items-center gap-2 rounded-lg border border-border-primary bg-background-primary px-2.5 py-2 focus-within:border-border-info">
                <Search className="h-4 w-4 text-text-muted" />
                <input
                  data-testid="settings-search"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setNavigationOpen(true);
                  }}
                  placeholder={intl.formatMessage(i18n.searchPlaceholder)}
                  aria-label={intl.formatMessage(i18n.searchPlaceholder)}
                  className="min-w-0 w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
                />
              </label>
            </header>
            <nav
              id="settings-category-nav"
              aria-label={intl.formatMessage(i18n.title)}
              className={`min-h-0 space-y-4 overflow-y-auto px-3 py-3 max-sm:absolute max-sm:inset-x-0 max-sm:top-full max-sm:max-h-[52vh] max-sm:border-b max-sm:border-border-primary max-sm:bg-background-secondary max-sm:shadow-lg sm:flex-1 ${navigationOpen ? '' : 'max-sm:hidden'}`}
            >
              {settingsGroups.map((group) => {
                const items = filteredNavigationItems.filter((item) => item.group === group.id);
                if (items.length === 0) return null;

                return (
                  <section key={group.id}>
                    <h2 className="mb-1.5 px-3 text-xs font-medium text-text-secondary">
                      {intl.formatMessage(group.message)}
                    </h2>
                    <div className="space-y-0.5">
                      {items.map((item) => {
                        const selected = activePage === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            data-testid={`settings-nav-${item.id}`}
                            aria-current={selected ? 'page' : undefined}
                            onClick={() => handlePageChange(item.id)}
                            className="app-nav-link w-full"
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
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="max-sm:sr-only shrink-0 border-b border-border-primary px-7 py-5 pr-14">
              <h2 className="app-page-heading">
                {intl.formatMessage(pageMessages[activePage])}
              </h2>
            </header>
            <div ref={contentRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
              <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-7 sm:py-6 [&_[data-slot=card-title]]:font-semibold [&_[data-slot=card-description]]:mt-1 [&_[data-slot=card-description]]:leading-relaxed">
                {activeContent}
                <div hidden={activePage !== 'models'}>
                  {(activePage === 'models' || visitedEditors.includes('models')) && (
                    <ModelsAndRuntimeSettings
                      setView={leaveSettings}
                      onDirtyChange={setSubagentDirty}
                      active={activePage === 'models'}
                    />
                  )}
                </div>
                <div hidden={activePage !== 'chat'}>
                  {(activePage === 'chat' || visitedEditors.includes('chat')) && (
                    <ChatSettingsSection />
                  )}
                </div>
              </div>
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
