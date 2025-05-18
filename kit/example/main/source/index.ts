import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const list = [
    '概览',
    '套件',
    '插件',
];

export default Editor.Module.registerPlugin({

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
                header: './panel.header/template.html',
                hierarchy: './panel.hierarchy/template.html',
                content: './panel.content/template.html',
            },
        },
    },

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
