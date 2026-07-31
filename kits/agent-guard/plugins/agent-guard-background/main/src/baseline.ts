export interface BaselineSnapshot {
  median: number;
  mad: number;
  samples: number;
}

export class RollingBaseline {
  #values: number[] = [];

  constructor(readonly capacity = 7 * 24 * 60) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new TypeError('Baseline capacity must be a positive integer');
    }
  }

  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Baseline value must be non-negative');
    this.#values.push(value);
    if (this.#values.length > this.capacity) this.#values.splice(0, this.#values.length - this.capacity);
  }

  values(): number[] {
    return [...this.#values];
  }

  snapshot(): BaselineSnapshot {
    if (this.#values.length === 0) return { median: 0, mad: 0, samples: 0 };
    const medianValue = median(this.#values);
    return {
      median: medianValue,
      mad: median(this.#values.map((value) => Math.abs(value - medianValue))),
      samples: this.#values.length,
    };
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
