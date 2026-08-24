import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentOptions } from './adapter/base.js';
import { adapterPermissionDefaults, configuredPermissionDefaults, DEFAULT_APPROVAL_POLICY, DEFAULT_SANDBOX_MODE, selectedOptions, withPermissionDefaults } from './permissions.js';

const options: AgentOptions = {
  models: [{ id: 'model', name: 'Model' }],
  defaultModel: 'model',
  permissions: {
    sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
    approvalPolicies: ['ask', 'always'],
    defaultSandboxMode: 'read-only',
    defaultApprovalPolicy: 'always',
  },
};

test('权限默认值按 config > adapter default > hardcoded fallback 解析', () => {
  const adapterDefaults = adapterPermissionDefaults(options);
  assert.deepEqual(adapterDefaults, { sandboxMode: 'read-only', approvalPolicy: 'always' });
  assert.deepEqual(configuredPermissionDefaults({ get: (key: string) => key.endsWith('sandboxMode') ? 'danger-full-access' : 'ask' }, adapterDefaults), {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'ask',
  });
  assert.deepEqual(configuredPermissionDefaults({ get: () => 'invalid' }, adapterDefaults), adapterDefaults);
  assert.deepEqual(adapterPermissionDefaults({ models: [], defaultModel: '' }), {
    sandboxMode: DEFAULT_SANDBOX_MODE,
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
  });
});

test('显式权限参数优先于 config 默认值', () => {
  const defaults = { sandboxMode: 'danger-full-access' as const, approvalPolicy: 'always' as const };
  assert.deepEqual(withPermissionDefaults({ sandboxMode: 'read-only', approvalPolicy: 'ask' }, defaults), {
    sandboxMode: 'read-only',
    approvalPolicy: 'ask',
  });
  assert.deepEqual(selectedOptions(options, { model: 'model', sandboxMode: 'danger-full-access', approvalPolicy: 'ask' }, defaults), {
    model: 'model',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'ask',
  });
});
