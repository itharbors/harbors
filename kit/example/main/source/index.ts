import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const list = [
    '概览',
    '套件',
    '插件',
    '面板',
    '消息',
    '贡献'
];

Editor.Module.register({
    stash(): {
        tab: string,
    } {
        return {
            tab: list[0],
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
        queryTabs(): string[] {
            return list;
        },

        queryTab(): string {
            return this.stash.tab;
        },

        changeTab(tab: string) {
            this.stash.tab = tab;
        },

        queryContent(tab: string) {
            const mdFile = join(__dirname, `../../static/${tab}.md`);
            if (existsSync(mdFile)) {
                const data = readFileSync(mdFile, 'utf8');
                return data;
            }
            return '404';
        },
    },
});
