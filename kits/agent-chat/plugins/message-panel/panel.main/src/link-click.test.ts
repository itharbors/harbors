import assert from 'node:assert/strict';
import test from 'node:test';
import { captureLinkClick, createLinkClickedPayload, createLinkClickSequenceGate } from './link-click.ts';

test('only the latest click sequence is current', () => {
  const gate = createLinkClickSequenceGate();
  const first = gate.next();
  assert.equal(gate.isCurrent(first), true);
  const second = gate.next();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test('captures selected project and conversation at click time', () => {
  const snapshot = captureLinkClick({ href: '../README.md', text: 'README' }, 'conversation-a', '/tmp/project-a');
  assert.deepEqual(snapshot, { href: '../README.md', text: 'README', conversationId: 'conversation-a', selectedProject: '/tmp/project-a' });
});

test('broadcast payload has the fixed link protocol and omits project', () => {
  const snapshot = captureLinkClick({ href: '../README.md', text: 'README' }, 'conversation-a', '/tmp/project-a');
  const payload = createLinkClickedPayload({ href: 'file:///tmp/README.md', originalHref: '../README.md', protocol: 'file' }, snapshot);
  assert.deepEqual(payload, { href: 'file:///tmp/README.md', originalHref: '../README.md', protocol: 'file', text: 'README', conversationId: 'conversation-a' });
  assert.equal('project' in payload, false);
});
