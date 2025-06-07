import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const list = [
    '概览',
    '套件',
    '插件',
];

export default Editor.Module.registerPlugin<{
    tab: string;
}>({

    contribute: {
        data: {
            message: {
                'query-env': {
                    method: [
                        'queryENV',
                    ],
                },

                'query-tabs': {
                    method: [
                        'queryTabs',
                    ],
                },

                'query-tab': {
                    method: [
                        'queryTab',
                    ],
                },

                'change-tab': {
                    method: [
                        'changeTab',
                        'hierarchy.changeTab',
                        'content.changeTab',
                    ],
                },

                'query-content': {
                    method: [
                        'queryContent',
                    ],
                },
            },

            panel: {
                header: './panel.header/dist/index.js',
                hierarchy: './panel.hierarchy/dist/index.js',
                content: './panel.content/dist/index.js',
            },
        },
    },

    register() {
        this.tab = list[0];
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
            return this.tab;
        },

        changeTab(tab: string) {
            this.tab = tab;
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
