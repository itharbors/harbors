import { createHmac } from 'node:crypto';

import type { AttributionConfidence } from '@itharbors/agent-guard-contracts';
import type {
  AgentConfiguration,
  AgentProcessRole,
  ConnectionCounter,
} from './types.js';

export type AttributionEvidence =
  | 'CONFIG_ENDPOINT'
  | 'PROCESS_AGENT'
  | 'PROCESS_TASK'
  | 'DNS_ADDRESS_MATCH'
  | 'REVERSE_DNS_HINT'
  | 'SHARED_ADDRESS'
  | 'DATA_INCOMPLETE';

interface DnsRecord {
  addresses: Set<string>;
  expiresAt: number;
}

export class DnsHistory {
  #records = new Map<string, DnsRecord>();

  update(hostname: string, addresses: readonly string[], observedAt: number, ttlMs: number): void {
    if (!Number.isFinite(observedAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('DNS timestamps and TTL must be valid');
    }
    this.#records.set(hostname.toLowerCase(), {
      addresses: new Set(addresses.map(normalizeAddress)),
      expiresAt: observedAt + ttlMs,
    });
  }

  matchingHostnames(address: string, now: number): string[] {
    const normalized = normalizeAddress(address);
    const matches: string[] = [];
    for (const [hostname, record] of this.#records) {
      if (record.expiresAt >= now && record.addresses.has(normalized)) matches.push(hostname);
    }
    return matches.sort();
  }
}

export interface AttributedConnection {
  agent: AgentConfiguration['agent'];
  provider: string;
  displayHostname: string;
  confidence: AttributionConfidence;
  evidence: AttributionEvidence[];
  remoteAddress: string;
  remoteDigest: string;
  processRole: AgentProcessRole;
  counter: ConnectionCounter;
}

interface AttributionInput {
  counter: ConnectionCounter;
  processRole: AgentProcessRole;
  configuration: AgentConfiguration;
  salt: Uint8Array;
  reverseHostname?: string;
  complete?: boolean;
}

export function attributeConnection(
  input: AttributionInput,
  dns: DnsHistory,
  now: number,
): AttributedConnection {
  const hostname = new URL(input.configuration.endpoint).hostname.toLowerCase();
  const remoteHost = remoteHostname(input.counter.remoteAddress);
  const matches = dns.matchingHostnames(remoteHost, now);
  const addressMatches = matches.includes(hostname);
  const shared = addressMatches && matches.length > 1;
  const reverseHint = input.reverseHostname?.toLowerCase() === hostname;
  const evidence: AttributionEvidence[] = ['CONFIG_ENDPOINT', 'PROCESS_AGENT'];
  if (input.processRole === 'task' || input.processRole === 'hook') evidence.push('PROCESS_TASK');
  if (addressMatches) evidence.push('DNS_ADDRESS_MATCH');
  if (reverseHint && !addressMatches) evidence.push('REVERSE_DNS_HINT');
  if (shared) evidence.push('SHARED_ADDRESS');
  if (input.complete === false) evidence.push('DATA_INCOMPLETE');
  let confidence: AttributionConfidence = 'unknown';
  if (evidence.includes('PROCESS_AGENT')) confidence = 'probable';
  if (addressMatches && evidence.includes('PROCESS_TASK') && !shared && input.complete !== false) {
    confidence = 'confirmed';
  }
  return {
    agent: input.configuration.agent,
    provider: input.configuration.provider,
    displayHostname: hostname,
    confidence,
    evidence,
    remoteAddress: input.counter.remoteAddress,
    remoteDigest: digestRemoteAddress(input.counter.remoteAddress, input.salt),
    processRole: input.processRole,
    counter: input.counter,
  };
}

export function digestRemoteAddress(address: string, salt: Uint8Array): string {
  return createHmac('sha256', salt).update(address).digest('hex').slice(0, 16);
}

function remoteHostname(address: string): string {
  if (address.startsWith('[')) {
    const closing = address.indexOf(']');
    return closing > 0 ? address.slice(1, closing) : address;
  }
  const colon = address.lastIndexOf(':');
  return colon > 0 && address.indexOf(':') === colon ? address.slice(0, colon) : address;
}

function normalizeAddress(address: string): string {
  return remoteHostname(address).toLowerCase();
}
