import { describe, expect, it } from 'vitest';
import type {
  GitHubWorkflowDispatchCatalogResponse,
  GitHubWorkflowDispatchPreviewResponse,
} from '../../acp/githubCi';
import {
  dispatchInputValues,
  dispatchRequiredInputsPresent,
  githubDispatchErrorCode,
  validWorkflowDispatchPreview,
  validWorkflowDispatchReceipt,
} from './githubWorkflowDispatch';

const workflow = {
  id: 42,
  name: 'Release',
  path: '.github/workflows/release.yml',
  inputs: [
    {
      name: 'channel',
      description: 'Release channel',
      inputType: 'choice' as const,
      required: true,
      options: ['beta', 'stable'],
    },
    {
      name: 'dry_run',
      description: 'Do not publish',
      inputType: 'boolean' as const,
      required: false,
      defaultValue: 'false',
      options: [],
    },
  ],
};

const catalog: GitHubWorkflowDispatchCatalogResponse = {
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  defaultBranch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: false,
  workflows: [workflow],
};

const preview: GitHubWorkflowDispatchPreviewResponse = {
  preflightId: 'a'.repeat(64),
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  defaultBranch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: false,
  workflow,
  inputSummary: [
    { name: 'channel', inputType: 'choice', source: 'provided' },
    { name: 'dry_run', inputType: 'boolean', source: 'default' },
  ],
};

describe('GitHub workflow dispatch model', () => {
  it('builds only explicit values in schema order and validates required inputs', () => {
    expect(dispatchRequiredInputsPresent(workflow, { channel: '' })).toBe(false);
    expect(dispatchRequiredInputsPresent(workflow, { channel: 'beta' })).toBe(true);
    expect(
      dispatchInputValues(workflow, { dry_run: '', channel: 'beta', unknown: 'secret' })
    ).toEqual([{ name: 'channel', value: 'beta' }]);
  });

  it('accepts only a preview bound to the catalog, schema, and value sources', () => {
    expect(validWorkflowDispatchPreview(catalog, workflow, { channel: 'beta' }, preview)).toBe(
      true
    );
    expect(validWorkflowDispatchPreview(catalog, workflow, { channel: 'stable' }, preview)).toBe(
      true
    );
    expect(
      validWorkflowDispatchPreview(
        catalog,
        workflow,
        {},
        {
          ...preview,
          inputSummary: preview.inputSummary.map((input) => ({ ...input, source: 'omitted' })),
        }
      )
    ).toBe(false);
    expect(
      validWorkflowDispatchPreview(
        catalog,
        workflow,
        { channel: 'beta' },
        {
          ...preview,
          headSha: '2'.repeat(40),
        }
      )
    ).toBe(false);
  });

  it('validates an exact GitHub run receipt without accepting forged URLs', () => {
    const receipt = {
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      defaultBranch: 'main',
      headSha: '1'.repeat(40),
      workflowId: 42,
      workflowName: 'Release',
      workflowPath: '.github/workflows/release.yml',
      runId: 9001,
      runUrl: 'https://github.com/octo/demo/actions/runs/9001',
      auditId: 'audit-1',
      acceptedAt: '2026-08-05T01:00:00Z',
    };
    expect(validWorkflowDispatchReceipt(preview, receipt)).toBe(true);
    expect(
      validWorkflowDispatchReceipt(preview, {
        ...receipt,
        runUrl: 'https://attacker.invalid/octo/demo/actions/runs/9001',
      })
    ).toBe(false);
  });

  it('reads only a stable ACP error code and never formats arbitrary error messages', () => {
    expect(githubDispatchErrorCode({ data: { code: 'outcome_uncertain' } })).toBe(
      'outcome_uncertain'
    );
    expect(githubDispatchErrorCode(new Error('beta secret'))).toBeUndefined();
  });
});
