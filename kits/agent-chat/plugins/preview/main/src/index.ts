import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';

declare const editor: any;

let runtime: any;

interface LinkClickedPayload {
  href: string;
  text: string;
  protocol: string;
  conversationId?: string;
  project?: string;
}

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

function resolveFilePath(href: string, project?: string): string | null {
  // 去掉可能的 file:// 前缀
  let cleaned = href;
  if (cleaned.startsWith('file://')) {
    cleaned = cleaned.slice('file://'.length);
  }
  // 去掉查询参数和 hash
  cleaned = cleaned.split('?')[0].split('#')[0];
  if (!cleaned) return null;

  if (isAbsolute(cleaned)) {
    return cleaned;
  }
  // 相对路径基于项目目录解析
  if (project) {
    return resolve(project, cleaned);
  }
  return resolve(cleaned);
}

async function readTextFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return buffer.toString('utf-8');
}

editor.plugin.define({
  lifecycle: {
    load(ctx: any) {
      runtime = ctx;
    },
    unload() {
      runtime = null;
    },
  },
  methods: {
    async readFile(filePath: string): Promise<PreviewContent> {
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
            title: filePath.split('/').pop(),
            language: 'image',
            content: dataUrl,
          };
        }
        if (TEXT_EXTENSIONS.has(ext) || !ext) {
          const content = await readTextFile(filePath);
          return {
            kind: 'file',
            path: filePath,
            title: filePath.split('/').pop(),
            language: detectLanguage(filePath),
            content,
          };
        }
        return {
          kind: 'unsupported',
          path: filePath,
          title: filePath.split('/').pop(),
          error: `不支持预览的文件类型：${ext || '未知'}`,
        };
      } catch (err) {
        return {
          kind: 'file',
          path: filePath,
          title: filePath.split('/').pop(),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    onLinkClicked(payload: LinkClickedPayload) {
      if (!runtime) return;
      const { href, protocol, project } = payload;

      // 处理 http/https 链接
      if (protocol === 'http' || protocol === 'https') {
        runtime.message.broadcast('preview.content', {
          kind: 'url',
          url: href,
          title: payload.text || href,
        } satisfies PreviewContent);
        return;
      }

      // 处理文件路径
      const filePath = resolveFilePath(href, project);
      if (!filePath) return;

      runtime.message.broadcast('preview.content', {
        kind: 'file',
        path: filePath,
        title: payload.text || filePath.split('/').pop(),
      } satisfies PreviewContent);
    },
  },
});
