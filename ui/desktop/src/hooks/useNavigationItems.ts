import { Clock, FileText, History, MessageSquarePlus, Settings, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { defineMessages, type IntlShape, type MessageDescriptor } from 'react-intl';

export interface NavItem {
  id: string;
  path: string;
  label: string;
  icon: LucideIcon;
  getTag?: () => string;
  tagAlign?: 'left' | 'right';
  searchAliases?: string[];
}

/** Top-level nav items (excluding Settings which is pinned to the bottom). */
export const NAV_ITEMS: NavItem[] = [
  {
    id: 'home',
    path: '/',
    label: 'New Task',
    icon: MessageSquarePlus,
    searchAliases: ['New Chat'],
  },
  {
    id: 'recipes',
    path: '/recipes',
    label: 'Common Tasks',
    icon: FileText,
    searchAliases: ['Recipes'],
  },
  {
    id: 'scheduler',
    path: '/schedules',
    label: 'Automatic Tasks',
    icon: Clock,
    searchAliases: ['Scheduler'],
  },
  {
    id: 'toolbox',
    path: '/toolbox',
    label: 'Toolbox',
    icon: Wrench,
    searchAliases: ['Skills', 'Apps', 'Extensions', 'MCP'],
  },
  {
    id: 'sessions',
    path: '/sessions',
    label: 'History',
    icon: History,
    searchAliases: ['Session History'],
  },
];

/** Settings is rendered separately, pinned to the bottom of the sidebar. */
export const SETTINGS_NAV_ITEM: NavItem = {
  id: 'settings',
  path: '/settings',
  label: 'Settings',
  icon: Settings,
};

// Translation descriptors for nav labels. Kept here next to NAV_ITEMS so the two
// stay in sync.
const navItemMessages = defineMessages({
  home: {
    id: 'navigation.itemHome',
    defaultMessage: 'New Task',
  },
  recipes: {
    id: 'navigation.itemRecipes',
    defaultMessage: 'Common Tasks',
  },
  scheduler: {
    id: 'navigation.itemScheduler',
    defaultMessage: 'Automatic Tasks',
  },
  toolbox: {
    id: 'navigation.itemToolbox',
    defaultMessage: 'Toolbox',
  },
  sessions: {
    id: 'navigation.itemSessions',
    defaultMessage: 'History',
  },
  settings: {
    id: 'navigation.itemSettings',
    defaultMessage: 'Settings',
  },
});

const NAV_ITEM_MESSAGES: Record<string, MessageDescriptor> = navItemMessages;

/** Format a NavItem's label using the provided intl instance, falling back to `item.label`. */
export function getNavItemLabel(item: NavItem, intl: IntlShape): string {
  const descriptor = NAV_ITEM_MESSAGES[item.id];
  return descriptor ? intl.formatMessage(descriptor) : item.label;
}
