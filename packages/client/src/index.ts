import './styles/tokens.css';

import './layout/split-pane';
import './layout/divider';
import './layout/panel';
import './layout/panel-group';
import './layout/tabs';

import './components/editor-app';
import './components/window-group-app';

const app = document.querySelector('#app');

if (app && app.childElementCount === 0) {
  app.innerHTML = '<editor-app></editor-app>';
}
