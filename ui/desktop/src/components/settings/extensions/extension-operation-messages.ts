import type { IntlShape } from 'react-intl';
import { defineMessages } from '../../../i18n';
import type { AgentExtensionMessages } from './agent-api';
import type { ExtensionOperationMessages } from './extension-manager';

const i18n = defineMessages({
  enabledInDefaults: {
    id: 'extensionOperations.enabledInDefaults',
    defaultMessage: 'Extension enabled in defaults',
  },
  removedFromDefaults: {
    id: 'extensionOperations.removedFromDefaults',
    defaultMessage: 'Extension removed from defaults',
  },
  failedToUpdateDefault: {
    id: 'extensionOperations.failedToUpdateDefault',
    defaultMessage: 'Failed to update extension default',
  },
  addedAsDefault: {
    id: 'extensionOperations.addedAsDefault',
    defaultMessage: 'Extension added as default',
  },
  failedToAdd: {
    id: 'extensionOperations.failedToAdd',
    defaultMessage: 'Failed to add extension',
  },
  adding: {
    id: 'extensionOperations.adding',
    defaultMessage: 'Adding {name} extension…',
  },
  added: {
    id: 'extensionOperations.added',
    defaultMessage: 'Successfully added extension',
  },
  removing: {
    id: 'extensionOperations.removing',
    defaultMessage: 'Removing {name} extension…',
  },
  removed: {
    id: 'extensionOperations.removed',
    defaultMessage: 'Successfully removed extension',
  },
  failedToRemove: {
    id: 'extensionOperations.failedToRemove',
    defaultMessage: 'Failed to remove extension',
  },
});

export function getExtensionOperationMessages(intl: IntlShape): ExtensionOperationMessages {
  return {
    enabledInDefaults: intl.formatMessage(i18n.enabledInDefaults),
    removedFromDefaults: intl.formatMessage(i18n.removedFromDefaults),
    failedToUpdateDefault: intl.formatMessage(i18n.failedToUpdateDefault),
    addedAsDefault: intl.formatMessage(i18n.addedAsDefault),
    failedToAdd: intl.formatMessage(i18n.failedToAdd),
  };
}

export function getAgentExtensionMessages(intl: IntlShape): AgentExtensionMessages {
  return {
    adding: (name) => intl.formatMessage(i18n.adding, { name }),
    added: intl.formatMessage(i18n.added),
    failedToAdd: intl.formatMessage(i18n.failedToAdd),
    removing: (name) => intl.formatMessage(i18n.removing, { name }),
    removed: intl.formatMessage(i18n.removed),
    failedToRemove: intl.formatMessage(i18n.failedToRemove),
  };
}
