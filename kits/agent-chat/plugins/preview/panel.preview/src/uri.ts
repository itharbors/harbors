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
    // No base URL: relative paths and bare filesystem paths are not URI links.
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
