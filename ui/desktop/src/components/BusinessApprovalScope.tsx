import type { IntlShape } from 'react-intl';
import type { BusinessApproval } from '../types/businessApproval';
import { defineMessages, useIntl } from '../i18n';
import { formatToolAction } from './toolActionPresentation';

const i18n = defineMessages({
  computer: { id: 'businessApproval.computer', defaultMessage: 'computer use' },
  image: { id: 'businessApproval.image', defaultMessage: 'image generation' },
  video: { id: 'businessApproval.video', defaultMessage: 'video generation' },
  computerScope: {
    id: 'businessApproval.computerScope',
    defaultMessage:
      'Read desktop windows and screenshots, and use the mouse and keyboard. This covers the current desktop, rather than a single application or read-only access.',
  },
  mediaScope: {
    id: 'businessApproval.mediaScope',
    defaultMessage:
      'Inspect service workflows, upload PNG references from this workspace, generate, check status, cancel individual jobs, and save results. Session permission includes later generations and changed parameters.',
  },
  service: { id: 'businessApproval.service', defaultMessage: 'Service' },
  workspace: { id: 'businessApproval.workspace', defaultMessage: 'Workspace' },
  output: { id: 'businessApproval.output', defaultMessage: 'Output folder' },
  operations: { id: 'businessApproval.operations', defaultMessage: 'Included operations' },
  lifetime: {
    id: 'businessApproval.lifetime',
    defaultMessage:
      'Only this capability in this conversation. A tool reconnection, service/workspace change, or app restart requires permission again. Existing safety checks, disabled tools and per-call confirmation rules still apply.',
  },
});

export function businessApprovalName(intl: IntlShape, approval: BusinessApproval): string {
  if (!['computer-use', 'image-generation', 'video-generation'].includes(approval.id))
    return approval.name ?? approval.id;
  return intl.formatMessage(
    approval.id === 'computer-use'
      ? i18n.computer
      : approval.id === 'image-generation'
        ? i18n.image
        : i18n.video
  );
}

export default function BusinessApprovalScope({ approval }: { approval: BusinessApproval }) {
  const intl = useIntl();
  return (
    <section
      className="mt-3 space-y-2 text-sm text-text-secondary"
      data-testid="business-approval-scope"
    >
      <p>
        {approval.version === 2 ? approval.description :
          intl.formatMessage(approval.id === 'computer-use' ? i18n.computerScope : i18n.mediaScope)}
      </p>
      {approval.details && (
        <dl className="space-y-1 break-all">
          {approval.details.map((item, index) => (
            <div key={`${index}:${item.label}`}>
              <dt className="font-medium">{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {approval.service && (
        <dl className="space-y-1 break-all">
          {(
            [
              [i18n.service, approval.service],
              [i18n.workspace, approval.workspace],
              [i18n.output, approval.outputDirectory],
            ] as const
          ).map(([label, value]) => (
            <div key={label.id}>
              <dt className="font-medium">{intl.formatMessage(label)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {approval.tools && (
        <details>
          <summary className="cursor-pointer">{intl.formatMessage(i18n.operations)}</summary>
          <ul className="mt-1 space-y-1">
            {approval.tools.map((tool) => (
              <li key={tool}>
                {approval.version === 2 ? tool :
                  formatToolAction(intl, `mcp__qwen_computer__${tool}`, {}, undefined, 'name')}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs">{intl.formatMessage(i18n.lifetime)}</p>
    </section>
  );
}
