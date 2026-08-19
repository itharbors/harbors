export interface LinkClickSnapshot {
  href: string;
  text?: string;
  conversationId?: string;
  selectedProject?: string;
}

export interface NormalizedLinkResult {
  href: string;
  originalHref: string;
  protocol: 'file' | 'http' | 'https' | 'unsupported';
}

export interface LinkClickedPayload extends NormalizedLinkResult {
  text?: string;
  conversationId?: string;
}

export interface LinkClickSequenceGate {
  next(): number;
  isCurrent(sequence: number): boolean;
}

export function createLinkClickSequenceGate(): LinkClickSequenceGate {
  let latest = 0;
  return {
    next() {
      latest += 1;
      return latest;
    },
    isCurrent(sequence) {
      return sequence === latest;
    },
  };
}

export function captureLinkClick(info: { href: string; text?: string }, conversationId: string | null, selectedProject: string | null): LinkClickSnapshot {
  return {
    href: info.href,
    ...(typeof info.text === 'string' ? { text: info.text } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(selectedProject ? { selectedProject } : {}),
  };
}

export function createLinkClickedPayload(normalized: NormalizedLinkResult, snapshot: LinkClickSnapshot): LinkClickedPayload {
  return {
    href: normalized.href,
    originalHref: normalized.originalHref,
    protocol: normalized.protocol,
    ...(snapshot.text !== undefined ? { text: snapshot.text } : {}),
    ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}),
  };
}
