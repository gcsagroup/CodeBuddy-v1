import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopControlPresentation, matchesDesktopCancel } from '../desktop-control.mjs';

test('desktop indicator starts only at dispatched native tools and spans model intervals', () => {
  const events = [];
  const feedback = desktopControlPresentation({ sessionId: 's', token: 'turn', notify: (...args) => events.push(args) });
  feedback.start({ name: 'skill' });
  feedback.start({ name: 'read' });
  feedback.start({ name: 'mcp__qwen_computer__unknown' });
  assert.equal(events.length, 0);
  feedback.start({ name: 'mcp__qwen_computer__get_app_state' });
  feedback.start({ name: 'mcp__qwen_computer__drag' });
  assert.equal(events.length, 2, 'each dispatch identifies the currently controlling turn');
  assert.deepEqual(events[0][1].update.status.data, { event: 'desktop_control', token: 'turn', active: true });
  feedback.end(); feedback.end();
  assert.equal(events.length, 3);
  assert.equal(events[2][1].update.status.data.active, false);
});

test('delayed escape cannot cancel a replacement turn or an unrelated session', () => {
  assert.equal(matchesDesktopCancel({ desktopControlToken: 'new' }, 'old'), false);
  assert.equal(matchesDesktopCancel(undefined, 'old'), false);
  assert.equal(matchesDesktopCancel({}, undefined), false);
  assert.equal(matchesDesktopCancel({ desktopControlToken: 'new' }, 'new'), true);
});

test('optional feedback transport failures do not fail desktop execution or settlement', () => {
  const feedback = desktopControlPresentation({ sessionId: 's', token: 't', notify() { throw Error('closed'); } });
  assert.doesNotThrow(() => feedback.start({ name: 'mcp__qwen_computer__click' }));
  assert.doesNotThrow(() => feedback.end());
});
