import test from 'node:test';
import assert from 'node:assert/strict';
import { Compat } from '../compat.mjs';
import { registerToolSessionApproval, toolSessionApprovalScope, sameToolSessionScope, businessPresentationForClient } from '../tool-session-approval.mjs';

test('factory descriptors snapshot the declared range; editing a range invalidates reusable identity', () => {
  const business = { version: 2, id: 'export', name: 'Export reports', description: 'Only the reviewed workspace',
    tools: ['export_report'], details: [{ label: 'Workspace', value: 'A' }] };
  const make = value => registerToolSessionApproval({ name: 'export_report', execute() {} }, { key: 'export:A', business: value });
  const first = toolSessionApprovalScope(make(business));
  business.tools.push('delete_report'); business.details[0].value = 'B';
  assert.deepEqual(first.business.tools, ['export_report']);
  assert.equal(first.business.details[0].value, 'A');
  assert.equal(sameToolSessionScope(first, toolSessionApprovalScope(make(business))), false);
  assert.equal(sameToolSessionScope(first, toolSessionApprovalScope(make({ ...business, tools: ['export_report'], details: [{ label: 'Workspace', value: 'A' }] }))), true);
});

test('new groups need complete descriptors and only compatible clients receive the group option', () => {
  for (const business of [{ id: 'new-group' }, { version: 2, id: 'new-group', name: 'New group' },
    { version: 3, id: 'computer-use' }, { version: 2, id: 'new-group', name: 'New group', description: 'Scope', tools: 'abc' }, { version: 2, id: 'new-group', name: 'New group', description: 'Scope', tools: ['a', 'a'] }])
    assert.throws(() => registerToolSessionApproval({ name: 'fixture', execute() {} }, { key: 'fixture', business }), TypeError);
  const descriptor = { version: 2, id: 'new-group', name: 'New group', description: 'Scope' };
  assert.equal(businessPresentationForClient(descriptor, 1), undefined);
  assert.equal(businessPresentationForClient(descriptor, 2), descriptor);
  assert.equal(businessPresentationForClient({ ...descriptor, id: 'computer-use' }, 1), undefined);
  assert.equal(businessPresentationForClient(descriptor, undefined), undefined);
});


test('ACP initialization negotiates extensible scope display explicitly and clears an unsupported renegotiation', async () => {
  const unhandled = { handles: () => false };
  const host = Object.assign(Object.create(Compat.prototype), { connections: new Set(),
    workspaces: unhandled, transcription: unhandled, reviews: unhandled, conversations: unhandled, apps: unhandled });
  const connection = {};
  for (const [capabilities, expected] of [
    [{ businessSessionApproval: 1, extensibleBusinessApproval: 1 }, 2],
    [{ businessSessionApproval: 1 }, 1],
    [{ businessSessionApproval: 1, extensibleBusinessApproval: true }, 1],
    [{ businessSessionApproval: 2, extensibleBusinessApproval: 1 }, undefined],
    [{}, undefined],
  ]) {
    await host.request('initialize', { clientCapabilities: { _meta: { goose: capabilities } } }, connection);
    assert.equal(host.businessApprovalClients.get(connection), expected);
  }
});
