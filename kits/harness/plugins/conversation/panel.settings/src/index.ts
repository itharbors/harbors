type MessageRequest = (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;
type Archived = { id: string; source: 'harbors'; title: string; project?: string; updatedAt?: string; archivedAt: string; status: 'available' | 'unavailable'; errorCode?: string };
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

let request: MessageRequest | null = null;
let activeDocument: Document | null = null;
let generation = 0;
const busy = new Set<string>();
let archivedItems: Archived[] = [];

function status(message: string, kind: 'loading' | 'success' | 'error' = 'loading', retry = false): void {
  const node = activeDocument?.getElementById('status');
  if (!node) return;
  node.textContent = message; node.dataset.kind = kind; node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const retryButton = activeDocument?.getElementById('retry') as HTMLButtonElement | null;
  if (retryButton) retryButton.hidden = !retry;
}
function formatTime(value: string | undefined): string { if (!value) return '未知'; const time = new Date(value); return Number.isNaN(time.valueOf()) ? '未知' : time.toLocaleString('zh-CN'); }
function resultOf<T>(value: unknown): Result<T> {
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') throw new Error('归档协议不可用');
  return value as Result<T>;
}
function render(items: Archived[]): void {
  const list = activeDocument?.getElementById('archive-list'); if (!list) return;
  list.replaceChildren();
  if (!items.length) { const empty = activeDocument!.createElement('p'); empty.className = 'empty'; empty.textContent = '暂无归档对话'; list.append(empty); return; }
  for (const item of items) {
    const card = activeDocument!.createElement('article'); card.className = 'archive-card';
    const title = activeDocument!.createElement('h2'); title.textContent = item.title; card.append(title);
    const meta = activeDocument!.createElement('dl'); meta.className = 'archive-meta';
    for (const [label, value] of [['项目', item.project || '未归类'], ['来源', item.source === 'harbors' ? 'Harbors' : item.source], ['更新时间', formatTime(item.updatedAt)], ['归档时间', formatTime(item.archivedAt)]]) {
      const dt = activeDocument!.createElement('dt'); dt.textContent = label; const dd = activeDocument!.createElement('dd'); dd.textContent = value; meta.append(dt, dd);
    }
    card.append(meta);
    const actions = activeDocument!.createElement('div'); actions.className = 'archive-actions';
    const restoreButton = activeDocument!.createElement('button'); restoreButton.type = 'button'; restoreButton.textContent = busy.has(item.id) ? '正在恢复…' : '恢复对话'; restoreButton.disabled = busy.has(item.id); restoreButton.setAttribute('aria-label', `恢复对话：${item.title}`);
    restoreButton.addEventListener('click', () => { void restore(item.id); }); actions.append(restoreButton);
    const deleteButton = activeDocument!.createElement('button'); deleteButton.type = 'button'; deleteButton.className = 'danger'; deleteButton.textContent = busy.has(item.id) ? '正在删除…' : '删除'; deleteButton.disabled = busy.has(item.id); deleteButton.setAttribute('aria-label', `删除归档对话：${item.title}`);
    deleteButton.addEventListener('click', () => { void remove(item.id, item.title); }); actions.append(deleteButton);
    card.append(actions); list.append(card);
  }
}
async function load(announce = true): Promise<boolean> {
  if (!request) return false; const current = generation; if (announce) status('正在读取归档…');
  try {
    const result = resultOf<Archived[]>(await request('conversation', 'listArchivedConversations'));
    if (current !== generation) return false;
    if (result.ok === false) { if (announce) status(result.error.message, 'error', true); return false; }
    archivedItems = result.value; render(archivedItems); if (announce) status(result.value.length ? `共 ${result.value.length} 条归档` : '归档列表为空', 'success'); return true;
  } catch (error) { if (current === generation && announce) status(`归档服务暂不可用：${error instanceof Error ? error.message : String(error)}`, 'error', true); return false; }
}
async function restore(id: string): Promise<void> {
  if (!request || busy.has(id)) return; busy.add(id); const current = generation; render(archivedItems);
  let feedback: { message: string; kind: 'success' | 'error' } | undefined;
  try {
    const result = resultOf<unknown>(await request('conversation', 'restoreConversation', id));
    if (current !== generation) return;
    feedback = result.ok === false ? { message: result.error.message, kind: 'error' } : { message: '对话已恢复，当前选择保持不变', kind: 'success' };
  } catch (error) { if (current === generation) feedback = { message: `恢复服务暂不可用：${error instanceof Error ? error.message : String(error)}`, kind: 'error' }; }
  finally {
    busy.delete(id);
    if (current === generation) {
      const refreshed = await load(false);
      if (feedback?.kind === 'success' && !refreshed) status('对话已恢复，但归档列表刷新失败，请重试读取', 'error', true);
      else if (feedback) status(feedback.message, feedback.kind, feedback.kind === 'error');
    }
  }
}
async function remove(id: string, title: string): Promise<void> {
  if (!request || busy.has(id)) return;
  const confirmed = activeDocument?.defaultView?.confirm(`确定要永久删除归档对话「${title}」吗？此操作不可恢复。`);
  if (!confirmed) return;
  busy.add(id); const current = generation; render(archivedItems);
  let feedback: { message: string; kind: 'success' | 'error' } | undefined;
  try {
    const result = resultOf<{ id: string }>(await request('conversation', 'deleteArchivedConversation', id));
    if (current !== generation) return;
    feedback = result.ok === false ? { message: result.error.message, kind: 'error' } : { message: '归档对话已删除', kind: 'success' };
  } catch (error) { if (current === generation) feedback = { message: `删除服务暂不可用：${error instanceof Error ? error.message : String(error)}`, kind: 'error' }; }
  finally {
    busy.delete(id);
    if (current === generation) {
      const refreshed = await load(false);
      if (feedback?.kind === 'success' && !refreshed) status('归档对话已删除，但列表刷新失败，请重试读取', 'error', true);
      else if (feedback) status(feedback.message, feedback.kind, feedback.kind === 'error');
    }
  }
}
function unmount(): void { generation += 1; request = null; activeDocument = null; busy.clear(); archivedItems = []; }
const definition = {
  mount(ctx: { message?: { request?: MessageRequest } }) { unmount(); if (!ctx.message?.request || typeof document === 'undefined') return; request = ctx.message.request; activeDocument = document; activeDocument.getElementById('retry')?.addEventListener('click', () => { void load(); }); void load(); },
  unmount,
  methods: { onConversationChanged(value: unknown) { const action = (value as { action?: unknown } | null)?.action; if (action === 'archive' || action === 'restore' || action === 'delete') void load(); return value; } },
};
export default definition;
