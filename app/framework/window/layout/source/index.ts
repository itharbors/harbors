// import type { sendOption } from './public';

import { readFileSync } from 'fs';
import { join } from 'path';
import { WebviewTag, ipcRenderer } from 'electron';

import { parse, injection } from './layout';

const map: Map<string, Layout> = new Map();

/**
 * Layout 元素
 */
class Layout extends HTMLElement {

    private _name: string = '';

    // 定义要观察的属性
    static get observedAttributes() {
        return ['name'];
    }

    private _$shadow: ShadowRoot;
    private _$style!: HTMLStyleElement;
    private _$slot!: HTMLSlotElement;

    constructor() {
        super();

        // 创建一个影子 DOM
        this._$shadow = this.attachShadow({ mode: 'open' });

        this._$style = document.createElement('style');
        this._$style.innerHTML = `
:host { display: flex; }
        `;
        this._$slot = document.createElement('slot');

        // 将样式和段落元素添加到影子 DOM 中
        this._$shadow.appendChild(this._$style);
        this._$shadow.appendChild(this._$slot);
    }

    // 当元素被插入到文档中时调用
    connectedCallback() {
        this.updateContent();
    }

    disconnectedCallback() {
        const name = this.getAttribute('name') || '';
        map.delete(name);
    }

    // 当观察的属性发生变化时调用
    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
        if (oldValue !== newValue) {
            this.updateContent();
        }
    }

    // 更新元素内容的方法
    async updateContent() {
        const name = this.getAttribute('name') || '';
        map.set(name, this);
        if (this._name === name) {
            return;
        }
        this._name = name;
        ipcRenderer.once('kit:query-layout-reply', (event, path) => {
            if (this._name !== name) {
                return;
            }
            injection();
            const layout = JSON.parse(readFileSync(path, 'utf8'));
            const $elem = parse(layout);
            this.appendChild($elem);
        });
        ipcRenderer.send('kit:query-layout', name);
    }
}

// 定义自定义元素的标签名
customElements.define('ui-layout', Layout);
