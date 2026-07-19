export type PanelRequestContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

export class WorkbenchController {
  constructor(
    private readonly context: PanelRequestContext,
    private readonly pluginName: string,
  ) {}

  async request<T>(name: string, input?: unknown): Promise<T> {
    const result = await this.context.message.request(
      this.pluginName,
      name,
      ...(input === undefined ? [] : [input]),
    );
    if (isRecord(result) && isRecord(result.$sqliteWorkbenchError)) {
      const error = result.$sqliteWorkbenchError;
      throw new WorkbenchRequestError(
        typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
        typeof error.message === 'string' ? error.message : '操作失败，请查看详情。',
        typeof error.detail === 'string' ? error.detail : undefined,
      );
    }
    return result as T;
  }
}

export class WorkbenchRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'WorkbenchRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
