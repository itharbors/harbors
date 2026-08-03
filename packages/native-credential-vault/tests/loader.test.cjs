const assert = require('node:assert/strict');
const test = require('node:test');

const { createBindingLoader } = require('../lib/loader.cjs');

test('unsupported platforms fail closed without loading a native binding', () => {
  for (const [platform, arch] of [
    ['linux', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
    ['darwin', 'x64'],
  ]) {
    let loadCount = 0;
    const load = createBindingLoader({
      platform,
      arch,
      loadBinding() {
        loadCount += 1;
        return {};
      },
    });

    assert.throws(load, { code: 'BACKEND_UNAVAILABLE' });
    assert.equal(loadCount, 0);
  }
});
test('darwin arm64 accepts only the complete three-function binding', () => {
  const binding = {
    getPassword() { return null; },
    setPassword() {},
    deletePassword() { return false; },
  };
  const load = createBindingLoader({
    platform: 'darwin',
    arch: 'arm64',
    loadBinding: () => binding,
  });

  assert.equal(load(), binding);

  for (const missing of ['getPassword', 'setPassword', 'deletePassword']) {
    const malformed = { ...binding };
    delete malformed[missing];
    assert.throws(
      createBindingLoader({
        platform: 'darwin',
        arch: 'arm64',
        loadBinding: () => malformed,
      }),
      { code: 'BACKEND_UNAVAILABLE' },
    );
  }
});
