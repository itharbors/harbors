import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type LinkProtocol = 'file' | 'http' | 'https' | 'unsupported';

export interface NormalizedLink {
  href: string;
  originalHref: string;
  protocol: LinkProtocol;
}

function unsupported(originalHref: string): NormalizedLink {
  return { href: originalHref, originalHref, protocol: 'unsupported' };
}

function fileBaseHref(directory: string): string {
  const withTrailingSeparator = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
  return pathToFileURL(withTrailingSeparator).href;
}

function resolveFileHref(originalHref: string, selectedProject?: string | null): string | null {
  if (path.isAbsolute(originalHref)) {
    // Use the native path root as the URL base. This keeps absolute local paths
    // native to the current host without falling back to process.cwd().
    return new URL(originalHref, fileBaseHref(path.parse(originalHref).root)).href;
  }
  if (!selectedProject || !path.isAbsolute(selectedProject)) return null;
  return new URL(originalHref, fileBaseHref(selectedProject)).href;
}

export function normalizeLink(originalHref: string, selectedProject?: string | null): NormalizedLink {
  if (typeof originalHref !== 'string' || originalHref.length === 0) {
    return unsupported(originalHref);
  }

  // Fragment/query-only references are document-local navigation, not files.
  if (originalHref.startsWith('#') || originalHref.startsWith('?')) {
    return unsupported(originalHref);
  }

  // Scheme-relative URLs are network references, never local paths.
  if (originalHref.startsWith('//')) return unsupported(originalHref);

  // Native absolute paths must be detected before the scheme regex so that a
  // Windows drive path is handled by path/pathToFileURL on Windows.
  const absolutePath = path.isAbsolute(originalHref);
  const scheme = absolutePath ? null : originalHref.match(/^([A-Za-z][A-Za-z\d+.-]*):/u)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    try {
      const url = new URL(originalHref);
      return { href: url.href, originalHref, protocol: scheme };
    } catch {
      return unsupported(originalHref);
    }
  }
  if (scheme === 'file') {
    try {
      const url = new URL(originalHref);
      if (url.protocol !== 'file:' || url.host !== '') return unsupported(originalHref);
      return { href: url.href, originalHref, protocol: 'file' };
    } catch {
      return unsupported(originalHref);
    }
  }
  if (scheme) return unsupported(originalHref);

  try {
    const href = resolveFileHref(originalHref, selectedProject);
    return href ? { href, originalHref, protocol: 'file' } : unsupported(originalHref);
  } catch {
    return unsupported(originalHref);
  }
}
