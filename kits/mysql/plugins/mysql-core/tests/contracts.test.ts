import { describe, expect, it } from 'vitest';
import {
  MysqlRequestError,
  OBJECTS_CHANGED_TOPIC,
  isMysqlErrorEnvelope,
  unwrapMysqlResponse,
} from '@itharbors/mysql-contracts';

describe('MySQL shared contracts', () => {
  it('exposes the explorer objects snapshot topic', () => {
    expect(OBJECTS_CHANGED_TOPIC).toBe('@itharbors/mysql.objects.changed');
  });

  it('unwraps successful responses and converts public error envelopes', () => {
    expect(unwrapMysqlResponse<{ connected: boolean }>({ connected: true })).toEqual({
      connected: true,
    });

    const envelope = {
      $mysqlError: {
        code: 'AUTH_FAILED',
        message: 'MySQL 身份验证失败',
        detail: 'Access denied',
      },
    };
    expect(isMysqlErrorEnvelope(envelope)).toBe(true);
    expect(() => unwrapMysqlResponse(envelope)).toThrow(MysqlRequestError);

    try {
      unwrapMysqlResponse(envelope);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'AUTH_FAILED',
        message: 'MySQL 身份验证失败',
        detail: 'Access denied',
      });
    }
  });

  it('does not treat malformed envelopes as public errors', () => {
    const malformed = { $mysqlError: { code: 'AUTH_FAILED' } };
    expect(isMysqlErrorEnvelope(malformed)).toBe(false);
    expect(unwrapMysqlResponse(malformed)).toBe(malformed);
  });
});
