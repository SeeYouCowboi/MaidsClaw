// Counter — monotonically increasing metric
export interface Counter {
  increment(by?: number): void;
  value(): number;
  reset(): void;
}

// Timer — records elapsed time in ms
export interface Timer {
  start(): void;
  stop(): number;   // Returns elapsed ms
  elapsed(): number; // Returns current elapsed ms (without stopping)
  reset(): void;
}

// Gauge — arbitrary numeric value
export interface Gauge {
  set(value: number): void;
  value(): number;
}

// Observability registry — lightweight, no global state (tests create their own instances)
export interface ObservabilityRegistry {
  counter(name: string): Counter;
  timer(name: string): Timer;
  gauge(name: string): Gauge;
  snapshot(): Record<string, number>; // All current values for diagnostics
}

// Counter implementation
class CounterImpl implements Counter {
  private _value: number = 0;

  increment(by?: number): void {
    this._value += by ?? 1;
  }

  value(): number {
    return this._value;
  }

  reset(): void {
    this._value = 0;
  }
}

// Timer implementation
class TimerImpl implements Timer {
  private startTime: number = 0;
  private _elapsed: number = 0;
  private running: boolean = false;

  start(): void {
    this.startTime = performance.now();
    this.running = true;
  }

  stop(): number {
    if (this.running) {
      this._elapsed = performance.now() - this.startTime;
      this.running = false;
    }
    return this._elapsed;
  }

  elapsed(): number {
    if (this.running) {
      return performance.now() - this.startTime;
    }
    return this._elapsed;
  }

  reset(): void {
    this.startTime = 0;
    this._elapsed = 0;
    this.running = false;
  }
}

// Gauge implementation
class GaugeImpl implements Gauge {
  private _value: number = 0;

  set(value: number): void {
    this._value = value;
  }

  value(): number {
    return this._value;
  }
}

// Registry implementation
class ObservabilityRegistryImpl implements ObservabilityRegistry {
  private counters: Map<string, CounterImpl> = new Map();
  private timers: Map<string, TimerImpl> = new Map();
  private gauges: Map<string, GaugeImpl> = new Map();

  counter(name: string): Counter {
    if (!this.counters.has(name)) {
      this.counters.set(name, new CounterImpl());
    }
    return this.counters.get(name)!;
  }

  timer(name: string): Timer {
    if (!this.timers.has(name)) {
      this.timers.set(name, new TimerImpl());
    }
    return this.timers.get(name)!;
  }

  gauge(name: string): Gauge {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, new GaugeImpl());
    }
    return this.gauges.get(name)!;
  }

  snapshot(): Record<string, number> {
    const result: Record<string, number> = {};
    
    for (const [name, counter] of this.counters) {
      result[`counter.${name}`] = counter.value();
    }
    
    for (const [name, timer] of this.timers) {
      result[`timer.${name}`] = timer.elapsed();
    }
    
    for (const [name, gauge] of this.gauges) {
      result[`gauge.${name}`] = gauge.value();
    }
    
    return result;
  }
}

// Factory function — no global state, each registry is independent
export function createObservabilityRegistry(): ObservabilityRegistry {
  return new ObservabilityRegistryImpl();
}
