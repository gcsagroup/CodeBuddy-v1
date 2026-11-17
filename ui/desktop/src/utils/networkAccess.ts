import { currentLocale } from '../i18n';
import { selectNativeText } from './nativeLocalization';

export class NetworkAccessCancelled extends Error {}

export async function requireNetworkAccess(): Promise<void> {
  if (!await window.electron.requestNetworkAccess()) {
    throw new NetworkAccessCancelled(selectNativeText(currentLocale, 'Network access was cancelled.', '已取消联网操作。', '已取消連網操作。'));
  }
}
