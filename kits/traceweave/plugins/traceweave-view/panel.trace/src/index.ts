let root: HTMLElement | null = null;

export default {
  mount() {
    root = document.querySelector('#traceweave-root');
    if (root) root.textContent = 'TraceWeave';
  },
  unmount() {
    if (root) root.textContent = '';
    root = null;
  },
};
