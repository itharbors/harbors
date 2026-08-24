export type PreviewProtocol = 'file' | 'http' | 'https' | 'unsupported';

export interface PreviewLinkPayload {
  href: string;
  originalHref: string;
  protocol: PreviewProtocol;
  text?: string;
  conversationId?: string;
}

export interface ValidatedPreviewLink {
  href: string;
  originalHref: string;
  protocol: 'file' | 'http' | 'https';
  text?: string;
  conversationId?: string;
  url: URL;
}

export type PreviewLinkValidation =
  | { ok: true; link: ValidatedPreviewLink }
  | { ok: false; error: string; originalHref?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Lightweight validation for the preview panel.
 *
 * The link has already been normalized by `chat.normalizeLink` in the
 * main process, so we only need to verify the payload shape and route by
 * protocol. Full URI validation (scheme matching, file:// form, etc.) is
 * enforced again by the preview main process before reading the file.
 */
export function validatePreviewLink(value: unknown): PreviewLinkValidation {
  if (!isRecord(value)
    || typeof value.href !== 'string'
    || typeof value.originalHref !== 'string'
    || typeof value.protocol !== 'string') {
    return { ok: false, error: '预览链接 payload 无效' };
  }

  const originalHref = value.originalHref;
  if ((value.text !== undefined && typeof value.text !== 'string')
    || (value.conversationId !== undefined && typeof value.conversationId !== 'string')) {
    return { ok: false, error: '预览链接 payload 无效', originalHref };
  }

  const protocol = value.protocol as PreviewProtocol;
  if (protocol === 'unsupported' || !['file', 'http', 'https'].includes(protocol)) {
    return { ok: false, error: `不支持的链接协议：${value.protocol}`, originalHref };
  }

  let url: URL;
  try {
    url = new URL(value.href);
  } catch {
    return { ok: false, error: '无法解析的预览 URI', originalHref };
  }

  return {
    ok: true,
    link: {
      href: url.href,
      originalHref,
      protocol,
      ...(typeof value.text === 'string' ? { text: value.text } : {}),
      ...(typeof value.conversationId === 'string' ? { conversationId: value.conversationId } : {}),
      url,
    },
  };
}
