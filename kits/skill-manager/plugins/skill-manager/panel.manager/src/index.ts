type PanelContext = {
  message: {
    request(plugin: string, method: string, input?: unknown): Promise<unknown>;
  };
};

type SkillStatus =
  | 'source-only'
  | 'current'
  | 'update-available'
  | 'global-only'
  | 'disabled'
  | 'trashed'
  | 'protected'
  | 'conflict'
  | 'invalid';

type SkillAction = 'install' | 'update' | 'disable' | 'uninstall' | 'restore';

type SkillItem = {
  id: string;
  name: string;
  description: string;
  basename: string;
  status: SkillStatus;
  actions: SkillAction[];
  sourceDigest: string | null;
  globalDigest: string | null;
  recoveryDigest: string | null;
  protected: boolean;
  diagnostics: Array<{ code: string; message: string; relativePath?: string }>;
};

type Snapshot = {
  revision: number;
  generation: number;
  mode: 'global' | 'source';
  globalRootLabel: string;
  sourceRootLabel: string | null;
  scanning: boolean;
  truncated: boolean;
  counts: Record<SkillStatus, number>;
  items: SkillItem[];
  diagnostics: Array<{ code: string; message: string; relativePath?: string }>;
};

type DetailLocation = {
  origin: string;
  basename: string;
  manifest: { name: string; description: string };
  digest: string;
  text: string;
};

type SkillDetail = {
  id: string;
  revision: number;
  name: string;
  description: string;
  status: SkillStatus;
  diagnostics: Array<{ code: string; message: string; relativePath?: string }>;
  source: DetailLocation | null;
  global: DetailLocation | null;
  recovery: DetailLocation | null;
};

type DirectoryPage = {
  current: { id: string; label: string };
  parentId?: string;
  children: Array<{ id: string; name: string }>;
};

type DialogState =
  | { kind: 'directory'; invoker: HTMLElement; loading: boolean }
  | { kind: 'action'; invoker: HTMLElement; action: SkillAction; itemId: string };

const PLUGIN = '@itharbors/skill-manager';
const STATUS_ORDER: SkillStatus[] = [
  'source-only',
  'update-available',
  'global-only',
  'current',
  'disabled',
  'trashed',
  'protected',
  'conflict',
  'invalid',
];
const STATUS_LABELS: Record<SkillStatus, string> = {
  'source-only': 'Source only',
  current: 'Current',
  'update-available': 'Update available',
  'global-only': 'Global only',
  disabled: 'Disabled',
  trashed: 'Trash',
  protected: 'Protected',
  conflict: 'Conflict',
  invalid: 'Invalid',
};
const ACTION_LABELS: Record<SkillAction, string> = {
  install: 'Install',
  update: 'Update',
  disable: 'Disable',
  uninstall: 'Uninstall',
  restore: 'Restore',
};

let context: PanelContext | null = null;
let root: HTMLElement | null = null;
let mounted = false;
let lifecycle = 0;
let requestGeneration = 0;
let detailGeneration = 0;
let browserGeneration = 0;
let snapshot: Snapshot | null = null;
let selectedId: string | null = null;
let detail: SkillDetail | null = null;
let detailLoading = false;
let filter: 'all' | SkillStatus = 'all';
let query = '';
let browser: DirectoryPage | null = null;
let dialog: DialogState | null = null;
let pendingAction: SkillAction | null = null;
let error: string | null = null;
let liveMessage = 'Skill Manager ready';

const definition = {
  async mount(ctx: PanelContext) {
    lifecycle += 1;
    requestGeneration += 1;
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    mounted = true;
    resetState();
    renderLoading();
    const generation = ++requestGeneration;
    try {
      const value = await request('getSnapshot');
      if (!isCurrentRequest(generation)) return;
      applySnapshot(normalizeSnapshot(value));
    } catch (caught) {
      if (!isCurrentRequest(generation)) return;
      error = errorMessage(caught);
      render();
    }
  },

  unmount() {
    mounted = false;
    lifecycle += 1;
    requestGeneration += 1;
    detailGeneration += 1;
    browserGeneration += 1;
    root?.replaceChildren();
    root = null;
    context = null;
    resetState();
  },

  methods: {
    onSnapshotChanged(payload: unknown) {
      const next = trySnapshot(payload);
      if (!next || (snapshot && next.revision <= snapshot.revision)) return;
      applySnapshot(next);
    },
    onScanProgress(payload: unknown) {
      const value = asRecord(payload);
      if (value?.state === 'started') setLiveMessage('Scanning Skill directories');
      if (value?.state === 'completed') setLiveMessage('Skill scan completed');
      if (value?.state === 'failed') setLiveMessage('Skill scan failed');
    },
    onOperationProgress(payload: unknown) {
      const value = asRecord(payload);
      const action = typeof value?.action === 'string' ? value.action : 'Action';
      if (value?.state === 'started') setLiveMessage(`${capitalize(action)} started`);
      if (value?.state === 'completed') setLiveMessage(`${capitalize(action)} completed`);
      if (value?.state === 'failed') setLiveMessage(`${capitalize(action)} failed`);
    },
  },
};

export default definition;

function resetState(): void {
  snapshot = null;
  selectedId = null;
  detail = null;
  detailLoading = false;
  filter = 'all';
  query = '';
  browser = null;
  dialog = null;
  pendingAction = null;
  error = null;
  liveMessage = 'Skill Manager ready';
}

function applySnapshot(next: Snapshot): void {
  snapshot = next;
  requestGeneration += 1;
  error = null;
  const retained = selectedId && next.items.some((item) => item.id === selectedId)
    ? selectedId
    : next.items[0]?.id ?? null;
  if (retained !== selectedId || detail?.revision !== next.revision) detail = null;
  selectedId = retained;
  render();
  if (selectedId) void loadDetail(selectedId, next.revision);
}

async function loadDetail(skillId: string, revision: number): Promise<void> {
  const generation = ++detailGeneration;
  detailLoading = true;
  renderDetailOnly();
  try {
    const value = await request('getSkillDetail', { skillId, revision });
    if (
      !mounted
      || generation !== detailGeneration
      || selectedId !== skillId
      || snapshot?.revision !== revision
    ) return;
    detail = normalizeDetail(value);
    error = null;
  } catch (caught) {
    if (generation !== detailGeneration || selectedId !== skillId) return;
    error = errorMessage(caught);
  } finally {
    if (generation === detailGeneration) {
      detailLoading = false;
      renderDetailOnly();
    }
  }
}

function selectSkill(skillId: string, focusRow = false): void {
  if (!snapshot?.items.some((item) => item.id === skillId)) return;
  selectedId = skillId;
  detail = null;
  detailGeneration += 1;
  render();
  if (focusRow) root?.querySelector<HTMLElement>(`[data-skill-id="${cssEscape(skillId)}"]`)?.focus();
  void loadDetail(skillId, snapshot.revision);
}

function renderLoading(): void {
  if (!root) return;
  const shell = element('main', 'manager-shell loading-shell');
  const bar = element('div', 'loading-bar');
  const columns = element('div', 'loading-columns');
  columns.append(element('div', 'loading-block'), element('div', 'loading-block'), element('div', 'loading-block'));
  shell.append(bar, columns);
  root.replaceChildren(shell);
}

function render(): void {
  if (!root) return;
  const shell = element('main', 'manager-shell');
  shell.append(createToolbar(), createWorkspace(), createLiveRegion());
  root.replaceChildren(shell);
  if (dialog) appendDialog();
}

function createToolbar(): HTMLElement {
  const header = element('header', 'manager-toolbar');
  const identity = element('div', 'manager-identity');
  const title = document.createElement('h1');
  title.textContent = 'Skill Manager';
  const subtitle = document.createElement('p');
  subtitle.textContent = 'Inspect global Skills or compare a source folder.';
  identity.append(title, subtitle);

  const controls = element('div', 'toolbar-controls');
  const mode = element('span', 'mode-label');
  mode.dataset.mode = '';
  mode.textContent = snapshot?.mode === 'source'
    ? `Source: ${snapshot.sourceRootLabel ?? 'selected folder'}`
    : 'Global Skills';
  const choose = button('Choose source', 'choose-source', (event) => {
    void openDirectoryBrowser(event.currentTarget as HTMLElement);
  });
  const rescan = button('Rescan', 'rescan', () => { void runSimpleSnapshotRequest('rescan'); });
  controls.append(mode, choose);
  if (snapshot?.mode === 'source') {
    controls.append(button('Clear source', 'clear-source', () => {
      void runSimpleSnapshotRequest('clearSource');
    }));
  }
  controls.append(rescan);
  setDisabled(controls, pendingAction !== null);
  header.append(identity, controls);
  return header;
}

function createWorkspace(): HTMLElement {
  const workspace = element('div', 'workspace-grid');
  workspace.append(createFilterRail(), createSkillColumn(), createDetailPane());
  return workspace;
}

function createFilterRail(): HTMLElement {
  const rail = element('aside', 'filter-rail');
  rail.setAttribute('aria-label', 'Status filters');
  const heading = document.createElement('h2');
  heading.textContent = 'Status';
  rail.append(heading, filterButton('All Skills', 'all', snapshot?.items.length ?? 0));
  for (const status of STATUS_ORDER) {
    rail.append(filterButton(STATUS_LABELS[status], status, snapshot?.counts[status] ?? 0));
  }
  return rail;
}

function filterButton(label: string, value: 'all' | SkillStatus, count: number): HTMLButtonElement {
  const control = button('', undefined, () => {
    filter = value;
    render();
  });
  control.className = `filter-control${filter === value ? ' is-active' : ''}`;
  control.dataset.filter = value;
  control.setAttribute('aria-pressed', String(filter === value));
  const name = document.createElement('span');
  name.textContent = label;
  const number = document.createElement('span');
  number.className = 'filter-count';
  number.textContent = String(count);
  control.append(name, number);
  return control;
}

function createSkillColumn(): HTMLElement {
  const column = element('section', 'skill-column');
  column.setAttribute('aria-label', 'Skills');
  const header = element('div', 'list-header');
  const label = document.createElement('label');
  label.textContent = 'Search Skills';
  const search = document.createElement('input');
  search.type = 'search';
  search.value = query;
  search.placeholder = 'Name or description';
  search.dataset.search = '';
  search.disabled = pendingAction !== null;
  search.addEventListener('input', () => {
    query = search.value;
    render();
    const next = root?.querySelector<HTMLInputElement>('[data-search]');
    next?.focus();
    next?.setSelectionRange(query.length, query.length);
  });
  label.append(search);
  header.append(label);

  const list = element('div', 'skill-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Skill results');
  if (!snapshot && error) {
    const failure = element('section', 'empty-state error-state');
    failure.dataset.state = 'error';
    const heading = document.createElement('h2');
    heading.textContent = 'Could not load Skills';
    const copy = document.createElement('p');
    copy.textContent = error;
    failure.append(
      heading,
      copy,
      button('Try again', 'retry', () => { void runSimpleSnapshotRequest('rescan'); }),
    );
    list.append(failure);
    column.append(header, list);
    return column;
  }
  const visible = visibleItems();
  if (visible.length === 0) {
    const empty = element('section', 'empty-state');
    empty.dataset.state = 'empty';
    const heading = document.createElement('h2');
    heading.textContent = snapshot?.items.length ? 'No matching Skills' : 'No Skills found';
    const copy = document.createElement('p');
    copy.textContent = snapshot?.mode === 'source'
      ? 'Choose another source folder or clear the current source.'
      : 'Add a Skill to $CODEX_HOME/skills or choose a source folder.';
    empty.append(heading, copy);
    list.append(empty);
  } else {
    for (const item of visible) list.append(createSkillRow(item, visible));
  }
  column.append(header, list);
  return column;
}

function createSkillRow(item: SkillItem, visible: SkillItem[]): HTMLButtonElement {
  const row = button('', undefined, () => selectSkill(item.id));
  row.className = `skill-row status-${item.status}${item.id === selectedId ? ' is-selected' : ''}`;
  row.dataset.skillId = item.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(item.id === selectedId));
  row.disabled = pendingAction !== null;
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = visible.findIndex((candidate) => candidate.id === item.id);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index + offset))];
    if (next) selectSkill(next.id, true);
  });
  const top = element('span', 'skill-row-top');
  const name = element('strong', 'skill-name');
  name.textContent = item.name;
  const status = element('span', 'status-label');
  status.textContent = STATUS_LABELS[item.status];
  top.append(name, status);
  const description = element('span', 'skill-description');
  description.textContent = item.description || 'No description';
  row.append(top, description);
  return row;
}

function createDetailPane(): HTMLElement {
  const pane = element('aside', 'detail-pane');
  pane.setAttribute('aria-label', 'Skill detail');
  pane.dataset.detailPane = '';
  pane.append(detailContent());
  return pane;
}

function renderDetailOnly(): void {
  const pane = root?.querySelector<HTMLElement>('[data-detail-pane]');
  if (!pane) return;
  pane.replaceChildren(detailContent());
}

function detailContent(): HTMLElement {
  const content = element('div', 'detail-content');
  const item = selectedItem();
  if (!item) {
    const empty = element('section', 'detail-empty');
    const heading = document.createElement('h2');
    heading.textContent = 'Select a Skill';
    const copy = document.createElement('p');
    copy.textContent = 'Manifest, digest, source text, and actions appear here.';
    empty.append(heading, copy);
    return empty;
  }
  if (detailLoading && (!detail || detail.id !== item.id)) {
    const loading = element('section', 'detail-loading');
    loading.append(element('div', 'detail-loading-line'), element('div', 'detail-loading-line short'));
    return loading;
  }
  if (!detail || detail.id !== item.id) {
    const unavailable = element('section', 'detail-empty');
    const heading = document.createElement('h2');
    heading.textContent = item.name;
    const copy = document.createElement('p');
    copy.textContent = error ?? 'Detail is unavailable.';
    unavailable.append(heading, copy);
    return unavailable;
  }

  const header = element('header', 'detail-header');
  const status = element('span', 'status-label');
  status.textContent = STATUS_LABELS[detail.status];
  const title = document.createElement('h2');
  title.dataset.detailName = '';
  title.textContent = detail.name;
  const description = document.createElement('p');
  description.textContent = detail.description || 'No description';
  header.append(status, title, description);

  const actions = element('div', 'detail-actions');
  for (const action of item.actions) {
    const control = button(ACTION_LABELS[action], action, (event) => {
      openActionDialog(action, item.id, event.currentTarget as HTMLElement);
    });
    control.className = action === 'uninstall' ? 'danger-button' : 'action-button';
    control.disabled = pendingAction !== null;
    actions.append(control);
  }
  content.append(header);
  if (item.actions.length > 0) content.append(actions);

  for (const [label, location] of [
    ['Source', detail.source],
    ['Global', detail.global],
    ['Recovery', detail.recovery],
  ] as const) {
    if (location) content.append(createLocation(label, location));
  }
  const diagnostics = [...item.diagnostics, ...detail.diagnostics];
  if (diagnostics.length) content.append(createDiagnostics(diagnostics));
  return content;
}

function createLocation(label: string, location: DetailLocation): HTMLElement {
  const section = element('section', 'location-section');
  const heading = document.createElement('h3');
  heading.textContent = label;
  const meta = element('dl', 'location-meta');
  appendDefinition(meta, 'Folder', location.basename);
  appendDefinition(meta, 'Digest', location.digest.slice(0, 12));
  const source = document.createElement('pre');
  source.textContent = location.text;
  source.tabIndex = 0;
  source.setAttribute('aria-label', `${label} SKILL.md source`);
  section.append(heading, meta, source);
  return section;
}

function createDiagnostics(diagnostics: SkillItem['diagnostics']): HTMLElement {
  const section = element('section', 'diagnostics');
  const heading = document.createElement('h3');
  heading.textContent = 'Diagnostics';
  section.append(heading);
  for (const diagnostic of diagnostics) {
    const item = document.createElement('p');
    item.textContent = `${diagnostic.code}: ${diagnostic.message}`;
    section.append(item);
  }
  return section;
}

function createLiveRegion(): HTMLElement {
  const region = element('div', 'live-region');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.textContent = liveMessage;
  return region;
}

function setLiveMessage(message: string): void {
  liveMessage = message;
  const region = root?.querySelector<HTMLElement>('[aria-live="polite"]');
  if (region) region.textContent = message;
}

async function openDirectoryBrowser(invoker: HTMLElement): Promise<void> {
  dialog = { kind: 'directory', invoker, loading: true };
  browser = null;
  appendDialog();
  const generation = ++browserGeneration;
  try {
    const value = await request('browseDirectory', {});
    if (generation !== browserGeneration || dialog?.kind !== 'directory') return;
    browser = normalizeDirectoryPage(value);
    dialog.loading = false;
    replaceDialog();
  } catch (caught) {
    if (generation !== browserGeneration) return;
    error = errorMessage(caught);
    closeDialog(true);
  }
}

async function navigateDirectory(directoryId: string): Promise<void> {
  if (dialog?.kind !== 'directory') return;
  dialog.loading = true;
  replaceDialog();
  const generation = ++browserGeneration;
  try {
    const value = await request('browseDirectory', { directoryId });
    if (generation !== browserGeneration || dialog?.kind !== 'directory') return;
    browser = normalizeDirectoryPage(value);
    dialog.loading = false;
    replaceDialog();
  } catch (caught) {
    error = errorMessage(caught);
    closeDialog(true);
  }
}

async function selectBrowserDirectory(): Promise<void> {
  if (dialog?.kind !== 'directory' || !browser) return;
  setDialogDisabled(true);
  try {
    const value = await request('selectSource', { directoryId: browser.current.id });
    closeDialog(false);
    applySnapshot(normalizeSnapshot(value));
    setLiveMessage('Source folder selected');
  } catch (caught) {
    error = errorMessage(caught);
    closeDialog(true);
    render();
  }
}

function openActionDialog(action: SkillAction, itemId: string, invoker: HTMLElement): void {
  dialog = { kind: 'action', action, itemId, invoker };
  appendDialog();
}

async function confirmAction(): Promise<void> {
  if (dialog?.kind !== 'action' || !snapshot || pendingAction) return;
  const { action, itemId } = dialog;
  const item = snapshot.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const expectedDigest = digestForAction(item, action);
  if (!expectedDigest) return;
  pendingAction = action;
  setDialogDisabled(true);
  root?.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((control) => {
    control.disabled = true;
  });
  try {
    const value = await request('performAction', {
      action,
      skillId: item.id,
      revision: snapshot.revision,
      expectedDigest,
    });
    const result = asRecord(value);
    pendingAction = null;
    closeDialog(false);
    applySnapshot(normalizeSnapshot(result?.snapshot));
    setLiveMessage(`${ACTION_LABELS[action]} completed`);
  } catch (caught) {
    pendingAction = null;
    error = errorMessage(caught);
    closeDialog(true);
    render();
    setLiveMessage(`${ACTION_LABELS[action]} failed`);
  }
}

async function runSimpleSnapshotRequest(method: 'rescan' | 'clearSource'): Promise<void> {
  if (pendingAction) return;
  const generation = ++requestGeneration;
  setLiveMessage(method === 'rescan' ? 'Scanning Skill directories' : 'Clearing source folder');
  try {
    const value = await request(method);
    if (!isCurrentRequest(generation)) return;
    applySnapshot(normalizeSnapshot(value));
  } catch (caught) {
    if (!isCurrentRequest(generation)) return;
    error = errorMessage(caught);
    render();
  }
}

function appendDialog(): void {
  root?.querySelector('[data-dialog-overlay]')?.remove();
  if (!root || !dialog) return;
  const overlay = element('div', 'dialog-overlay');
  overlay.dataset.dialogOverlay = '';
  const modal = element('section', 'dialog');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.addEventListener('keydown', trapDialogFocus);
  if (dialog.kind === 'directory') modal.append(directoryDialogContent());
  else modal.append(actionDialogContent(dialog));
  overlay.append(modal);
  root.append(overlay);
  focusFirstDialogControl(modal);
}

function replaceDialog(): void {
  appendDialog();
}

function directoryDialogContent(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const header = element('header', 'dialog-header');
  const title = document.createElement('h2');
  title.textContent = 'Choose source folder';
  const copy = document.createElement('p');
  copy.textContent = 'Only folders discovered in this session can be selected.';
  header.append(title, copy);
  fragment.append(header);
  if (dialog?.kind === 'directory' && dialog.loading) {
    const loading = element('div', 'browser-loading');
    loading.textContent = 'Loading folders';
    fragment.append(loading);
  } else if (browser) {
    const current = element('p', 'current-directory');
    current.dataset.currentDirectory = '';
    current.textContent = browser.current.label;
    const list = element('div', 'directory-list');
    if (browser.parentId) {
      const parent = button('Parent folder', 'parent-directory', () => {
        void navigateDirectory(browser!.parentId!);
      });
      list.append(parent);
    }
    for (const child of browser.children) {
      const control = button(child.name, undefined, () => { void navigateDirectory(child.id); });
      control.dataset.directoryId = child.id;
      list.append(control);
    }
    fragment.append(current, list);
  }
  const actions = element('div', 'dialog-actions');
  actions.append(
    button('Cancel', 'cancel', () => closeDialog(true)),
    button('Use this folder', 'use-directory', () => { void selectBrowserDirectory(); }),
  );
  const use = actions.querySelector<HTMLButtonElement>('[data-action="use-directory"]');
  if (use) use.disabled = !browser || dialog?.kind !== 'directory' || dialog.loading;
  fragment.append(actions);
  return fragment;
}

function actionDialogContent(value: Extract<DialogState, { kind: 'action' }>): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const item = snapshot?.items.find((candidate) => candidate.id === value.itemId);
  const title = document.createElement('h2');
  title.textContent = `${ACTION_LABELS[value.action]} ${item?.name ?? 'Skill'}?`;
  const copy = document.createElement('p');
  copy.textContent = confirmationCopy(value.action);
  const actions = element('div', 'dialog-actions');
  actions.append(
    button('Cancel', 'cancel', () => closeDialog(true)),
    button(ACTION_LABELS[value.action], 'confirm', () => { void confirmAction(); }),
  );
  fragment.append(title, copy, actions);
  return fragment;
}

function closeDialog(restoreFocus: boolean): void {
  const invoker = dialog?.invoker;
  dialog = null;
  browserGeneration += 1;
  root?.querySelector('[data-dialog-overlay]')?.remove();
  if (restoreFocus && invoker?.isConnected) invoker.focus();
}

function trapDialogFocus(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog(true);
    return;
  }
  if (event.key !== 'Tab') return;
  const modal = event.currentTarget as HTMLElement;
  const controls = focusableControls(modal);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  }
}

function focusFirstDialogControl(modal: HTMLElement): void {
  focusableControls(modal)[0]?.focus();
}

function focusableControls(rootElement: HTMLElement): HTMLElement[] {
  return Array.from(rootElement.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
}

function setDialogDisabled(disabled: boolean): void {
  root?.querySelectorAll<HTMLButtonElement>('[role="dialog"] button').forEach((control) => {
    control.disabled = disabled;
  });
}

function setDisabled(container: HTMLElement, disabled: boolean): void {
  container.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((control) => {
    control.disabled = disabled;
  });
}

function visibleItems(): SkillItem[] {
  if (!snapshot) return [];
  const needle = query.trim().toLocaleLowerCase();
  return snapshot.items.filter((item) => (
    (filter === 'all' || item.status === filter)
    && (!needle || `${item.name}\n${item.description}`.toLocaleLowerCase().includes(needle))
  ));
}

function selectedItem(): SkillItem | null {
  return snapshot?.items.find((item) => item.id === selectedId) ?? null;
}

function digestForAction(item: SkillItem, action: SkillAction): string | null {
  if (action === 'install') return item.sourceDigest;
  if (action === 'restore') return item.recoveryDigest;
  return item.globalDigest;
}

function confirmationCopy(action: SkillAction): string {
  if (action === 'install') return 'Copy this source Skill into the global Skills folder.';
  if (action === 'update') return 'Replace the global Skill after preserving a rollback backup.';
  if (action === 'disable') return 'Move this Skill into the recoverable disabled area.';
  if (action === 'uninstall') return 'Move this Skill into recoverable trash. Nothing is permanently deleted.';
  return 'Restore this Skill to its original global folder.';
}

function normalizeSnapshot(value: unknown): Snapshot {
  const record = asRecord(value);
  if (!record || !Number.isSafeInteger(record.revision) || !Array.isArray(record.items)) {
    throw new Error('Skill Manager returned an invalid snapshot');
  }
  return value as Snapshot;
}

function trySnapshot(value: unknown): Snapshot | null {
  try {
    return normalizeSnapshot(value);
  } catch {
    return null;
  }
}

function normalizeDetail(value: unknown): SkillDetail {
  const record = asRecord(value);
  if (!record || typeof record.id !== 'string' || typeof record.name !== 'string') {
    throw new Error('Skill Manager returned invalid detail');
  }
  return value as SkillDetail;
}

function normalizeDirectoryPage(value: unknown): DirectoryPage {
  const record = asRecord(value);
  const current = asRecord(record?.current);
  if (!current || typeof current.id !== 'string' || typeof current.label !== 'string' || !Array.isArray(record?.children)) {
    throw new Error('Skill Manager returned an invalid directory page');
  }
  return value as DirectoryPage;
}

function isCurrentRequest(generation: number): boolean {
  return mounted && generation === requestGeneration;
}

function request(method: string, input?: unknown): Promise<unknown> {
  if (!context) throw new Error('Skill Manager panel is not mounted');
  return context.message.request(PLUGIN, method, input);
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.className = className;
  return value;
}

function button(
  label: string,
  action: string | undefined,
  handler: (event: MouseEvent) => void,
): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = label;
  if (action) control.dataset.action = action;
  control.addEventListener('click', handler);
  return control;
}

function appendDefinition(list: HTMLDListElement, term: string, description: string): void {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = description;
  list.append(dt, dd);
}

function capitalize(value: string): string {
  return value.length ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape ? CSS.escape(value) : value.replaceAll('"', '\\"');
}
