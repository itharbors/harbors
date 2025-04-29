type TLayoutJSON = {
    ver: string;
    layout: TLayoutItem
};

type TLayoutItem = {
    dir: 'horizontal' | 'vertical' | 'none';
    type: 'fixed' | 'variable';
    panel?: string;
    size?: number;
    children?: TLayoutItem[];
};

export function injection() {
    if (document.getElementById('__layout__style__')) {
        return;
    }
    const $style = document.createElement('style');
    $style.setAttribute('id', '__layout__style__');
    $style.innerHTML = `
section.layout { display: flex; flex: 1; }
section.layout[dir=none] > * { flex: 1; }
section.layout[dir=vertical] { flex-direction: column; }
section.layout[dir=horizontal] { flex-direction: row; }
section.layout[tpye=fixed] { flex: none; }
section.layout[tpye=variable] { flex: 1; }
    `;
    document.head.append($style);
}

export function parse(json: TLayoutJSON): HTMLElement {
    return parseItem(json.layout);
}

function parseItem(item: TLayoutItem): HTMLElement {
    const $item = document.createElement('section');
    $item.classList.add('layout');
    $item.setAttribute('dir', item.dir);
    $item.setAttribute('type', item.type);
    if (item.children) {
        for (let child of item.children) {
            const $child = parseItem(child);
            $item.appendChild($child);
            if (child.dir === 'none' && child.type === 'fixed') {
                if (item.dir === 'vertical') {
                    $child.style.flex = 'none';
                    $child.style.height = `${child.size}px`;
                } else if (item.dir === 'horizontal') {
                    $child.style.flex = 'none';
                    $child.style.width = `${child.size}px`;
                }
            }
        }
    } else if (item.panel) {
        const $panel = document.createElement('ui-panel');
        $panel.setAttribute('name', item.panel);
        $item.appendChild($panel);
    }
    return $item;
}
