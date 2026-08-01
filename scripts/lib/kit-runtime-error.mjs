const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function trustedFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !['code', 'message'].includes(key))) return undefined;
  if (typeof value.code !== 'string' || !CODE_PATTERN.test(value.code)) return undefined;
  if (
    typeof value.message !== 'string'
    || value.message.length === 0
    || value.message.length > 240
    || /[\r\n\u2028\u2029\u0000-\u001f\u007f-\u009f]/u.test(value.message)
  ) return undefined;
  return value;
}

export function createKitRuntimeApplyError(message, failure) {
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('Kit Runtime error message is required');
  }
  const trusted = trustedFailure(failure);
  const cause = trusted
    ? Object.assign(new Error(trusted.message), { code: trusted.code })
    : undefined;
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'KIT_RUNTIME_APPLY_FAILED',
  });
}
