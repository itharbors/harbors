const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const supported = process.platform === 'darwin' && process.arch === 'arm64';

test('real Keychain preserves missing, write, read, and delete semantics', { skip: !supported }, () => {
  const vault = require('../index.cjs');
  const service = 'com.itharbors.credentials.test';
  const account = `smoke:${randomUUID()}`;
  const secret = `harbors-native-smoke-${randomUUID()}`;

  try {
    assert.equal(vault.getPassword(service, account), null);
    vault.setPassword(service, account, secret);
    assert.equal(vault.getPassword(service, account), secret);
    assert.equal(vault.deletePassword(service, account), true);
    assert.equal(vault.getPassword(service, account), null);
    assert.equal(vault.deletePassword(service, account), false);
  } finally {
    try {
      vault.deletePassword(service, account);
    } catch {
      // The assertion failure remains primary; cleanup is best effort.
    }
  }
});
