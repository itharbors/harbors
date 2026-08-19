export interface PreviewContent {
  kind: 'file' | 'url' | 'unsupported';
  path?: string;
  url?: string;
  title?: string;
  language?: string;
  content?: string;
  error?: string;
}

export interface PreviewTab {
  /** Stable identity for this open instance, distinct from the URI key. */
  id: string;
  /** URI identity used to activate an existing tab instead of opening another. */
  key: string;
  href: string;
  originalHref: string;
  title: string;
  content: PreviewContent;
  requestId?: number;
}

export interface PreviewSession {
  tabs: PreviewTab[];
  activeId: string | null;
}

export interface PreviewState {
  sessions: Record<string, PreviewSession>;
  selectedSessionKey: string;
}

export interface OpenTabResult {
  state: PreviewState;
  tab: PreviewTab;
  created: boolean;
}

const EMPTY_SESSION: PreviewSession = { tabs: [], activeId: null };

export function createPreviewState(selectedSessionKey = 'empty'): PreviewState {
  return { sessions: {}, selectedSessionKey };
}

export function previewSessionKey(value: unknown): string {
  if (!value || typeof value !== 'object') return 'empty';
  const record = value as { selectedConversationId?: unknown; draft?: { project?: unknown } | null };
  if (typeof record.selectedConversationId === 'string' && record.selectedConversationId.length > 0) {
    return `conversation:${record.selectedConversationId}`;
  }
  const project = record.draft && typeof record.draft.project === 'string' ? record.draft.project : '';
  return project ? `draft:${project}` : 'empty';
}

export function getPreviewSession(state: PreviewState, sessionKey = state.selectedSessionKey): PreviewSession {
  return state.sessions[sessionKey] || EMPTY_SESSION;
}

export function selectPreviewSession(state: PreviewState, sessionKey: string): PreviewState {
  if (state.selectedSessionKey === sessionKey) return state;
  return { ...state, selectedSessionKey: sessionKey };
}

export function openPreviewTab(state: PreviewState, sessionKey: string, tab: PreviewTab): OpenTabResult {
  const session = getPreviewSession(state, sessionKey);
  const existing = session.tabs.find((item) => item.key === tab.key);
  if (existing) {
    if (state.selectedSessionKey === sessionKey && session.activeId === existing.id) {
      return { state, tab: existing, created: false };
    }
    const nextSession = { ...session, activeId: existing.id };
    return {
      state: { ...state, sessions: { ...state.sessions, [sessionKey]: nextSession } },
      tab: existing,
      created: false,
    };
  }

  const nextSession: PreviewSession = { tabs: [...session.tabs, tab], activeId: tab.id };
  return {
    state: { ...state, sessions: { ...state.sessions, [sessionKey]: nextSession } },
    tab,
    created: true,
  };
}

export function activatePreviewTab(state: PreviewState, sessionKey: string, tabId: string): PreviewState {
  const session = getPreviewSession(state, sessionKey);
  if (!session.tabs.some((tab) => tab.id === tabId) || session.activeId === tabId) {
    return state.selectedSessionKey === sessionKey ? state : { ...state, selectedSessionKey: sessionKey };
  }
  return {
    ...state,
    selectedSessionKey: sessionKey,
    sessions: { ...state.sessions, [sessionKey]: { ...session, activeId: tabId } },
  };
}

export function closePreviewTab(state: PreviewState, sessionKey: string, tabId: string): PreviewState {
  const session = getPreviewSession(state, sessionKey);
  const index = session.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;

  const tabs = session.tabs.filter((tab) => tab.id !== tabId);
  let activeId = session.activeId;
  if (session.activeId === tabId) {
    activeId = tabs[index - 1]?.id || tabs[index]?.id || null;
  } else if (!tabs.some((tab) => tab.id === activeId)) {
    activeId = tabs[0]?.id || null;
  }

  return {
    ...state,
    sessions: { ...state.sessions, [sessionKey]: { tabs, activeId } },
  };
}

export function resolvePreviewTab(
  state: PreviewState,
  sessionKey: string,
  tabId: string,
  requestId: number,
  content: PreviewContent,
): PreviewState {
  const session = getPreviewSession(state, sessionKey);
  const index = session.tabs.findIndex((tab) => tab.id === tabId && tab.requestId === requestId);
  if (index < 0) return state;

  const tabs = session.tabs.slice();
  tabs[index] = { ...tabs[index], content };
  return { ...state, sessions: { ...state.sessions, [sessionKey]: { ...session, tabs } } };
}

export function previewKey(protocol: 'file' | 'http' | 'https', href: string): string {
  try {
    const url = new URL(href);
    // File reads intentionally discard search/hash (fileURLToPath does too),
    // while web URLs retain them because they can select different resources.
    if (protocol === 'file') {
      url.search = '';
      url.hash = '';
    }
    return `${protocol}:${url.href}`;
  } catch {
    return `${protocol}:${href}`;
  }
}
