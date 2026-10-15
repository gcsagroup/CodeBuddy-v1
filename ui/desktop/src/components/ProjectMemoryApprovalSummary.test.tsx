import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import ProjectMemoryApprovalSummary, {
  filterProjectMemoryApprovalActions,
  parseProjectMemoryApproval,
} from './ProjectMemoryApprovalSummary';

const validArguments = {
  kind: 'preference',
  subject: '  response.style  ',
  content: '  Keep answers compact.\nPreserve examples.  ',
  confidence: 'high',
  reason: '  The user asked for this working style.  ',
};

describe('ProjectMemoryApprovalSummary', () => {
  it('shows the exact submitted values and backend defaults for a platform memory request', () => {
    const result = parseProjectMemoryApproval(
      'project_memory_remember',
      'platform',
      validArguments
    );
    render(<ProjectMemoryApprovalSummary result={result} />, { wrapper: IntlTestWrapper });

    expect(screen.getByText('Review memory before saving')).toBeInTheDocument();
    expect(screen.getByText('Project memory save request')).toBeInTheDocument();
    for (const value of [validArguments.subject, validArguments.content, validArguments.reason]) {
      expect(
        screen.getByText(
          (_content, element) => element?.tagName === 'PRE' && element.textContent === value
        )
      ).toBeInTheDocument();
    }
    expect(screen.getByText('Not marked (untrusted)')).toBeInTheDocument();
    expect(screen.getAllByText('project').length).toBeGreaterThan(0);
    expect(screen.getAllByText('None')).toHaveLength(2);
  });

  it('labels an unconfirmed user preference as a candidate rather than an explicit save', () => {
    const result = parseProjectMemoryApproval('project_memory_remember', 'platform', {
      ...validArguments,
      scope: 'user',
    });
    render(<ProjectMemoryApprovalSummary result={result} />, { wrapper: IntlTestWrapper });

    expect(screen.getByText('Inferred user-preference candidate request')).toBeInTheDocument();
    expect(screen.queryByText(/Explicit user-preference request/)).not.toBeInTheDocument();
  });

  it('treats user_confirmed only as an untrusted submitted marker', () => {
    const result = parseProjectMemoryApproval('project_memory_remember', 'platform', {
      ...validArguments,
      scope: 'user',
      user_confirmed: true,
    });
    render(<ProjectMemoryApprovalSummary result={result} />, { wrapper: IntlTestWrapper });

    expect(screen.getByText(/saving still requires host approval/i)).toBeInTheDocument();
    expect(screen.getByText('Marked true (untrusted)')).toBeInTheDocument();
  });

  it.each([
    [{ ...validArguments, source: 'user_explicit' }],
    [{ ...validArguments, scope: 'account' }],
    [{ ...validArguments, ttl_days: 0 }],
    [{ ...validArguments, ttl_days: 3651 }],
    [{ ...validArguments, ttl_days: 1.5 }],
    [{ ...validArguments, user_confirmed: 'true' }],
    [{ ...validArguments, content: '   ' }],
    [{ ...validArguments, subject: 'Uppercase' }],
    [{ ...validArguments, subject: `a${'b'.repeat(120)}` }],
    [{ ...validArguments, content: 'x'.repeat(2001) }],
    [{ ...validArguments, reason: 'x'.repeat(501) }],
    [{ ...validArguments, scope: 'user', kind: 'project_rule' }],
    [{ ...validArguments, source_ref: 'evidence.txt' }],
    [{ ...validArguments, kind: 'verified_fact' }],
    [{ ...validArguments, kind: 'verified_fact', source_ref: '..\\secret.txt' }],
    [{ ...validArguments, kind: 'verified_fact', source_ref: 'C:\\secret.txt' }],
    [{ ...validArguments, kind: 'verified_fact', source_ref: 'x'.repeat(1025) }],
  ])('rejects malformed platform memory arguments %#', (argumentsValue) => {
    const result = parseProjectMemoryApproval(
      'project_memory_remember',
      'platform',
      argumentsValue
    );
    expect(result.kind).toBe('invalid');
    expect(
      filterProjectMemoryApprovalActions(result, [
        'allow_once',
        'always_allow',
        'deny_once',
        'always_deny',
      ])
    ).toEqual(['deny_once', 'always_deny']);
  });

  it('does not inspect an external tool that reuses the platform tool name', () => {
    const result = parseProjectMemoryApproval(
      'project_memory_remember',
      'external_stdio',
      validArguments
    );
    expect(result).toEqual({ kind: 'not_applicable' });
    expect(filterProjectMemoryApprovalActions(result, ['allow_once', 'deny_once'])).toEqual([
      'allow_once',
      'deny_once',
    ]);
  });
});
