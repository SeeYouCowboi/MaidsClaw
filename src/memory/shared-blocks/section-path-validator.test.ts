import { describe, expect, it } from "bun:test";
import { validateSectionPath } from "./section-path-validator.js";

describe("validateSectionPath", () => {
  it("accepts simple lowercase path", () => expect(validateSectionPath("profile")).toBe(true));
  it("accepts nested path", () => expect(validateSectionPath("profile/facts")).toBe(true));
  it("accepts path with numbers and hyphens", () => expect(validateSectionPath("section-1/sub_2")).toBe(true));
  it("rejects uppercase", () => expect(validateSectionPath("Profile/Facts")).toBe(false));
  it("rejects empty segment", () => expect(validateSectionPath("foo//bar")).toBe(false));
  it("rejects leading slash", () => expect(validateSectionPath("/profile")).toBe(false));
  it("rejects trailing slash", () => expect(validateSectionPath("profile/")).toBe(false));
  it("rejects empty string", () => expect(validateSectionPath("")).toBe(false));
  it("rejects spaces", () => expect(validateSectionPath("my path")).toBe(false));
});
