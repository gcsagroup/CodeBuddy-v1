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

const formatTokenCount = (count: number): string => {
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return count.toString();
};

const getProgressColor = (percentage: number): string => {
  if (percentage <= 75) return 'text-text-primary/70';
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
      ? chinese ? '容量待查询' : 'Capacity pending'
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
            ? chinese ? '容量：CodeBuddy 模型目录，部署可设置更低上限' : 'Capacity: CodeBuddy catalog; deployment may use a lower limit'
            : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const percentage = totalTokens === undefined || !tokenLimit ? 0 : Math.round((totalTokens / tokenLimit) * 100);
  const colorClass = getProgressColor(percentage);

  return (
    <div className="flex items-center h-full">
      <BottomMenuAlertPopover alerts={alerts}>
        <span className={`text-xs font-mono ${colorClass}`} title={title} aria-label={title}>
          {estimated && totalTokens !== undefined ? '≈' : ''}
          {totalTokens === undefined
            ? chinese
              ? '未知'
              : 'Unknown'
            : formatTokenCount(totalTokens)}{' '}
          / {tokenLimit ? formatTokenCount(tokenLimit) : (chinese ? '未知' : 'Unknown')}
          {capacitySource === 'fallback' ? '?' : ''}
        </span>
      </BottomMenuAlertPopover>
    </div>
  );
}
