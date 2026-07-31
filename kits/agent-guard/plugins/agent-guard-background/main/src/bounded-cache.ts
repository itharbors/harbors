function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('cache limit must be a positive integer');
}

export class BoundedMap<K, V> extends Map<K, V> {
  readonly #limit: number;

  constructor(limit: number) {
    super();
    validateLimit(limit);
    this.#limit = limit;
  }

  override set(key: K, value: V): this {
    if (this.has(key)) this.delete(key);
    while (this.size >= this.#limit) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    return super.set(key, value);
  }
}

export class BoundedSet<T> extends Set<T> {
  readonly #limit: number;

  constructor(limit: number) {
    super();
    validateLimit(limit);
    this.#limit = limit;
  }

  override add(value: T): this {
    if (this.has(value)) this.delete(value);
    while (this.size >= this.#limit) {
      const oldest = this.values().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    return super.add(value);
  }
}
