import { describe, expect, it } from "vitest";
import { isId, newId, ulid } from "../src/ids.js";

describe("ulid", () => {
  it("is 26 chars of Crockford base32", () => {
    const id = ulid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts lexicographically by time", () => {
    const a = ulid(1_000_000_000_000);
    const b = ulid(2_000_000_000_000);
    expect(a < b).toBe(true);
  });

  it("is unique across many generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(ulid());
    expect(seen.size).toBe(10_000);
  });
});

describe("newId / isId", () => {
  it("prefixes ids", () => {
    const id = newId("msg");
    expect(id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isId(id, "msg")).toBe(true);
    expect(isId(id, "org")).toBe(false);
  });
});
