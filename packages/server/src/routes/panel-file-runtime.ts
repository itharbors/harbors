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
  function localFileError() {
    const error = new Error('该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。');
    error.code = 'LOCAL_FILE_PATH_UNAVAILABLE';
    return error;
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
    if (!bridge || typeof bridge.getPathForFile !== 'function') throw localFileError();
    let filePath;
    try {
      filePath = bridge.getPathForFile(file);
    } catch {
      throw localFileError();
    }
    if (typeof filePath !== 'string' || filePath.length === 0) throw localFileError();
    return filePath;
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
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (!file) {
            finish(() => resolve(null));
            return;
          }
          try {
            const filePath = resolveLocalFilePath(file);
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
      if (!bridge) throw localFileError();
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
