type WindowTab = 'main' | 'plugin' | 'panel';

const data = {
    main: `
sequenceDiagram
    participant User
    participant Framework
    participant Window
    participant Plugin
    
    User       ->> Framework: 启动程序
    activate Framework
    Framework  ->> Window: 打开窗口
    activate Window
    Window     ->> Plugin: 查询面板数据
    activate Plugin
    Plugin    -->> Window: 返回面板数据
    deactivate Plugin
    Window    -->> Framework: 面板打开结束
    deactivate Window
    Framework -->> User: 启动完毕
    deactivate Framework
    `,
    plugin: `
erDiagram
    Plugin {
      string panels
      string main
    }
    Panel {
      string js
    }
    Main {
      string js
    }
    Plugin    ||--o{  Panel : places
    Plugin    ||--|{  Main : contains
    `,
    panel: `
erDiagram
    Panel {
        string panels
        string main
    }
    HTMLFile {
      string html
    }
    Module {
      string js
    }
    Panel     ||--|{  HTMLFile : places
    HTMLFile  ||--|{  Module : contains
    `,
}

Editor.Module.register({
    stash(): {
        tab: WindowTab,
    } {
        return {
            tab: 'main',
        };
    },
    data() {
        return {};
    },
    method: {
        queryENV() {
            return {
                Electron: process.versions.electron,
                NodeJS: process.versions.node,
                Chromium: process.versions.chrome,
            };
        },

        // --- tab

        queryTab(): WindowTab {
            return this.stash.tab;
        },

        changeTab(tab: WindowTab) {
            this.stash.tab = tab;
            Editor.Message.request('main-window', 'change-mermaid', data[this.stash.tab]);
        },

        queryMermaid() {
            return data[this.stash.tab];
        },
    },
});
