interface ServiceRegistration {
  owner: string;
  value: unknown;
}

export class ApplicationServiceRegistry {
  private readonly registrations = new Map<string, ServiceRegistration>();

  register(owner: string, name: string, value: unknown): void {
    assertIdentifier(owner, 'Service owner');
    assertIdentifier(name, 'Service name');
    structuredClone(value);
    const existing = this.registrations.get(name);
    if (existing) {
      throw new Error(`Service "${name}" is already registered by "${existing.owner}"`);
    }
    this.registrations.set(name, { owner, value });
  }

  unregister(owner: string, name: string): void {
    const existing = this.registrations.get(name);
    if (!existing) return;
    if (existing.owner !== owner) {
      throw new Error(`Service "${name}" is owned by "${existing.owner}"`);
    }
    this.registrations.delete(name);
  }

  get<T = unknown>(name: string): T | undefined {
    return this.registrations.get(name)?.value as T | undefined;
  }

  snapshot(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(
      [...this.registrations].map(([name, registration]) => [name, registration.value]),
    ));
  }

  clearOwner(owner: string): void {
    for (const [name, registration] of this.registrations) {
      if (registration.owner === owner) this.registrations.delete(name);
    }
  }

  clear(): void {
    this.registrations.clear();
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}
