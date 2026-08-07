import type { PanelFileRuntime } from '@itharbors/plugin-types';

interface LocalFilePathBridge {
  getPathForFile(file: File): string;
}

interface SaveFileHandle {
  getFile(): Promise<File>;
}

interface PanelFileWindow extends Window {
  harborsFiles?: LocalFilePathBridge;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFileHandle>;
}

type PanelFileRuntimeFactory = (
  windowObject: PanelFileWindow,
  documentObject: Document,
) => PanelFileRuntime;

// This is the canonical implementation for both direct behavior tests and the
// browser runtime. Keeping the source explicit prevents development loaders from
// leaking build-only helpers into Function#toString output.
export const PANEL_FILE_RUNTIME_FACTORY_SOURCE = String.raw`function createPanelFileRuntime(windowObject, documentObject) {
  function fileRuntimeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function desktopFileError() {
    return fileRuntimeError(
      'LOCAL_FILE_PATH_UNAVAILABLE',
      '浏览器模式暂不支持新建或写回本机文件，请在桌面版中使用。',
    );
  }

  function getPathBridge() {
    try {
      const hostWindow = windowObject.parent === windowObject
        ? windowObject
        : windowObject.parent;
      return hostWindow.harborsFiles;
    } catch {
      return undefined;
    }
  }

  function resolveLocalFilePath(file, bridge = getPathBridge()) {
    if (!bridge || typeof bridge.getPathForFile !== 'function') throw desktopFileError();
    let filePath;
    try {
      filePath = bridge.getPathForFile(file);
    } catch {
      throw desktopFileError();
    }
    if (typeof filePath !== 'string' || filePath.length === 0) throw desktopFileError();
    return filePath;
  }

  async function stageLocalWebFile(file) {
    const search = windowObject.location && typeof windowObject.location.search === 'string'
      ? windowObject.location.search
      : '';
    const sessionId = new URLSearchParams(search).get('sessionId') || '';
    if (!sessionId || typeof windowObject.fetch !== 'function') {
      throw fileRuntimeError('LOCAL_FILE_SESSION_UNAVAILABLE', '当前页面无法建立本机文件会话。');
    }
    const response = await windowObject.fetch(
      '/api/local-file/open/' + encodeURIComponent(sessionId) + '?name=' + encodeURIComponent(file.name),
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      },
    );
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Normalize non-JSON proxy and transport responses below.
    }
    if (!response.ok) {
      const remote = payload && typeof payload === 'object' ? payload.error : null;
      throw fileRuntimeError(
        remote && typeof remote.code === 'string' ? remote.code : 'LOCAL_FILE_UPLOAD_FAILED',
        remote && typeof remote.message === 'string' ? remote.message : '无法读取所选文件。',
      );
    }
    if (!payload || typeof payload.path !== 'string' || payload.path.length === 0) {
      throw fileRuntimeError('LOCAL_FILE_UPLOAD_FAILED', '本机文件服务返回了无效路径。');
    }
    return payload.path;
  }

  function buildSavePickerTypes(accept) {
    const tokens = accept?.split(',').map((token) => token.trim()).filter(Boolean) ?? [];
    const extensions = tokens.filter((token) => /^\.[a-z0-9]+$/i.test(token));
    if (extensions.length === 0) return undefined;
    const mimeTypes = tokens.filter((token) => /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(token));
    const acceptMap = {};
    for (const mimeType of mimeTypes.length > 0 ? mimeTypes : ['application/octet-stream']) {
      acceptMap[mimeType] = extensions;
    }
    return [{ description: 'Supported files', accept: acceptMap }];
  }

  return {
    openLocal(options = {}) {
      return new Promise((resolve, reject) => {
        const input = documentObject.createElement('input');
        input.type = 'file';
        input.hidden = true;
        input.multiple = false;
        if (options.accept) input.accept = options.accept;

        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          input.remove();
          callback();
        };
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) {
            finish(() => resolve(null));
            return;
          }
          try {
            const bridge = getPathBridge();
            const filePath = bridge === undefined
              ? await stageLocalWebFile(file)
              : resolveLocalFilePath(file, bridge);
            finish(() => resolve(filePath));
          } catch (error) {
            finish(() => reject(error));
          }
        }, { once: true });
        input.addEventListener('cancel', () => {
          finish(() => resolve(null));
        }, { once: true });

        (documentObject.body ?? documentObject.documentElement).append(input);
        try {
          input.click();
        } catch (error) {
          finish(() => reject(error));
        }
      });
    },

    async saveLocal(options = {}) {
      const bridge = getPathBridge();
      if (!bridge || typeof bridge.getPathForFile !== 'function') throw desktopFileError();
      if (typeof windowObject.showSaveFilePicker !== 'function') {
        throw new Error('当前浏览器不支持保存文件选择器。');
      }

      const types = buildSavePickerTypes(options.accept);
      let handle;
      try {
        handle = await windowObject.showSaveFilePicker({
          ...(options.suggestedName ? { suggestedName: options.suggestedName } : {}),
          ...(types ? { types } : {}),
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
          return null;
        }
        throw error;
      }
      return resolveLocalFilePath(await handle.getFile(), bridge);
    },
  };
}`;

const panelFileRuntimeFactory = Function(
  `'use strict'; return (${PANEL_FILE_RUNTIME_FACTORY_SOURCE});`,
)() as PanelFileRuntimeFactory;

export function createPanelFileRuntime(
  windowObject: PanelFileWindow,
  documentObject: Document,
): PanelFileRuntime {
  return panelFileRuntimeFactory(windowObject, documentObject);
}
