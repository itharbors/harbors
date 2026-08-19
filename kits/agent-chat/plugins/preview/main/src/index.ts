import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { filePathFromPreviewLink, validatePreviewLink } from './uri.js';

declare const editor: any;

interface PreviewContent {
  kind: 'file' | 'url' | 'unsupported';
  path?: string;
  url?: string;
  title?: string;
  language?: string;
  content?: string;
  error?: string;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.jsx', '.ts', '.tsx',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash', '.zsh', '.py', '.rb',
  '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift',
  '.kt', '.kts', '.scala', '.sql', '.graphql', '.gql', '.vue', '.svelte',
  '.astro', '.mjs', '.cjs', '.mts', '.cts', '.wasm', '.map', '.lock',
  '.gitignore', '.gitattributes', '.editorconfig', '.env', '.env.example',
  '.dockerignore', '.dockerfile', 'dockerfile', '.makefile', 'makefile',
  '.cmake', '.gradle', '.pom', '.csproj', '.sln', '.vcxproj',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
]);

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'tsx', '.mts': 'typescript', '.cts': 'typescript',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.html': 'html', '.htm': 'html', '.xml': 'xml', '.svg': 'xml',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.md': 'markdown', '.markdown': 'markdown',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.cs': 'csharp', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
    '.scala': 'scala', '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
    '.vue': 'vue', '.svelte': 'svelte', '.sh': 'bash', '.bash': 'bash',
    '.zsh': 'bash', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
  };
  return map[ext] || 'plaintext';
}

async function readTextFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return buffer.toString('utf-8');
}

editor.plugin.define({
  methods: {
    async readFile(payload: unknown): Promise<PreviewContent> {
      const validation = validatePreviewLink(payload);
      if ('error' in validation) {
        const href = validation.originalHref || (typeof payload === 'object' && payload !== null && 'href' in payload
          ? String((payload as { href?: unknown }).href || '') : '');
        return {
          kind: 'unsupported',
          title: href,
          error: validation.error,
        };
      }
      const filePath = filePathFromPreviewLink(payload);
      if (!filePath) {
        return {
          kind: 'unsupported',
          title: validation.link.originalHref,
          error: validation.link.protocol === 'file' ? '无法解析的文件 URI' : '仅支持预览 file URI',
        };
      }
      try {
        const ext = extname(filePath).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          // 图片转 base64 供面板渲染
          const fs = await import('node:fs/promises');
          const buffer = await fs.readFile(filePath);
          const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
          const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
          return {
            kind: 'file',
            path: filePath,
            title: basename(filePath),
            language: 'image',
            content: dataUrl,
          };
        }
        if (TEXT_EXTENSIONS.has(ext) || !ext) {
          const content = await readTextFile(filePath);
          return {
            kind: 'file',
            path: filePath,
            title: basename(filePath),
            language: detectLanguage(filePath),
            content,
          };
        }
        return {
          kind: 'unsupported',
          path: filePath,
          title: basename(filePath),
          error: `不支持预览的文件类型：${ext || '未知'}`,
        };
      } catch (err) {
        return {
          kind: 'file',
          path: filePath,
          title: basename(filePath),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  },
});
