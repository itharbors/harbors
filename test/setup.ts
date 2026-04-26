// 测试环境设置
// service/node 的实现会自动被使用（Node.js 环境）

// Mock Electron 的 Menu API
const mockMenu = {
    buildFromTemplate: () => mockMenu,
    setApplicationMenu: () => {},
    popup: () => {},
    closePopup: () => {},
};

// Mock Electron 的 BrowserWindow
let windowIdCounter = 0;
const mockWindows: any[] = [];

const mockBrowserWindow = function(config: any) {
    const win = {
        id: ++windowIdCounter,
        config,
        loadFile: () => {},
        loadURL: () => {},
        on: () => win,
        webContents: {
            id: windowIdCounter,
            on: () => win,
            send: () => {},
            close: () => {},
        },
        close: () => {},
        show: () => {},
        hide: () => {},
        focus: () => {},
        isDestroyed: () => false,
    };
    mockWindows.push(win);
    return win;
};

// Mock global Electron objects
if (typeof (global as any).electron !== 'undefined') {
    (global as any).electron.Menu = mockMenu;
    (global as any).electron.BrowserWindow = mockBrowserWindow;
}

// Mock require for Electron modules
import Module from 'node:module';
const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function(id: string) {
    if (id === 'electron') {
        return {
            Menu: mockMenu,
            BrowserWindow: mockBrowserWindow,
            app: {
                on: () => {},
                ready: Promise.resolve(),
                quit: () => {},
                getPath: () => '/tmp',
            },
            ipcMain: {
                handle: () => {},
                on: () => {},
                removeHandler: () => {},
            },
            protocol: {
                handle: () => {},
                registerHttpProtocol: () => {},
            },
        };
    }
    if (id === '@itharbors/electron-panel') {
        return {
            register: () => {},
            unregister: () => {}
        };
    }
    if (id === '@itharbors/electron-panel/browser') {
        return {
            register: () => Promise.resolve(),
            unregister: () => Promise.resolve(),
            callMethod: () => Promise.resolve(),
        };
    }
    if (id === '@itharbors/electron-message/browser') {
        return {
            addListener: () => () => {},
        };
    }
    return originalRequire.call(this, id);
};