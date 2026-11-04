import BottomMenuAlertPopover from './BottomMenuAlertPopover';
import { Alert } from '../alerts';
import { useIntl } from '../../i18n';

interface ContextWindowIndicatorProps {
  totalTokens?: number;
  tokenLimit: number;
  alerts: Alert[];
  usageSource?: 'provider_actual' | 'local_estimate' | 'streaming_estimate';
  capacitySource?: 'service' | 'catalog' | 'configured' | 'fallback';
}

const getProgressColor = (percentage: number): string => {
  if (percentage <= 75) return 'text-text-primary/70 group-hover/context-usage:text-text-primary';
  if (percentage <= 90) return 'text-orange-500';
  return 'text-red-500';
};

export function ContextWindowIndicator({
  totalTokens,
  tokenLimit,
  alerts,
  usageSource,
  capacitySource,
}: ContextWindowIndicatorProps) {
  const { locale } = useIntl();
  const chinese = locale.startsWith('zh');
  const estimated = usageSource === 'local_estimate' || usageSource === 'streaming_estimate';
  const title = [
    usageSource === 'streaming_estimate'
      ? chinese
        ? '生成中实时估算；在步骤边界检查自动压缩'
        : 'Live generation estimate; auto-compaction is checked between steps'
      : estimated
        ? chinese
          ? 'CodeBuddy 保守估算，非计费量'
          : 'CodeBuddy conservative estimate, not billed usage'
        : chinese
          ? '上下文用量'
          : 'Context usage',
    !tokenLimit
      ? chinese
        ? '容量待查询'
        : 'Capacity pending'
      : capacitySource === 'fallback'
        ? chinese
          ? '容量未确认，使用默认预算；可在模型设置中配置'
          : 'Capacity unconfirmed; default budget. Configure it in model settings'
        : capacitySource === 'configured'
          ? chinese
            ? '容量：手动配置'
            : 'Capacity: configured'
          : capacitySource === 'service'
            ? chinese
              ? '容量：模型服务返回'
              : 'Capacity: reported by service'
            : capacitySource === 'catalog'
              ? chinese
                ? '容量：CodeBuddy 模型目录，部署可设置更低上限'
                : 'Capacity: CodeBuddy catalog; deployment may use a lower limit'
              : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const usageKnown = totalTokens !== undefined && Number.isFinite(totalTokens) && totalTokens >= 0;
  const capacityKnown = Number.isFinite(tokenLimit) && tokenLimit > 0;
  const percentage =
    usageKnown && capacityKnown ? Math.round((totalTokens / tokenLimit) * 100) : undefined;
  const fill = Math.min(100, Math.max(0, percentage ?? 0));
  const unknown = chinese ? '未知' : 'Unknown';
  const counts = `${usageKnown ? Math.round(totalTokens).toLocaleString(locale) : unknown} / ${capacityKnown ? Math.round(tokenLimit).toLocaleString(locale) : unknown}`;
  const formatK = (value: number) =>
    `${(value / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })}k`;
  const compactCounts = `${usageKnown ? formatK(totalTokens) : unknown} / ${capacityKnown ? formatK(tokenLimit) : unknown}`;
  const label = `${chinese ? '上下文用量' : 'Context usage'}: ${counts}${percentage === undefined ? '' : ` (${percentage}%)`}`;
  const colorClass = getProgressColor(percentage ?? 0);

  return (
    <div className="flex shrink-0 items-center" data-testid="context-window-indicator">
      <BottomMenuAlertPopover
        alerts={alerts}
        triggerLabel={label}
        triggerDescription={title}
        showIndicator={false}
        triggerClassName="size-8 justify-center rounded-full p-0 hover:bg-background-secondary focus-visible:outline focus-visible:outline-2"
        preview={
          <>
            {percentage !== undefined && (
              <p className="mb-1 tabular-nums">
                {chinese ? `已用 ${percentage}%` : `${percentage}% used`}
              </p>
            )}
            <p className="font-medium tabular-nums">{compactCounts}</p>
          </>
        }
      >
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" className={colorClass}>
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="opacity-20"
          />
          {percentage === undefined ? (
            <circle
              cx="10"
              cy="10"
              r="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="2 4"
              className="opacity-40"
            />
          ) : (
            <circle
              cx="10"
              cy="10"
              r="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              pathLength="100"
              strokeDasharray={`${fill} 100`}
              transform="rotate(-90 10 10)"
              className="transition-[stroke-dasharray] duration-150 motion-reduce:transition-none"
            />
          )}
        </svg>
      </BottomMenuAlertPopover>
    </div>
  );
}
