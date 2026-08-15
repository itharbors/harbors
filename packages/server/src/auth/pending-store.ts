export interface PendingAuthorization {
  deviceId: string;
  ip: string;
  userAgent: string;
  requestedAt: number;
}

export class PendingAuthorizationStore {
  private readonly pending = new Map<string, PendingAuthorization>();

  add(deviceId: string, info: { ip: string; userAgent: string }): PendingAuthorization {
    const existing = this.pending.get(deviceId);
    const entry: PendingAuthorization = {
      deviceId,
      ip: info.ip,
      userAgent: info.userAgent,
      requestedAt: existing?.requestedAt ?? Date.now(),
    };
    this.pending.set(deviceId, entry);
    return entry;
  }

  get(deviceId: string): PendingAuthorization | undefined {
    return this.pending.get(deviceId);
  }

  remove(deviceId: string): void {
    this.pending.delete(deviceId);
  }

  list(): PendingAuthorization[] {
    return Array.from(this.pending.values()).sort((a, b) => a.requestedAt - b.requestedAt);
  }
}
