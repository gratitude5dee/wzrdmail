import { describe, expect, it } from "vitest";
import { validateUsername } from "../src/reserved.js";

describe("validateUsername", () => {
  it("accepts valid usernames and lowercases them", () => {
    expect(validateUsername("Scout")).toEqual({ ok: true, username: "scout" });
    expect(validateUsername("bot-42.dev")).toEqual({
      ok: true,
      username: "bot-42.dev"
    });
  });

  it("rejects short, malformed, or separator-edged names", () => {
    for (const bad of ["ab", "-abc", "abc-", ".abc", "a..b", "a__b!", "a b"]) {
      expect(validateUsername(bad).ok, bad).toBe(false);
    }
  });

  it("rejects reserved local-parts", () => {
    expect(validateUsername("postmaster")).toEqual({
      ok: false,
      reason: "reserved"
    });
    expect(validateUsername("Security")).toEqual({
      ok: false,
      reason: "reserved"
    });
  });

  it("rejects impersonation denylist", () => {
    expect(validateUsername("stripe")).toEqual({
      ok: false,
      reason: "denylisted"
    });
  });
});
