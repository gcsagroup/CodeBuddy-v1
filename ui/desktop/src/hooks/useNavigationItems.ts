import { Bot, BriefcaseBusiness, CalendarClock, History, Images, Settings, SquarePen } from 'lucide-react';
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
    icon: SquarePen,
    searchAliases: ['New Chat'],
  },
  {
    id: 'scheduler',
    path: '/schedules',
    label: 'Automatic Tasks',
    icon: CalendarClock,
    searchAliases: ['Scheduler'],
  },
  {
    id: 'toolbox',
    path: '/toolbox',
    label: 'Toolbox',
    icon: BriefcaseBusiness,
    searchAliases: ['Skills', 'Apps', 'Extensions', 'MCP'],
  },
  {
    id: 'sessions',
    path: '/sessions',
    label: 'History',
    icon: History,
    searchAliases: ['Session History'],
  },
  {
    id: 'media-library',
    path: '/media-library',
    label: 'Media Library',
    icon: Images,
    searchAliases: ['Images', 'Videos', '素材库'],
  },
  { id: 'custom-agents', path: '/custom-agents', label: 'Custom Agents', icon: Bot, searchAliases: ['自定义智能体', '角色'] },
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
  'custom-agents': { id: 'navigation.itemCustomAgents', defaultMessage: 'Custom Agents' },
  'media-library': {
    id: 'navigation.itemMediaLibrary',
    defaultMessage: 'Media Library',
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
