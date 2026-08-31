import { describe, expect, it } from "vitest";
import {
  normalizeSubject,
  parseMessageIdRefs,
  resolveThread
} from "../src/threading.js";

describe("normalizeSubject", () => {
  it("strips reply/forward prefixes recursively", () => {
    expect(normalizeSubject("Re: Re: Fwd: Report ready")).toBe("report ready");
    expect(normalizeSubject("RE[2]: hello")).toBe("hello");
    expect(normalizeSubject("Report ready")).toBe("report ready");
  });
});

describe("parseMessageIdRefs", () => {
  it("extracts angle-bracketed ids", () => {
    expect(parseMessageIdRefs("<a@x.com> <b@y.com>")).toEqual([
      "<a@x.com>",
      "<b@y.com>"
    ]);
    expect(parseMessageIdRefs(undefined)).toEqual([]);
  });
});

describe("resolveThread", () => {
  const candidate = {
    thread_id: "thread_1",
    normalized_subject: "report ready",
    participants: ["human@gmail.com"],
    last_message_at: new Date().toISOString()
  };

  it("prefers Message-ID lineage", () => {
    expect(
      resolveThread({
        referencedThreadId: "thread_9",
        subject: "whatever",
        participants: [],
        candidates: [candidate]
      })
    ).toEqual({ kind: "existing", thread_id: "thread_9" });
  });

  it("falls back to subject + participant overlap within 30 days", () => {
    expect(
      resolveThread({
        referencedThreadId: null,
        subject: "Re: Report ready",
        participants: ["Human@gmail.com"],
        candidates: [candidate]
      })
    ).toEqual({ kind: "existing", thread_id: "thread_1" });
  });

  it("does not match stale threads", () => {
    const stale = {
      ...candidate,
      last_message_at: new Date(Date.now() - 40 * 86400_000).toISOString()
    };
    expect(
      resolveThread({
        referencedThreadId: null,
        subject: "Re: Report ready",
        participants: ["human@gmail.com"],
        candidates: [stale]
      })
    ).toEqual({ kind: "new" });
  });

  it("does not match without participant overlap", () => {
    expect(
      resolveThread({
        referencedThreadId: null,
        subject: "Report ready",
        participants: ["other@x.com"],
        candidates: [candidate]
      })
    ).toEqual({ kind: "new" });
  });
});
