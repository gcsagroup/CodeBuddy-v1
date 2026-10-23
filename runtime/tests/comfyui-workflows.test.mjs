import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approvedWorkflow, workflowMetadata, IMAGE_WORKFLOWS, VIDEO_WORKFLOWS } from '../comfyui-workflows.mjs';

test('all six exports retain every node, model, sampler and connection; only approved scalar slots change', () => {
  const cases = [
    ['qwen_image', 'image', undefined, []], ['qwen_edit', 'image', undefined, ['a.png', 'b.png']],
    ['minimax_text', 'video', 'text_to_video', []], ['minimax_text_detail', 'video', 'text_to_video', []],
    ['minimax_image', 'video', 'image_to_video', ['a.png']], ['minimax_reference', 'video', 'reference_to_video', ['a.png', 'b.png']],
  ];
  assert.equal(IMAGE_WORKFLOWS.length + VIDEO_WORKFLOWS.length, 6);
  for (const [workflow_id, kind, mode, refs] of cases) {
    const input = { workflow_id, mode, prompt: 'User requested subject', seed: 42 };
    const metadata = workflowMetadata(input, kind, refs.length);
    const original = JSON.parse(readFileSync(new URL(`../assets/comfyui/${encodeURIComponent(metadata.source)}`, import.meta.url), 'utf8'));
    const graph = approvedWorkflow(input, refs, 'test-job', kind);
    assert.deepEqual(Object.keys(graph), Object.keys(original));
    const changed = [];
    for (const [id, node] of Object.entries(graph)) {
      assert.equal(node.class_type, original[id].class_type);
      for (const [key, value] of Object.entries(node.inputs)) {
        const old = original[id].inputs[key];
        if (Array.isArray(old)) assert.deepEqual(value, old, `connection ${workflow_id}/${id}/${key}`);
        if (JSON.stringify(value) !== JSON.stringify(old)) changed.push([key, value]);
      }
    }
    assert.ok(changed.some(([,value]) => value === input.prompt));
    assert.ok(changed.every(([key,value]) => ['prompt','seed','noise_seed','filename_prefix','image'].includes(key) || (key === 'value' && value === input.prompt)));
    assert.equal(metadata.sha256.length, 64);
    graph[metadata.save_node].inputs.filename_prefix = 'mutated';
    assert.equal(approvedWorkflow(input, refs, 'another-job', kind)[metadata.save_node].inputs.filename_prefix, 'CodeBuddy/another-job');
  }
});

test('mismatched templates and Agent-authored graphs are rejected before submission', () => {
  for (const key of ['workflow', 'workflow_json', 'nodes', 'model', 'steps'])
    assert.throws(() => approvedWorkflow({ prompt: 'x', [key]: {} }, [], 'id', 'image'), /Unsupported parameter/);
  assert.throws(() => approvedWorkflow({ prompt: 'x', workflow_id: '../arbitrary.json' }, [], 'id', 'image'), /approved workflow/);
  assert.throws(() => approvedWorkflow({ prompt: 'x', workflow_id: 'qwen_image' }, ['a.png'], 'id', 'image'), /matching/);
  const graph = approvedWorkflow({ prompt: 'Keep the original subject', workflow_id: 'qwen_edit' }, ['real-reference.png'], 'id', 'image');
  assert.equal(graph['470'].inputs.image, 'real-reference.png');
  assert.equal(graph['475'].inputs.image, 'real-reference.png');
});
