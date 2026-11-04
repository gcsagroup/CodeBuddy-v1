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
  const [outputValue, setOutputValue] = useState('');
  const [outputStatus, setOutputStatus] = useState('');
  const [outputCapacity, setOutputCapacity] = useState<number | null>(null);
  const [outputReady, setOutputReady] = useState(false);
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
    setOutputReady(false);
    setOutputValue('');
    setOutputStatus('');
    setOutputCapacity(null);
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
        const output = fields.find((f) => f.key === `maxTokens:${active.model}`);
        if (output?.value) {
          const budget = JSON.parse(output.value) as {
            configured: number | null;
            capacityTokens: number | null;
            capacitySource: string;
            defaultTokens: number;
          };
          setOutputValue(budget.configured === null ? '' : String(budget.configured));
          setOutputCapacity(budget.capacityTokens);
          setOutputStatus(
            budget.capacityTokens === null
              ? zh
                ? `默认请求额度 ${budget.defaultTokens.toLocaleString()} tokens；服务输出容量未确认`
                : `${budget.defaultTokens.toLocaleString()} tokens default; output capacity unavailable`
              : zh
                ? `已知输出容量 ${budget.capacityTokens.toLocaleString()} tokens（${budget.capacitySource === 'service' ? '服务端' : '模型目录'}）`
                : `${budget.capacityTokens.toLocaleString()} tokens output capacity (${budget.capacitySource})`
          );
          setOutputReady(true);
        }
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
  const saveOutput = async () => {
    if (!active || !outputReady) return;
    const number = Number(outputValue);
    if (
      outputValue.trim() &&
      (!Number.isSafeInteger(number) ||
        number < 1 ||
        (outputCapacity !== null && number > outputCapacity))
    ) {
      setOutputStatus(
        zh
          ? '请输入不超过已知输出容量的正整数'
          : 'Enter a positive integer within the known output capacity'
      );
      return;
    }
    setBusy(true);
    try {
      const key = `maxTokens:${active.model}`;
      await acpSaveProviderConfig(
        active.provider,
        outputValue.trim() ? [{ key, value: String(number) }] : [],
        outputValue.trim() ? [] : [key]
      );
      setOutputStatus(
        zh
          ? '输出额度已保存，下次发送时生效；模型和思考强度保持不变'
          : 'Output budget saved for the next prompt; model and thinking effort are unchanged'
      );
    } catch (error) {
      setOutputStatus(String(error));
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
      <div className="space-y-3 border-t pt-3">
        <h4 className="font-medium">{zh ? '单次输出额度' : 'Single-response output budget'}</h4>
        <p className="text-sm text-text-muted">
          {zh
            ? '限制一次模型调用的输出，部分模型的思考也计入其中。留空使用自动值，最终额度还受剩余上下文空间影响。'
            : 'Limits one model response, including reasoning on some models. Leave blank for automatic defaults; the remaining context may further limit the response.'}
        </p>
        <Input
          aria-label={zh ? '单次输出额度 tokens' : 'Output budget tokens'}
          type="number"
          min={1}
          max={outputCapacity ?? undefined}
          step={1}
          value={outputValue}
          disabled={!outputReady || busy}
          onChange={(e) => setOutputValue(e.target.value)}
          placeholder={zh ? '自动' : 'Automatic'}
        />
        <Button disabled={busy || !outputReady} onClick={() => void saveOutput()}>
          {zh ? '保存输出额度' : 'Save output budget'}
        </Button>
        <p role="status" className="text-sm text-text-muted">
          {outputStatus}
        </p>
      </div>
    </section>
  );
}
