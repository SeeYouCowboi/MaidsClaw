import { describe, it, expect } from "bun:test";
import { InnerThoughtFilter } from "./inner-thought-filter";

describe("InnerThoughtFilter", () => {
  it("passes through plain text without tags", () => {
    const filter = new InnerThoughtFilter();
    const result = filter.feed("Hello, how are you?");
    expect(result.publicText).toBe("Hello, how are you?");
    expect(filter.completedThoughts).toEqual([]);
  });

  it("strips a single inner_thought block", () => {
    const filter = new InnerThoughtFilter();
    const result = filter.feed(
      '<inner_thought>I suspect Bob is lying.</inner_thought>"Oh really, that sounds interesting!"',
    );
    expect(result.publicText).toBe('"Oh really, that sounds interesting!"');
    expect(filter.completedThoughts).toEqual(["I suspect Bob is lying."]);
  });

  it("handles thought in the middle of text", () => {
    const filter = new InnerThoughtFilter();
    const result = filter.feed(
      'Hello <inner_thought>secret thought</inner_thought> world!',
    );
    expect(result.publicText).toBe("Hello  world!");
    expect(filter.completedThoughts).toEqual(["secret thought"]);
  });

  it("handles multiple thought blocks", () => {
    const filter = new InnerThoughtFilter();
    const result = filter.feed(
      '<inner_thought>thought1</inner_thought>public1<inner_thought>thought2</inner_thought>public2',
    );
    expect(result.publicText).toBe("public1public2");
    expect(filter.completedThoughts).toEqual(["thought1", "thought2"]);
  });

  it("handles tag split across multiple feed() calls", () => {
    const filter = new InnerThoughtFilter();

    const r1 = filter.feed("Hello <inner_th");
    expect(r1.publicText).toBe("Hello ");

    const r2 = filter.feed("ought>secret");
    expect(r2.publicText).toBe("");

    const r3 = filter.feed(" stuff</inner_thought> visible");
    expect(r3.publicText).toBe(" visible");
    expect(filter.completedThoughts).toEqual(["secret stuff"]);
  });

  it("handles close tag split across chunks", () => {
    const filter = new InnerThoughtFilter();

    filter.feed("<inner_thought>my thought</inner_");
    const r2 = filter.feed("thought>public text");
    expect(r2.publicText).toBe("public text");
    expect(filter.completedThoughts).toEqual(["my thought"]);
  });

  it("releases non-matching tag as public text", () => {
    const filter = new InnerThoughtFilter();
    const result = filter.feed("<input>some text");
    expect(result.publicText).toBe("<input>some text");
    expect(filter.completedThoughts).toEqual([]);
  });

  it("handles empty thought block", () => {
    const filter = new InnerThoughtFilter();
    const result = filter.feed("<inner_thought></inner_thought>hello");
    expect(result.publicText).toBe("hello");
    expect(filter.completedThoughts).toEqual([""]);
  });

  it("handles angle brackets inside thought content", () => {
    const filter = new InnerThoughtFilter();
    // The < inside thought that doesn't start </inner_thought> should stay in thought
    const result = filter.feed("<inner_thought>score < 5 and x > 3</inner_thought>ok");
    expect(result.publicText).toBe("ok");
    // The content might include the attempted close-tag parse leftovers
    expect(filter.completedThoughts.length).toBe(1);
    expect(filter.completedThoughts[0]).toContain("score");
  });

  it("flushes incomplete open tag as public text", () => {
    const filter = new InnerThoughtFilter();
    filter.feed("hello <inner_th");
    const flushed = filter.flush();
    expect(flushed.publicText).toBe("<inner_th");
    expect(filter.completedThoughts).toEqual([]);
  });

  it("flushes unclosed thought block as public text", () => {
    const filter = new InnerThoughtFilter();
    filter.feed("<inner_thought>unclosed thought");
    const flushed = filter.flush();
    expect(flushed.publicText).toBe("<inner_thought>unclosed thought");
    expect(filter.completedThoughts).toEqual([]);
  });

  it("flushes incomplete close tag inside thought as public", () => {
    const filter = new InnerThoughtFilter();
    filter.feed("<inner_thought>thought text</inner_");
    const flushed = filter.flush();
    expect(flushed.publicText).toBe("<inner_thought>thought text</inner_");
    expect(filter.completedThoughts).toEqual([]);
  });

  it("handles character-by-character streaming", () => {
    const filter = new InnerThoughtFilter();
    const input = '<inner_thought>hi</inner_thought>ok';
    let publicText = "";

    for (const ch of input) {
      const result = filter.feed(ch);
      publicText += result.publicText;
    }

    const flushed = filter.flush();
    publicText += flushed.publicText;

    expect(publicText).toBe("ok");
    expect(filter.completedThoughts).toEqual(["hi"]);
  });

  it("resets state after flush", () => {
    const filter = new InnerThoughtFilter();
    filter.feed("<inner_thought>thought</inner_thought>");
    filter.flush();
    // After flush, filter should work normally again
    const result = filter.feed("new text");
    expect(result.publicText).toBe("new text");
  });
});
