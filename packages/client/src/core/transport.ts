import {
  isSupportedProtocolVersion,
  type BootstrapInfo,
  type BrowserDispatchResult,
  type BrowserOpenPanelResult,
  type SSEEnvelope,
  type SessionInfo,
} from '@ce/plugin-types';
import type { ClientSession } from './session';

export type OpenPanelResult = BrowserOpenPanelResult;

export class EditorTransport {
  private eventSource: EventSource | null = null;

  constructor(private session: ClientSession) {}

  async fetchSessionInfo(): Promise<SessionInfo> {
    let resp = await fetch(`/api/session/${this.session.sessionId}`);

    // Auto-create session on server if it doesn't exist yet
    if (resp.status === 404) {
      resp = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: this.session.sessionId }),
      });
    }

    if (!resp.ok) {
      throw new Error(`Failed to fetch session: ${resp.status}`);
    }
    const info: SessionInfo = await resp.json();
    this.session.sessionInfo = info;
    this.session.connected = true;
    return info;
  }

  async fetchBootstrap(): Promise<BootstrapInfo> {
    let resp = await fetch(`/api/bootstrap/${encodeURIComponent(this.session.sessionId)}`);
    if (resp.status === 404 || resp.status >= 500) {
      await this.initializeSessionForBootstrap();
      resp = await fetch(`/api/bootstrap/${encodeURIComponent(this.session.sessionId)}`);
    }
    if (!resp.ok) {
      throw new Error(`Failed to fetch bootstrap: ${resp.status}`);
    }
    const bootstrap = await resp.json() as BootstrapInfo;
    assertSupportedProtocolVersion(bootstrap);
    this.session.bootstrapInfo = bootstrap;
    return bootstrap;
  }

  private async initializeSessionForBootstrap(): Promise<void> {
    let createResp = await this.createSession();
    if (!createResp.ok && createResp.status >= 500) {
      await delay(100);
      createResp = await this.createSession();
    }
    if (!createResp.ok) {
      throw new Error(`Failed to initialize session for bootstrap: ${createResp.status}`);
    }
  }

  private createSession(): Promise<Response> {
    return fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: this.session.sessionId }),
    });
  }

  connectSSE(
    onEvent?: (event: SSEEnvelope) => void,
    onError?: (error: Error) => void,
  ): void {
    const url = `/sse/${this.session.sessionId}`;
    this.eventSource = new EventSource(url);

    this.eventSource.onopen = () => {
      this.session.sseActive = true;
    };

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as unknown;
        assertSupportedProtocolVersion(data);
        onEvent?.(data as SSEEnvelope);
      } catch (error) {
        onError?.(toError(error));
      }
    };

    this.eventSource.onerror = () => {
      this.session.sseActive = false;
    };
  }

  disconnectSSE(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.session.sseActive = false;
    }
  }

  async openPanel(panelName: string): Promise<OpenPanelResult> {
    const resp = await fetch('/api/panel/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: this.session.sessionId, panelName }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to open panel: ${resp.status}`);
    }
    return await resp.json() as OpenPanelResult;
  }

  async sendMessageResult(requestId: string, result: BrowserDispatchResult): Promise<void> {
    const resp = await fetch('/api/message/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: this.session.sessionId,
        requestId,
        result,
      }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to send message result: ${resp.status}`);
    }
  }

  async markPanelFloating(panelInstanceId: string): Promise<unknown> {
    const resp = await fetch('/api/panel-instance/fallback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: this.session.sessionId, panelInstanceId }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to mark panel floating: ${resp.status}`);
    }
    return await resp.json() as unknown;
  }

  async closePanelInstance(panelInstanceId: string): Promise<void> {
    const resp = await fetch('/api/panel-instance/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: this.session.sessionId, panelInstanceId }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to close panel instance: ${resp.status}`);
    }
  }

  async setPanelInstanceState(panelInstanceId: string, state: 'open' | 'minimized'): Promise<void> {
    const resp = await fetch('/api/panel-instance/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: this.session.sessionId, panelInstanceId, state }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to set panel instance state: ${resp.status}`);
    }
  }

  async closeWindowGroup(windowGroupId: string, options: { beacon?: boolean } = {}): Promise<void> {
    const body = JSON.stringify({ sessionId: this.session.sessionId, windowGroupId });
    if (options.beacon && typeof navigator.sendBeacon === 'function') {
      const sent = navigator.sendBeacon('/api/window-group/close', body);
      if (sent) return;
    }

    const resp = await fetch('/api/window-group/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: options.beacon,
    });
    if (!resp.ok) {
      throw new Error(`Failed to close window group: ${resp.status}`);
    }
  }

}

function assertSupportedProtocolVersion(value: unknown): void {
  const protocolVersion = typeof value === 'object' && value !== null
    ? (value as { protocolVersion?: unknown }).protocolVersion
    : undefined;
  if (!isSupportedProtocolVersion(protocolVersion)) {
    throw new Error(`Unsupported protocol version: ${String(protocolVersion)}`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function getSessionIdFromURL(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('session') || params.get('sessionId') || '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
