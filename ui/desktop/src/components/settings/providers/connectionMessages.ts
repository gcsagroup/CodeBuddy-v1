import { defineMessages } from '../../../i18n';

export const connectionMessages = defineMessages({
  invalidCredentials: {
    id: 'customProviderForm.invalidCredentials',
    defaultMessage: 'The API key was rejected. Check it and try again.',
  },
  apiKeyRequiredForConnection: {
    id: 'customProviderForm.apiKeyRequiredForConnection',
    defaultMessage: 'Enter the API key again, then test the connection.',
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
});
