/**
 * Mermaid 代码块渲染器
 *
 * 由 chat 插件的 markdown 渲染扩展点动态加载。
 * exports 三个函数：
 * - load(): 初始化，在 chat panel iframe 中插入 mermaid.js
 * - unload(): 清理
 * - execute(code): 渲染 mermaid 代码，返回 SVG HTML 字符串
 */

let mermaidLoaded = false;
let mermaidPromise = null;

export function load() {
  if (mermaidLoaded) return;
  if (mermaidPromise) return mermaidPromise;

  mermaidPromise = new Promise((resolve, reject) => {
    // 从 mermaid 插件的 assets 加载 mermaid.js
    const script = document.createElement('script');
    script.src = '/api/assets/plugin/mermaid/mermaid.min.js';
    script.onload = () => {
      mermaidLoaded = true;
      // 初始化 mermaid，关闭自动渲染
      if (window.mermaid) {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
      }
      resolve();
    };
    script.onerror = () => {
      mermaidPromise = null;
      reject(new Error('Failed to load mermaid.js'));
    };
    document.head.appendChild(script);
  });

  return mermaidPromise;
}

export function unload() {
  mermaidLoaded = false;
  mermaidPromise = null;
}

export async function execute(code) {
  if (!mermaidLoaded) {
    await load();
  }

  if (!window.mermaid) {
    throw new Error('mermaid is not available');
  }

  const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { svg } = await window.mermaid.render(id, code);
  return svg;
}
