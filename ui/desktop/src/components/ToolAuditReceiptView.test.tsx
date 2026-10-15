import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { ToolAuditReceipt } from '../acp/adapter/toolAudit';
import { ToolAuditReceiptView } from './ToolAuditReceiptView';

const receipt: ToolAuditReceipt = {
  schemaVersion: 1,
  auditId: '0198f083-3f9f-7e4a-bd71-b8ec3cab37be',
  actor: 'codepro_coder',
  effectiveModel: 'openai/gpt-5.6-codex',
  extensionSource: 'platform',
  toolName: 'developer::shell',
  permissionClass: 'workspace_write',
  authorization: 'user_confirmed',
  outcome: 'success',
  taskScoped: true,
  startedAt: '2026-08-04T09:20:30.100Z',
  completedAt: '2026-08-04T09:20:30.142Z',
  durationMs: 42,
};

describe('ToolAuditReceiptView', () => {
  it('shows a concise summary first and reveals safe technical fields on demand', () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolAuditReceiptView receipt={receipt} />
      </IntlProvider>
    );

    expect(
      screen.getByText('Safety check: Changes limited to this project · Tool call succeeded')
    ).toBeInTheDocument();
    expect(screen.queryByText('CodePro Coder')).not.toBeInTheDocument();
    expect(screen.queryByText('42 ms')).not.toBeInTheDocument();
    expect(screen.queryByText(receipt.auditId)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Technical audit details' }));

    expect(screen.getByText(receipt.auditId)).toBeInTheDocument();
    expect(screen.getByText('CodePro Coder')).toBeInTheDocument();
    expect(screen.getByText('Task')).toBeInTheDocument();
  });

  it('shows the structured failure reason instead of inferring from tool text', () => {
    const denied: ToolAuditReceipt = {
      ...receipt,
      schemaVersion: 2,
      authorization: 'policy_denied',
      outcome: 'policy_denied',
      failureKind: 'policy_denied',
    };
    render(
      <IntlProvider
        locale="zh-CN"
        messages={{ 'codeProPresentation.failure.policyDenied': '需要调整操作' }}
      >
        <ToolAuditReceiptView receipt={denied} />
      </IntlProvider>
    );

    expect(screen.getByText('需要调整操作')).toBeInTheDocument();
    expect(screen.queryByText('用户未授权')).not.toBeInTheDocument();
  });
});
