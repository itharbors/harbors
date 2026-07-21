import './styles/tokens.css';

import './layout/split-pane';
import './layout/divider';
import './layout/panel';
import './layout/panel-group';
import './layout/tabs';

import './components/editor-app';
import './components/window-group-app';
import {
  renderKitPicker,
  renderKitPickerError,
  renderKitPickerLoading,
} from './components/kit-picker';
import { isKitCatalogResponse, selectHostEntry } from './core/host-entry';

const app = document.querySelector('#app');

export async function startClientApp(): Promise<void> {
  if (!(app instanceof HTMLElement)) return;
  renderKitPickerLoading(app);
  try {
    const response = await fetch('/api/kits', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Kit catalog request failed: ${response.status}`);
    const catalog: unknown = await response.json();
    if (!isKitCatalogResponse(catalog)) throw new Error('Kit catalog response is invalid');

    if (selectHostEntry(catalog.mode, new URL(window.location.href)) === 'editor') {
      app.innerHTML = '<editor-app></editor-app>';
      return;
    }
    renderKitPicker(app, catalog.kits);
  } catch {
    renderKitPickerError(app, () => void startClientApp());
  }
}

void startClientApp();
