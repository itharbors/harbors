import { fileURLToPath } from 'node:url';

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
  protocol: Exclude<PreviewProtocol, 'unsupported'>;
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
 * Validate the URI metadata supplied by Message Panel without resolving a
 * relative value against an implicit base URL.
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
  if (!['file', 'http', 'https', 'unsupported'].includes(protocol)) {
    return { ok: false, error: `不支持的链接协议：${value.protocol}`, originalHref };
  }

  let url: URL;
  try {
    // Deliberately omit a base URL: relative and bare filesystem paths must be
    // rejected instead of being interpreted as local or web URLs.
    url = new URL(value.href);
  } catch {
    return { ok: false, error: '无法解析的预览 URI', originalHref };
  }

  const actualProtocol = url.protocol.slice(0, -1).toLowerCase();
  if (protocol !== 'unsupported' && actualProtocol !== protocol) {
    return { ok: false, error: '预览链接协议与 URI 不匹配', originalHref };
  }

  if (protocol === 'unsupported') {
    return { ok: false, error: `不支持的链接协议：${actualProtocol || '未知'}`, originalHref };
  }

  if (protocol === 'file') {
    // Restrict file links to the standard absolute file:/// form. In
    // particular, do not accept file://host/path or file:/path.
    if (!/^file:\/\/\//i.test(value.href) || url.host !== '') {
      return { ok: false, error: '文件 URI 必须是标准 file:/// URI', originalHref };
    }
  } else if (!new RegExp(`^${protocol}://`, 'i').test(value.href)) {
    return { ok: false, error: 'HTTP(S) URI 格式无效', originalHref };
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

/** Convert only a validated file URI to a local path; never uses cwd. */
export function filePathFromPreviewLink(value: unknown): string | null {
  const validation = validatePreviewLink(value);
  if (!validation.ok || validation.link.protocol !== 'file') return null;
  try {
    return fileURLToPath(validation.link.url);
  } catch {
    return null;
  }
}
