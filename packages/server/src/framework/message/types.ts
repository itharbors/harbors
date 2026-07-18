export type MessageLocation = 'server' | 'browser';

export interface MessageRoute {
  plugin: string;
  name: string;
  methods: string[];
  location: MessageLocation;
}

export interface MessageRequestRoute extends MessageRoute {
  handler: (...args: unknown[]) => Promise<unknown> | unknown;
}

export interface MessageBroadcastRoute extends MessageRoute {
  handler: (...args: unknown[]) => void | Promise<void>;
}

export interface MessageRegistry {
  request: Map<string, MessageRequestRoute>;
  broadcast: Map<string, MessageBroadcastRoute[]>;
}

export interface SSEDispatch {
  type: 'panel-dispatch';
  panel: string;
  method: string;
  args: unknown[];
  requestId?: string;
}

export interface DispatchResult {
  requestId: string;
  result?: unknown;
  error?: string;
}
