import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

Editor.Module.register({
    stash(): {
        tab: string,
    } {
        return {
            tab: '1. 概览',
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
            const mdFile = join(__dirname, `../../static`);
            const files = readdirSync(mdFile).map(file => file.replace(/\.md$/, ''));
            return files;
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
