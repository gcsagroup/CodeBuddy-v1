import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConfiguredExtensions,
  setConfigExtensionEnabled,
  type ConfiguredExtensionEntry,
} from '../../../acp/extensions';
import { useIntl } from '../../../i18n';
import { selectNativeText } from '../../../utils/nativeLocalization';
import { Button } from '../../ui/button';
import GitHubConnections from './GitHubConnections';

export default function RepositoryConnections() {
  const { locale } = useIntl();
  const t = (en: string, cn: string, tw: string) => selectNativeText(locale, en, cn, tw);
  const [local, setLocal] = useState<ConfiguredExtensionEntry | null>();
  const [github, setGithub] = useState<ConfiguredExtensionEntry>();
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [githubBusy, setGithubBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setFailed(false);
    try {
      const result = await getConfiguredExtensions();
      if (current !== generation.current) return;
      setLocal(
        result.extensions.find((e) => e.type === 'stdio' && e.name === 'local_git') ??
          result.extensions.find(
            (e) => (e.type === 'builtin' || e.type === 'platform') && e.name === 'git'
          ) ??
          null
      );
      setGithub(
        result.extensions.find(
          (e) =>
            e.type === 'streamable_http' &&
            e.name === 'github_official' &&
            e.uri === 'https://api.githubcopilot.com/mcp/'
        )
      );
    } catch {
      if (current === generation.current) setFailed(true);
    }
  }, []);
  useEffect(() => {
    const requests = generation;
    void load();
    return () => {
      requests.current++;
    };
  }, [load]);
  const toggle = async (entry: ConfiguredExtensionEntry) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await setConfigExtensionEnabled(entry.configKey ?? entry.name, !entry.enabled);
      await load();
      if (entry === github) setConnectionVersion((version) => version + 1);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <section
        aria-label={t('Local Git', '本地 Git', '本機 Git')}
        className="space-y-2 border-b border-border-secondary pb-4 text-sm"
      >
        <h3 className="font-medium">{t('Local Git', '本地 Git', '本機 Git')}</h3>
        <p role="status">
          {failed
            ? t(
                'Local Git status could not be checked.',
                '本地 Git 状态检查未完成。',
                '本機 Git 狀態檢查未完成。'
              )
            : local === undefined
              ? t('Checking…', '检查中…', '檢查中…')
              : local === null
                ? t('Local Git is not configured.', '本地 Git 未配置。', '本機 Git 未設定。')
                : local.enabled
                  ? t('Local Git is enabled.', '本地 Git 已启用。', '本機 Git 已啟用。')
                  : t('Local Git is disabled.', '本地 Git 已停用。', '本機 Git 已停用。')}
        </p>
        <p className="text-xs text-text-secondary">
          {t(
            'Inspect changes, commit, manage branches, pull and push from chat. Remote operations still require repository access. This setting applies to new tasks.',
            '可在聊天中查看改动、提交、管理分支、拉取和推送。远端操作仍需仓库访问权限；此开关控制新任务的默认启用状态。',
            '可在聊天中查看變更、提交、管理分支、拉取與推送。遠端操作仍需儲存庫存取權限；此開關控制新任務的預設啟用狀態。'
          )}
        </p>
        {local && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || failed}
            onClick={() => void toggle(local)}
          >
            {local.enabled
              ? t('Disable local Git', '停用本地 Git', '停用本機 Git')
              : t('Enable local Git', '启用本地 Git', '啟用本機 Git')}
          </Button>
        )}
        {failed && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
            {t('Check again', '重新检查', '重新檢查')}
          </Button>
        )}
      </section>
      <section aria-label="GitHub">
        <h3 className="text-sm font-medium">GitHub</h3>
        <p className="mt-1 text-xs text-text-secondary">
          {t(
            'Pull requests, issues and Actions. Local Git remains independent of this connection.',
            '管理 PR、Issue 和 Actions。GitHub 连接异常不影响本地 Git。',
            '管理 PR、Issue 與 Actions。GitHub 連線異常不影響本機 Git。'
          )}
        </p>
        <GitHubConnections
          key={connectionVersion}
          allowLogin
          onConnected={load}
          onBusyChange={setGithubBusy}
        />
        {github && (
          <div className="space-y-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || failed || githubBusy}
              onClick={() => void toggle(github)}
            >
              {github.enabled
                ? t('Disable GitHub for new tasks', '对新任务停用 GitHub', '對新任務停用 GitHub')
                : t('Enable GitHub for new tasks', '对新任务启用 GitHub', '對新任務啟用 GitHub')}
            </Button>
            <p className="text-xs text-text-secondary">
              {t(
                'Existing chats keep their tool selection. Manage those tools in each chat.',
                '已有聊天保留各自的工具选择，可在聊天内调整。',
                '既有聊天保留各自的工具選擇，可在聊天內調整。'
              )}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
