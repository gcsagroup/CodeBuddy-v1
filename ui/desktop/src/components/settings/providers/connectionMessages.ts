import { defineMessages } from '../../../i18n';
import { selectNativeText } from '../../../utils/nativeLocalization';

export function connectionNetworkReason(code: unknown, locale: string): string | undefined {
  const descriptions: Record<string, [string, string, string]> = {
    ECONNREFUSED: ['The service port refused the connection.', '服务端口拒绝连接，请确认服务已启动。', '服務連接埠拒絕連線，請確認服務已啟動。'],
    ENOTFOUND: ['The service hostname could not be resolved.', '无法解析服务主机名，请检查地址。', '無法解析服務主機名稱，請檢查位址。'],
    ETIMEDOUT: ['The connection timed out.', '连接超时，请检查网络和服务状态。', '連線逾時，請檢查網路和服務狀態。'],
    UND_ERR_CONNECT_TIMEOUT: ['The connection timed out.', '连接超时，请检查网络和服务状态。', '連線逾時，請檢查網路和服務狀態。'],
    EHOSTUNREACH: ['The service network is unreachable.', '无法访问服务所在网络，请检查局域网或 VPN。', '無法存取服務所在網路，請檢查區域網路或 VPN。'],
    ENETUNREACH: ['The service network is unreachable.', '无法访问服务所在网络，请检查局域网或 VPN。', '無法存取服務所在網路，請檢查區域網路或 VPN。'],
    CERT_HAS_EXPIRED: ['The service certificate has expired.', '服务证书已过期，请更新证书。', '服務憑證已過期，請更新憑證。'],
    DEPTH_ZERO_SELF_SIGNED_CERT: ['The service certificate is not trusted.', '服务证书不受信任，请检查证书配置。', '服務憑證不受信任，請檢查憑證設定。'],
  };
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(descriptions, code)
    ? `${selectNativeText(locale, ...descriptions[code])} (${code})` : undefined;
}

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
