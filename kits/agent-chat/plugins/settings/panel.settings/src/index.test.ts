import assert from 'node:assert/strict';
import test from 'node:test';
import { inputTypeForSetting } from './index.js';

test('password settings render as password inputs', () => {
  assert.equal(inputTypeForSetting('password'), 'password');
  assert.equal(inputTypeForSetting('text'), 'text');
});
