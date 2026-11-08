import { parse, type DefaultTreeAdapterMap } from 'parse5';

type HtmlNode = DefaultTreeAdapterMap['node'];
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'data', 'poster', 'background', 'cite', 'codebase']);

/** Check Panel markup ordering constraints, not a security/sanitization boundary. */
export function hasEarlyPanelExecution(html: string): boolean {
  const visit = (node: HtmlNode): boolean => {
    if ('tagName' in node) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'script') return true;
      if (tag === 'meta' && node.attrs.some((attribute) => (
        attribute.name.toLowerCase() === 'http-equiv' && attribute.value.trim().toLowerCase() === 'refresh'
      ))) return true;
      for (const attribute of node.attrs) {
        const name = attribute.name.toLowerCase();
        if (/^on[a-z]/u.test(name) || (tag === 'iframe' && name === 'srcdoc')) return true;
        // parse5 decodes HTML entities. Browsers remove ASCII controls in URL schemes.
        const value = attribute.value.replace(/[\u0000-\u0020]/gu, '').toLowerCase();
        if (URL_ATTRIBUTES.has(name) && value.startsWith('javascript:')) return true;
        if (tag === 'meta' && name === 'content' && value.includes('javascript:')) return true;
      }
      if ('content' in node && visit(node.content)) return true;
    }
    return 'childNodes' in node && node.childNodes.some(visit);
  };
  return visit(parse(html));
}
