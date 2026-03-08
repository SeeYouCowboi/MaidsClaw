export type EventOrigin = "runtime_projection" | "delayed_materialization" | "promotion";
export type AreaEventClass = "live_perception" | "historical_recall" | "promoted";

export type AreaEvent = {
  eventId: string;
  content: string;
  eventOrigin: EventOrigin;
  locationEntityId?: string;
  timestamp?: number;
};

export type ResolvedAreaEvent = AreaEvent & {
  classification: AreaEventClass;
};

export class AreaStateResolver {
  resolve(event: AreaEvent): ResolvedAreaEvent {
    let classification: AreaEventClass;

    if (event.eventOrigin === "runtime_projection") {
      classification = "live_perception";
    } else if (event.eventOrigin === "delayed_materialization") {
      classification = "historical_recall";
    } else {
      classification = "promoted";
    }

    return {
      ...event,
      classification,
    };
  }

  resolveMany(events: AreaEvent[]): ResolvedAreaEvent[] {
    return events.map((event) => this.resolve(event));
  }

  formatForPrompt(events: ResolvedAreaEvent[]): string {
    if (events.length === 0) {
      return "";
    }

    return events
      .map((event) => `[${event.classification}] ${event.content}`)
      .join("\n");
  }
}
