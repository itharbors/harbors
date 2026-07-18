import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClientSession } from '../../src/core/session';

describe('ClientSession', () => {
  let session: ClientSession;

  beforeEach(() => {
    session = new ClientSession('test-session');
  });

  it('stores sessionId', () => {
    expect(session.sessionId).toBe('test-session');
  });

  it('starts disconnected', () => {
    expect(session.connected).toBe(false);
    expect(session.sseActive).toBe(false);
    expect(session.sessionInfo).toBeNull();
  });
});