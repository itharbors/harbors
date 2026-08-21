import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CAPABILITY_VERSION = 'panel-request.v1';
const CAPABILITY_DOMAIN = 'harbors.panel-request-capability\0';

export interface PanelRequestCapabilityClaims {
  sessionId: string;
  panelName: string;
  ownerPlugin: string;
}

export interface PanelRequestCapability {
  issue(claims: PanelRequestCapabilityClaims): string;
  verify(token: string, sessionId: string): PanelRequestCapabilityClaims | undefined;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string | undefined {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

function sign(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret)
    .update(CAPABILITY_DOMAIN, 'utf8')
    .update(payload, 'utf8')
    .digest('base64url');
}

function isClaims(value: unknown): value is PanelRequestCapabilityClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Partial<PanelRequestCapabilityClaims>;
  return typeof claims.sessionId === 'string'
    && claims.sessionId.length > 0
    && typeof claims.panelName === 'string'
    && claims.panelName.length > 0
    && typeof claims.ownerPlugin === 'string'
    && claims.ownerPlugin.length > 0;
}

function signaturesEqual(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function createPanelRequestCapability(secret = randomBytes(32)): PanelRequestCapability {
  return {
    issue(claims) {
      if (!isClaims(claims)) throw new Error('Panel request capability claims are invalid');
      const payload = encode(JSON.stringify({ v: CAPABILITY_VERSION, ...claims }));
      return `${payload}.${sign(secret, payload)}`;
    },
    verify(token, sessionId) {
      if (typeof token !== 'string') return undefined;
      const separator = token.lastIndexOf('.');
      if (separator <= 0 || separator === token.length - 1) return undefined;
      const payload = token.slice(0, separator);
      const suppliedSignature = token.slice(separator + 1);
      if (!signaturesEqual(sign(secret, payload), suppliedSignature)) return undefined;

      const decoded = decode(payload);
      if (!decoded) return undefined;
      try {
        const value = JSON.parse(decoded) as Record<string, unknown>;
        if (value.v !== CAPABILITY_VERSION || !isClaims(value) || value.sessionId !== sessionId) {
          return undefined;
        }
        return {
          sessionId: value.sessionId,
          panelName: value.panelName,
          ownerPlugin: value.ownerPlugin,
        };
      } catch {
        return undefined;
      }
    },
  };
}
