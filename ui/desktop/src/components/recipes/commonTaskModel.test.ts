import { describe, expect, it } from 'vitest';
import { buildCommonTaskCreationPrompt, buildCommonTaskModel } from './commonTaskModel';

describe('buildCommonTaskModel', () => {
  it('uses structured recipe fields and never guesses dependencies from prompt text', () => {
    const model = buildCommonTaskModel({
      id: 'release-check',
      file_path: 'D:\\recipes\\release.yaml',
      last_modified: '2026-09-04T01:00:00Z',
      recipe: {
        title: 'Release check',
        description: 'Validate a release candidate',
        prompt: 'Delete C:\\private and email the report',
        extensions: [{ type: 'stdio', name: 'filesystem', cmd: 'server', description: 'Files' }],
        settings: { goose_provider: 'openai', goose_model: 'gpt-5' },
        parameters: [
          {
            key: 'artifact',
            input_type: 'file',
            requirement: 'required',
            description: 'Release artifact',
          },
        ],
        sub_recipes: [{ name: 'sign', path: 'steps/sign.yaml' }],
      },
    } as never);

    expect(model).toMatchObject({
      id: 'release-check',
      purpose: 'Validate a release candidate',
      model: 'openai / gpt-5',
      extensions: ['filesystem'],
      knownFiles: ['artifact', 'steps/sign.yaml'],
    });
    expect(JSON.stringify(model)).not.toContain('C:\\private');
    expect(model.riskSummary).toEqual(['External tool access may require confirmation']);
  });

  it('creates an explicit review-first task intent from a natural-language description', () => {
    expect(buildCommonTaskCreationPrompt('  Check my weekly release  ')).toBe(
      [
        'Help me turn the following description into a reusable Common Task.',
        'Before saving it, confirm the purpose, model, tools, files, permissions, and run instructions with me.',
        '',
        'Check my weekly release',
      ].join('\n')
    );
    expect(buildCommonTaskCreationPrompt('   ')).toBeNull();
  });

  it('projects last execution data only from the matching usage record', () => {
    const model = buildCommonTaskModel(
      {
        id: 'release-check',
        file_path: 'D:\\recipes\\release.yaml',
        last_modified: '2026-09-04T01:00:00Z',
        recipe: { title: 'Release check', description: 'Validate a release candidate' },
      } as never,
      {
        kind: 'common_task',
        capabilityId: 'release-check',
        lastSuccessAt: '2026-09-04T08:00:00Z',
        successCount: 2,
        recentResult: 'session started',
      }
    );

    expect(model.lastRunAt).toBe('2026-09-04T08:00:00Z');
    expect(model.recentResult).toBe('session started');
  });
});
