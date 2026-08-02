import assert from 'node:assert/strict';
import test from 'node:test';

let runtimeErrorModule;
try {
  runtimeErrorModule = await import('./kit-runtime-error.mjs');
} catch {
  runtimeErrorModule = {};
}

test('wraps a validated runtime failure without exposing arbitrary failure input', () => {
  assert.equal(typeof runtimeErrorModule.createKitRuntimeApplyError, 'function');

  const error = runtimeErrorModule.createKitRuntimeApplyError(
    'Kit failed to load; the previous Runtime was restored',
    {
      code: 'RUNTIME_LOAD_FAILED',
      message: "ENOENT: missing 'plugins/demo/resources/policy-v1.json'",
    },
  );
  assert.equal(error.code, 'KIT_RUNTIME_APPLY_FAILED');
  assert.equal(error.message, 'Kit failed to load; the previous Runtime was restored');
  assert.equal(error.cause.code, 'RUNTIME_LOAD_FAILED');
  assert.equal(
    error.cause.message,
    "ENOENT: missing 'plugins/demo/resources/policy-v1.json'",
  );
  assert.equal(error.stack.includes('policy-v1.json'), false);

  const untrusted = runtimeErrorModule.createKitRuntimeApplyError(
    'Kit Runtime replacement failed; the previous Runtime was restored',
    { code: 'bad-code', message: '<script>secret</script>', extra: true },
  );
  assert.equal(untrusted.code, 'KIT_RUNTIME_APPLY_FAILED');
  assert.equal(untrusted.cause, undefined);
});
