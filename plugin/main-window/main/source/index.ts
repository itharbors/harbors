type WindowTab = 'main' | 'plugin' | 'panel';

const stash: {
    tab: WindowTab;
} = {
    tab: 'main',
};

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

exports.method = {
    'query-env'() {
        return {
            Electron: process.versions.electron,
            NodeJS: process.versions.node,
            Chromium: process.versions.chrome,
        };
    },

    // --- tab

    'query-tab'(): WindowTab {
        return stash.tab;
    },

    'change-tab'(tab: WindowTab) {
        stash.tab = tab;
        // @ts-ignore
        Editor.Message.sendToPanel('main-window', 'hierarchy', 'change-tab', tab);
        // @ts-ignore
        Editor.Message.sendToPanel('main-window', 'content', 'change-mermaid', data[stash.tab]);
    },

    'query-mermaid'() {
        return data[stash.tab];
    },
};
