// Minimal typed in-process event bus for MaidsClaw coordination signals
// emit/on/off/once only — no persistence, no workflow, no cross-process messaging

import type { EventMap, EventName, EventPayload } from "./events.js";
import type { Logger } from "./logger.js";

export type EventHandler<E extends EventName> = (payload: EventPayload<E>) => void | Promise<void>;

// Unsubscribe function
export type Unsubscribe = () => void;

// EventBus interface — all calling code uses this
export interface EventBus {
  emit<E extends EventName>(event: E, payload: EventPayload<E>): void;
  on<E extends EventName>(event: E, handler: EventHandler<E>): Unsubscribe;
  off<E extends EventName>(event: E, handler: EventHandler<E>): void;
  once<E extends EventName>(event: E, handler: EventHandler<E>): Unsubscribe;
}

// Internal listener storage — handlers stored by event name
// Using Map for O(1) lookup by handler reference
class EventBusImpl implements EventBus {
  private listeners: Map<EventName, Set<EventHandler<EventName>>> = new Map();
  private onceListeners: Map<EventName, Set<EventHandler<EventName>>> = new Map();

  constructor(private readonly logger?: Logger) {}

  emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
    // Get regular listeners
    const regularHandlers = this.listeners.get(event);
    if (regularHandlers) {
      for (const handler of regularHandlers) {
        this.invokeHandler(event, handler as EventHandler<E>, payload);
      }
    }

    // Get once listeners (will be cleared after this emit)
    const onceHandlers = this.onceListeners.get(event);
    if (onceHandlers) {
      // Clear once listeners BEFORE invoking to prevent re-entrancy issues
      this.onceListeners.delete(event);
      for (const handler of onceHandlers) {
        this.invokeHandler(event, handler as EventHandler<E>, payload);
      }
    }
  }

  private invokeHandler<E extends EventName>(
    event: E,
    handler: EventHandler<E>,
    payload: EventPayload<E>
  ): void {
    try {
      const result = handler(payload);
      // Fire-and-forget for async handlers
      if (result && typeof result.then === "function") {
        result.catch((err: unknown) => {
          this.logError(event, err);
        });
      }
    } catch (err) {
      this.logError(event, err);
    }
  }

  private logError(event: EventName, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.logger) {
      this.logger.error(`Event listener failed for ${event}`, {
        code: "LISTENER_ERROR",
        message,
        retriable: false,
      });
    } else {
      console.error(`Event listener failed for ${event}:`, message);
    }
  }

  on<E extends EventName>(event: E, handler: EventHandler<E>): Unsubscribe {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as EventHandler<EventName>);

    // Return unsubscribe function
    return () => {
      this.off(event, handler);
    };
  }

  off<E extends EventName>(event: E, handler: EventHandler<E>): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler as EventHandler<EventName>);
      // Clean up empty sets to prevent memory leak
      if (handlers.size === 0) {
        this.listeners.delete(event);
      }
    }

    // Also check once listeners (in case off is called before emit)
    const onceHandlers = this.onceListeners.get(event);
    if (onceHandlers) {
      onceHandlers.delete(handler as EventHandler<EventName>);
      if (onceHandlers.size === 0) {
        this.onceListeners.delete(event);
      }
    }
  }

  once<E extends EventName>(event: E, handler: EventHandler<E>): Unsubscribe {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set());
    }
    this.onceListeners.get(event)!.add(handler as EventHandler<EventName>);

    // Return unsubscribe function
    return () => {
      this.off(event, handler);
    };
  }
}

export function createEventBus(logger?: Logger): EventBus {
  return new EventBusImpl(logger);
}
