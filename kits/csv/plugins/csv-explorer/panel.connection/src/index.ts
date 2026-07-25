import { CSV_CORE, unwrapCsvResponse, type CsvConnectionSnapshot, type CsvDelimiter, type CsvEncoding, type CsvOpenProgress, type CsvSampleResult } from '@itharbors/csv-contracts';

type PanelContext = { message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> }; panel: { setModalOpen(open: boolean): void } };
type FileEntry = { name: string; path: string; kind: 'directory' | 'file'; size: number | null; modifiedAt: string | null };
type FileDialog = { currentPath: string; parentPath: string | null; entries: FileEntry[] };
type PanelError = { message: string };
type OpenConfig = { path: string; encoding: CsvEncoding; delimiter: CsvDelimiter; hasHeader: boolean };
type PreviewIdentity = { path: string; encoding: CsvEncoding; delimiter: CsvDelimiter; generation: number };
const CLOSED: CsvConnectionSnapshot = { connectionRevision: 0, phase: 'closed', path: null, fileName: null, encoding: null, delimiter: null, hasHeader: null, progress: null, error: null, byteSize: null, rowCount: null, columnCount: null, irregularRowCount: null };
let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let snapshot: CsvConnectionSnapshot = { ...CLOSED };
let stableReady: CsvConnectionSnapshot | null = null;
let pendingAttemptRevision: number | null = null;
let sample: CsvSampleResult | null = null;
let config: OpenConfig | null = null;
let dialog: FileDialog | null = null;
let dialogOpener: string | null = null;
let error: PanelError | null = null;
let actionBusy = false;
let cancelling = false;
let previewRefreshing = false;
let previewSequence = 0;
let verifiedPreview: CsvSampleResult['preview'] | null = null;
let previewIdentity: PreviewIdentity | null = null;
let generation = 0;
let mountSequence = 0;

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx; root = document.querySelector('#panel-root'); if (!root) throw new Error('Panel root element #panel-root not found');
    generation += 1; mountSequence += 1; invalidatePreview(); snapshot = { ...CLOSED }; stableReady = null; pendingAttemptRevision = null; sample = null; config = null; dialog = null; dialogOpener = null; error = null; actionBusy = false; cancelling = false;
    window.addEventListener('keydown', handleKeydown); render();
    const ticket = mountSequence;
    try { const next = await requestCore<CsvConnectionSnapshot>('getConnectionState'); if (ticket === mountSequence) acceptConnection(next); }
    catch (caught) { if (ticket === mountSequence) { error = asError(caught); render(); } }
  },
  unmount() { generation += 1; mountSequence += 1; window.removeEventListener('keydown', handleKeydown); context?.panel.setModalOpen(false); root?.replaceChildren(); root = null; context = undefined; },
  methods: {
    onConnectionChanged(payload: unknown) { if (isSnapshot(payload)) { mountSequence += 1; acceptConnection(payload); } },
    onProgressChanged(payload: unknown) { if (isProgress(payload) && payload.connectionRevision === pendingAttemptRevision && snapshot.phase === 'indexing') { mountSequence += 1; snapshot = { ...snapshot, progress: payload.progress }; render(); } },
  },
};
export default definition;

function acceptConnection(next: CsvConnectionSnapshot): void {
  const rollback = snapshot.phase === 'indexing' && pendingAttemptRevision === snapshot.connectionRevision && stableReady?.connectionRevision === next.connectionRevision && next.phase === 'ready';
  if (next.connectionRevision < snapshot.connectionRevision && !rollback) return;
  if (next.phase === 'closed') { snapshot = { ...next }; stableReady = null; pendingAttemptRevision = null; sample = null; config = null; invalidatePreview(); error = null; render(); return; }
  snapshot = { ...next };
  if (next.phase === 'indexing') pendingAttemptRevision = next.connectionRevision;
  if (next.phase === 'ready') { stableReady = { ...next }; if (!rollback) syncConfig(next); if (next.connectionRevision === pendingAttemptRevision || rollback) pendingAttemptRevision = null; }
  if (next.error) error = { message: next.error.message }; else if (next.phase !== 'error') error = null;
  render();
}
function syncConfig(next: CsvConnectionSnapshot): void { if (next.path && next.encoding && next.delimiter && next.hasHeader !== null) config = { path: next.path, encoding: next.encoding, delimiter: next.delimiter, hasHeader: next.hasHeader }; }
function invalidatePreview(): void { previewSequence += 1; verifiedPreview = null; previewIdentity = null; previewRefreshing = false; }
function currentPreviewIdentity(generation: number): PreviewIdentity { if (!config) throw new Error('CSV 解析配置尚未准备好。'); return { path: config.path, encoding: config.encoding, delimiter: config.delimiter, generation }; }
function matchesCurrentPreview(identity: PreviewIdentity): boolean { return config !== null && identity.generation === previewSequence && identity.path === config.path && identity.encoding === config.encoding && identity.delimiter === config.delimiter; }
async function openBrowser(): Promise<void> {
  if (actionBusy) return; actionBusy = true; error = null; render(); const ticket = generation;
  try { const directory = await requestCore<string>('getDefaultDirectory'); const listing = await requestCore<FileDialog>('listDirectory', { path: directory, showAll: false }); if (ticket !== generation) return; dialog = listing; dialogOpener = 'browse'; context?.panel.setModalOpen(true); }
  catch (caught) { if (ticket === generation) error = asError(caught); }
  finally { if (ticket === generation) { actionBusy = false; render(); queueMicrotask(focusDialog); } }
}
async function browseDirectory(path: string): Promise<void> { if (actionBusy || !dialog) return; actionBusy = true; render(); const ticket = generation; try { const listing = await requestCore<FileDialog>('listDirectory', { path, showAll: false }); if (ticket === generation) dialog = listing; } catch (caught) { if (ticket === generation) error = asError(caught); } finally { if (ticket === generation) { actionBusy = false; render(); queueMicrotask(focusDialog); } } }
async function chooseFile(path: string): Promise<void> { if (actionBusy) return; invalidatePreview(); actionBusy = true; error = null; render(); const ticket = generation; try { const next = await requestCore<CsvSampleResult>('sampleFile', { path }); if (ticket !== generation) return; sample = next; config = { path: next.path, ...next.suggestion }; const identity = currentPreviewIdentity(++previewSequence); verifiedPreview = next.preview; previewIdentity = identity; actionBusy = false; closeDialog(true); } catch (caught) { if (ticket === generation) error = asError(caught); } finally { if (ticket === generation && actionBusy) { actionBusy = false; render(); } } }
async function openFile(): Promise<void> { if (actionBusy || !config) return; actionBusy = true; error = null; render(); const ticket = generation; try { const next = await requestCore<CsvConnectionSnapshot>('openFile', config); if (ticket === generation) acceptConnection(next); } catch (caught) { if (ticket === generation) { error = asError(caught); render(); } } finally { if (ticket === generation) { actionBusy = false; render(); } } }
async function cancelOpen(): Promise<void> { const revision = pendingAttemptRevision; if (revision === null || cancelling) return; cancelling = true; render(); const ticket = generation; try { await requestCore('cancelOpen', { connectionRevision: revision }); } catch (caught) { if (ticket === generation) error = asError(caught); } finally { if (ticket === generation) { cancelling = false; render(); } } }
async function closeFile(): Promise<void> { if (actionBusy) return; actionBusy = true; error = null; render(); const ticket = generation; try { await requestCore('closeFile'); const next = await requestCore<CsvConnectionSnapshot>('getConnectionState'); if (ticket === generation) acceptConnection(next); } catch (caught) { if (ticket === generation) error = asError(caught); } finally { if (ticket === generation) { actionBusy = false; render(); } } }
function render(): void {
  if (!root) return; const display = snapshot.phase === 'indexing' && stableReady ? stableReady : snapshot;
  root.innerHTML = `<main class="csv-connection"><section class="instrument-strip"${dialog ? ' inert aria-hidden="true"' : ''} aria-label="CSV 文件连接"><div class="identity"><span class="mark" aria-hidden="true">⌁</span><span><strong>CSV</strong><small>文件检查</small></span></div><div class="control file-control"><label for="csv-path">文件</label><div><code id="csv-path">${escapeHtml(config?.path ?? display.path ?? '尚未选择文件')}</code><button type="button" data-action="browse">选择文件</button></div></div><div class="control"><label for="csv-encoding">编码</label><select id="csv-encoding" data-field="encoding" ${config ? '' : 'disabled'}><option value="utf8" ${config?.encoding === 'utf8' ? 'selected' : ''}>UTF-8</option><option value="gb18030" ${config?.encoding === 'gb18030' ? 'selected' : ''}>GB18030</option></select></div><div class="control"><label for="csv-delimiter">分隔符</label><select id="csv-delimiter" data-field="delimiter" ${config ? '' : 'disabled'}><option value="," ${config?.delimiter === ',' ? 'selected' : ''}>逗号</option><option value="\t" ${config?.delimiter === '\t' ? 'selected' : ''}>制表符</option><option value=";" ${config?.delimiter === ';' ? 'selected' : ''}>分号</option></select></div><label class="toggle"><input type="checkbox" data-field="header" ${config?.hasHeader ? 'checked' : ''} ${config ? '' : 'disabled'}> 首行是字段名</label><div class="actions"><button type="button" class="primary" data-action="open" ${config && !actionBusy ? '' : 'disabled'}>打开</button>${snapshot.phase === 'indexing' ? `<button type="button" data-action="cancel" ${cancelling ? 'disabled' : ''}>取消</button>` : ''}<button type="button" data-action="close" ${display.phase === 'ready' && !actionBusy ? '' : 'disabled'}>关闭</button></div><div class="state" aria-live="polite">${renderState(display)}</div></section>${verifiedPreview && previewIdentity && matchesCurrentPreview(previewIdentity) ? renderRuler(verifiedPreview) : sample && previewRefreshing ? '<div class="preview-loading" role="status">正在更新解析预览</div>' : ''}${error ? `<div class="error" role="alert">${escapeHtml(error.message)}</div>` : ''}${dialog ? renderDialog(dialog) : ''}</main>`;
  bind('browse', openBrowser); bind('open', openFile); bind('cancel', cancelOpen); bind('close', closeFile); bind('parent', () => dialog?.parentPath && browseDirectory(dialog.parentPath)); bind('dismiss', () => closeDialog(true));
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-path]'))) button.addEventListener('click', () => button.dataset.kind === 'directory' ? void browseDirectory(button.dataset.filePath!) : void chooseFile(button.dataset.filePath!));
  root.querySelector<HTMLSelectElement>('[data-field="encoding"]')?.addEventListener('change', event => { if (config) { config.encoding = (event.currentTarget as HTMLSelectElement).value as CsvEncoding; void refreshPreview(); } }); root.querySelector<HTMLSelectElement>('[data-field="delimiter"]')?.addEventListener('change', event => { if (config) { config.delimiter = (event.currentTarget as HTMLSelectElement).value as CsvDelimiter; void refreshPreview(); } }); root.querySelector<HTMLInputElement>('[data-field="header"]')?.addEventListener('change', event => { if (config) { config.hasHeader = (event.currentTarget as HTMLInputElement).checked; render(); } });
}
async function refreshPreview(): Promise<void> { if (!sample || !config) return; const sequence = ++previewSequence; const identity = currentPreviewIdentity(sequence); const ticket = generation; verifiedPreview = null; previewIdentity = null; previewRefreshing = true; error = null; render(); try { const next = await requestCore<CsvSampleResult>('sampleFile', { path: identity.path, encoding: identity.encoding, delimiter: identity.delimiter }); if (ticket !== generation || sequence !== previewSequence || next.path !== identity.path || !matchesCurrentPreview(identity)) return; verifiedPreview = next.preview; previewIdentity = identity; previewRefreshing = false; render(); } catch (caught) { if (ticket === generation && sequence === previewSequence && matchesCurrentPreview(identity)) { previewRefreshing = false; error = asError(caught); render(); } } }
function renderState(display: CsvConnectionSnapshot): string { if (snapshot.phase === 'indexing') { const value = Math.round((snapshot.progress ?? 0) * 100); return `<span>正在建立索引</span><progress role="progressbar" aria-label="索引进度" value="${value}" max="100" aria-valuenow="${value}">${value}%</progress>${stableReady ? `<small>当前仍显示 ${escapeHtml(stableReady.fileName ?? '')}</small>` : ''}`; } if (display.phase === 'ready') return `<span class="success">已打开</span><code>${escapeHtml(display.fileName ?? '')}</code><small>${display.rowCount ?? 0} 行 · ${display.columnCount ?? 0} 列 · ${display.byteSize ?? 0} B${display.irregularRowCount ? ` · 不规则记录 ${display.irregularRowCount}` : ''}</small>`; return '<span>选择 CSV、TSV 或文本文件以开始检查</span>'; }
function renderRuler(value: CsvSampleResult['preview']): string { const delimiter = labelForDelimiter(config?.delimiter ?? ','); const glyph = glyphForDelimiter(config?.delimiter ?? ','); const cells = value.cells.map(cell => `<span>${escapeHtml(cell)}</span>`).join(` <b aria-hidden="true">${glyph}</b> `); const accessible = value.cells.join('；') || '空记录'; return `<div class="delimiter-ruler" data-delimiter-ruler tabindex="0" aria-label="分隔符标尺：${delimiter}；样本字段：${escapeHtml(accessible)}${value.truncated ? '（已截断）' : ''}">${cells}<small>${delimiter}${value.truncated ? ' · 已截断' : ''}</small></div>`; }
function renderDialog(value: FileDialog): string { return `<div class="backdrop"><section class="file-dialog" role="dialog" aria-modal="true" aria-label="选择 CSV 文件" tabindex="-1"><header><strong>选择文件</strong><code>${escapeHtml(value.currentPath)}</code></header><div class="file-list">${value.parentPath ? '<button type="button" data-action="parent">← 上一级</button>' : ''}${value.entries.map(entry => `<button type="button" data-file-path="${escapeHtml(entry.path)}" data-kind="${entry.kind}">${entry.kind === 'directory' ? '▸' : '≡'} ${escapeHtml(entry.name)}</button>`).join('') || '<p>这个文件夹中没有可选项目。</p>'}</div><footer><button type="button" data-action="dismiss">取消</button></footer></section></div>`; }
function closeDialog(restoreFocus: boolean): void { if (actionBusy) return; const opener = dialogOpener; dialog = null; dialogOpener = null; context?.panel.setModalOpen(false); render(); if (restoreFocus && opener) queueMicrotask(() => root?.querySelector<HTMLElement>(`[data-action="${opener}"]`)?.focus()); }
function handleKeydown(event: KeyboardEvent): void { if (!dialog) return; if (event.key === 'Escape') { event.preventDefault(); closeDialog(true); return; } if (event.key === 'Tab') trapDialog(event); }
function focusDialog(): void { const dialogRoot = root?.querySelector<HTMLElement>('[role="dialog"]'); const first = focusable(dialogRoot)[0]; (first ?? dialogRoot)?.focus(); }
function trapDialog(event: KeyboardEvent): void { const dialogRoot = root?.querySelector<HTMLElement>('[role="dialog"]'); const controls = focusable(dialogRoot); if (!dialogRoot || controls.length === 0) return; const first = controls[0]; const last = controls.at(-1)!; if (event.shiftKey && (document.activeElement === first || !dialogRoot.contains(document.activeElement))) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (document.activeElement === last || !dialogRoot.contains(document.activeElement))) { event.preventDefault(); first.focus(); } }
function focusable(parent: HTMLElement | null | undefined): HTMLElement[] { return parent ? Array.from(parent.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')) : []; }
function bind(action: string, callback: () => void | Promise<void>): void { root?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener('click', () => void callback()); }
async function requestCore<T>(method: string, input?: unknown): Promise<T> { if (!context) throw new Error('CSV 连接栏尚未挂载。'); return unwrapCsvResponse<T>(await context.message.request(CSV_CORE, method, input)); }
function isSnapshot(value: unknown): value is CsvConnectionSnapshot { return isRecord(value) && typeof value.connectionRevision === 'number' && ['closed', 'sampling', 'indexing', 'ready', 'error'].includes(String(value.phase)); }
function isProgress(value: unknown): value is CsvOpenProgress { return isRecord(value) && typeof value.connectionRevision === 'number' && typeof value.progress === 'number'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function asError(value: unknown): PanelError { return { message: value instanceof Error ? value.message : String(value) }; }
function escapeHtml(value: string): string { return value.replace(/[&<>\"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character); }
function labelForDelimiter(value: CsvDelimiter): string { return value === ',' ? '逗号' : value === '\t' ? '制表符' : '分号'; }
function glyphForDelimiter(value: CsvDelimiter): string { return value === ',' ? ',' : value === '\t' ? '⇥' : ';'; }
