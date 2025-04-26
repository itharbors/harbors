import { join } from 'path';
import { generateModule } from '@itharbors/module';
import { WebviewTag } from 'electron';

let converter = async function(url: string) {
    return url;
}

/**
 * Panel 元素
 */
class Panel extends HTMLElement {
    // 定义要观察的属性
    static get observedAttributes() {
        return ['src'];
    }

    private _$shadow: ShadowRoot;
    // private _$content!: HTMLIFrameElement;
    private _$content!: WebviewTag;
    private _$style!: HTMLStyleElement;

    constructor() {
        super();

        // 创建一个影子 DOM
        this._$shadow = this.attachShadow({ mode: 'open' });

        // 创建一个 iframe 元素
        this._$content = document.createElement('webview');
        this._$content.setAttribute('preload', join(__dirname, '../../preload/dist/index.js'));
        this._$content.setAttribute('webPreferences', 'webgl=1,nativeWindowOpen=1,contextIsolation=0,backgroundThrottling=0');
        // this._$content.setAttribute('contextIsolation', 'false');
        // this._$content.setAttribute('nodeintegration', 'true');
        // this._$content.setAttribute('nodeintegrationinsubframes', 'true');
        this._$content.setAttribute('enableremotemodule', 'true');
        this._$content.setAttribute('disablewebsecurity', 'true');
        this._$content.setAttribute('allowpopups', 'true');
        this._$content.addEventListener('ipc-message', (event) => {
            // TODO
        });
        this._$content.addEventListener('did-finish-load', () => {
            const name = this.getAttribute('name') || '';
            const pluginName = name.replace(/\.[^\.]+$/, '');
            this._$content.send('init', pluginName);
        });

        // 创建一个样式元素
        this._$style = document.createElement('style');
        this._$style.textContent = `
            iframe, webview {
                border: none;
                height: 100%;
                width: 100%;
            }
        `;

        // 将样式和段落元素添加到影子 DOM 中
        this._$shadow.appendChild(this._$style);
        this._$shadow.appendChild(this._$content);
    }

    // 当元素被插入到文档中时调用
    connectedCallback() {
        this.updateContent();
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
        // const pluginName = name.replace(/\.^[\.]+$/, '');
        // this._$content.send('init', pluginName);
        const url = await converter(name);
        this._$content.src = url;
    }
}

// 定义自定义元素的标签名
customElements.define('ui-panel', Panel);

export function convertURL(handle: (url: string) => Promise<string>) {
    converter = handle;
}
