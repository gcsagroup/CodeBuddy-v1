import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedInstructionStep } from '../instructions.mjs';

test('slow downstream work does not spend the instruction read budget', async () => {
  const step = boundedInstructionStep(async (_step, next) => await next(), 10);
  assert.equal(await step({ signal: new AbortController().signal }, () => delay(30, 'enter')), 'enter');
});

test('a stalled instruction read rejects the step and cannot admit a late result', async () => {
  const read = Promise.withResolvers();
  let admitted = false;
  const step = boundedInstructionStep(async ({ signal }, next) => {
    await next();
    await read.promise;
    signal.throwIfAborted();
    admitted = true;
  }, 10);
  await assert.rejects(step({ signal: new AbortController().signal }, async () => 'enter'), /AGENTS\.md/);
  read.resolve();
  await delay(0);
  assert.equal(admitted, false);
});

test('user cancellation preserves its reason during an unresponsive instruction read', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const read = Promise.withResolvers();
  const run = boundedInstructionStep(async (_step, next) => {
    await next();
    entered.resolve();
    await read.promise;
  })({ signal: controller.signal }, async () => 'enter');
  await entered.promise;
  const reason = new Error('user cancelled');
  controller.abort(reason);
  await assert.rejects(run, error => error === reason);
  read.resolve();
});
