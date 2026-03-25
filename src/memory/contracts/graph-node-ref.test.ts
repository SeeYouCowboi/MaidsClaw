import { describe, expect, it } from "bun:test";
import {
  type GraphNodeRef,
  parseGraphNodeRef,
  serializeGraphNodeRef,
} from "./graph-node-ref.js";

describe("parseGraphNodeRef", () => {
  it("parses all 8 known kinds correctly (canonical + legacy compat)", () => {
    const cases: Array<{ input: string; expected: GraphNodeRef }> = [
      { input: "event:42", expected: { kind: "event", id: "42" } },
      { input: "entity:123", expected: { kind: "entity", id: "123" } },
      { input: "fact:1", expected: { kind: "fact", id: "1" } },
      { input: "assertion:99", expected: { kind: "assertion", id: "99" } },
      { input: "evaluation:7", expected: { kind: "evaluation", id: "7" } },
      { input: "commitment:100", expected: { kind: "commitment", id: "100" } },
      { input: "private_event:55", expected: { kind: "private_event", id: "55" } },
      { input: "private_belief:88", expected: { kind: "private_belief", id: "88" } },
    ];

    for (const { input, expected } of cases) {
      expect(parseGraphNodeRef(input)).toEqual(expected);
    }
  });

  it("throws for missing colon (invalid format)", () => {
    expect(() => parseGraphNodeRef("foo")).toThrow("Invalid node ref format: foo");
    expect(() => parseGraphNodeRef("")).toThrow("Invalid node ref format: ");
    expect(() => parseGraphNodeRef("event")).toThrow("Invalid node ref format: event");
  });

  it("throws for unknown kind", () => {
    expect(() => parseGraphNodeRef("unknown:1")).toThrow("Unknown node ref kind: unknown");
    expect(() => parseGraphNodeRef("foo:123")).toThrow("Unknown node ref kind: foo");
  });

  it("parses empty id portion as empty string (edge case)", () => {
    // Empty id after colon is valid parsing-wise (id can be empty string)
    expect(parseGraphNodeRef("event:")).toEqual({ kind: "event", id: "" });
  });

  it("parses ids with colons correctly (only splits on first colon)", () => {
    expect(parseGraphNodeRef("event:foo:bar")).toEqual({ kind: "event", id: "foo:bar" });
  });
});

describe("serializeGraphNodeRef", () => {
  it("serializes GraphNodeRef to string format", () => {
    const cases: Array<{ input: GraphNodeRef; expected: string }> = [
      { input: { kind: "event", id: "42" }, expected: "event:42" },
      { input: { kind: "entity", id: "123" }, expected: "entity:123" },
      { input: { kind: "fact", id: "1" }, expected: "fact:1" },
      { input: { kind: "assertion", id: "99" }, expected: "assertion:99" },
      { input: { kind: "evaluation", id: "7" }, expected: "evaluation:7" },
      { input: { kind: "commitment", id: "100" }, expected: "commitment:100" },
      { input: { kind: "private_event", id: "55" }, expected: "private_event:55" },
      { input: { kind: "private_belief", id: "88" }, expected: "private_belief:88" },
    ];

    for (const { input, expected } of cases) {
      expect(serializeGraphNodeRef(input)).toEqual(expected);
    }
  });
});

describe("roundtrip", () => {
  it("parse -> serialize matches original for all kinds", () => {
    const originals = [
      "event:42",
      "entity:123",
      "fact:1",
      "assertion:99",
      "evaluation:7",
      "commitment:100",
      "private_event:55",
      "private_belief:88",
    ];

    for (const original of originals) {
      const parsed = parseGraphNodeRef(original);
      const serialized = serializeGraphNodeRef(parsed);
      expect(serialized).toEqual(original);
    }
  });

  it("serialize -> parse recovers original GraphNodeRef", () => {
    const refs: GraphNodeRef[] = [
      { kind: "event", id: "42" },
      { kind: "entity", id: "123" },
      { kind: "fact", id: "1" },
      { kind: "assertion", id: "99" },
      { kind: "evaluation", id: "7" },
      { kind: "commitment", id: "100" },
      { kind: "private_event", id: "55" },
      { kind: "private_belief", id: "88" },
    ];

    for (const ref of refs) {
      const serialized = serializeGraphNodeRef(ref);
      const reparsed = parseGraphNodeRef(serialized);
      expect(reparsed).toEqual(ref);
    }
  });
});
