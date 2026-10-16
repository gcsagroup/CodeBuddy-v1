import { useEffect, useMemo, useState } from 'react';
import type { ProviderDetails } from '../../../types/providers';
import { acpReadProviderConfig, acpSaveProviderConfig } from '../../../acp/providers';
import { useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';

export default function ModelContextSettings({ providers }: { providers: ProviderDetails[] }) {
  const { locale } = useIntl();
  const zh = locale.startsWith('zh');
  const [selection, setSelection] = useState('');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const choices = useMemo(
    () =>
      providers.flatMap((p) =>
        p.metadata.known_models.map((m) => ({
          key: JSON.stringify([p.name, m.name]),
          provider: p.name,
          model: m.name,
          label: `${p.metadata.display_name} / ${m.name}`,
        }))
      ),
    [providers]
  );
  const active = choices.find((c) => c.key === selection);
  useEffect(() => {
    if (!choices.some((c) => c.key === selection)) setSelection(choices[0]?.key ?? '');
  }, [choices, selection]);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setValue('');
    setStatus('');
    if (!active) return;
    void acpReadProviderConfig(active.provider)
      .then((fields) => {
        if (cancelled) return;
        const field = fields.find((f) => f.key === `contextWindow:${active.model}`);
        if (!field?.value) return;
        const current = JSON.parse(field.value) as {
          configured: number | null;
          contextWindow: number;
          contextSource: string;
        };
        setValue(current.configured == null ? '' : String(current.configured));
        setStatus(
          `${current.contextWindow.toLocaleString()} tokens · ${current.contextSource === 'fallback' ? (zh ? 'CodeBuddy 默认预算，容量未确认' : 'CodeBuddy default budget; capacity unconfirmed') : current.contextSource === 'service' ? (zh ? '服务端容量' : 'Service capacity') : current.contextSource === 'catalog' ? (zh ? 'CodeBuddy 模型目录' : 'CodeBuddy model catalog') : zh ? '手动配置' : 'Configured'}`
        );
        setReady(true);
      })
      .catch((error) => {
        if (!cancelled) setStatus(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [active, zh]);
  const save = async () => {
    if (!active || !ready) return;
    const number = Number(value);
    if (value.trim() && (!Number.isSafeInteger(number) || number < 8192 || number > 10_000_000)) {
      setStatus(
        zh ? '请输入 8192–10000000 之间的整数' : 'Enter an integer between 8192 and 10000000'
      );
      return;
    }
    setBusy(true);
    try {
      const key = `contextWindow:${active.model}`;
      await acpSaveProviderConfig(
        active.provider,
        value.trim() ? [{ key, value: String(number) }] : [],
        value.trim() ? [] : [key]
      );
      setStatus(
        zh
          ? '已保存，下次发送时生效；不会超过服务已声明的容量'
          : 'Saved for the next prompt; capped by service-reported capacity'
      );
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!choices.length) return null;
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">{zh ? '模型上下文容量' : 'Model context capacity'}</h3>
      <p className="text-sm text-text-muted">
        {zh
          ? '优先读取服务容量。缺少信息时可填写部署的实际上限；留空恢复自动识别。CodeBuddy 按此预算检查压缩。'
          : 'Uses service capacity. Enter the deployment limit when metadata is missing; leave blank for automatic discovery. CodeBuddy checks compaction against this budget.'}
      </p>
      <select
        aria-label={zh ? '上下文容量模型' : 'Context capacity model'}
        value={selection}
        disabled={busy}
        onChange={(e) => setSelection(e.target.value)}
        className="w-full rounded border bg-background-default p-2"
      >
        {choices.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <Input
        aria-label={zh ? '上下文容量 tokens' : 'Context capacity tokens'}
        type="number"
        min={8192}
        max={10000000}
        step={1}
        value={value}
        disabled={!ready || busy}
        onChange={(e) => setValue(e.target.value)}
        placeholder={zh ? '自动识别' : 'Automatic'}
      />
      <Button disabled={busy || !ready} onClick={() => void save()}>
        {zh ? '保存容量' : 'Save capacity'}
      </Button>
      <p role="status" className="text-sm text-text-muted">
        {status}
      </p>
    </section>
  );
}
