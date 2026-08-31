import { describe, expect, it } from "vitest";
import { extractReplyHtml, extractReplyText } from "../src/quote-strip.js";

describe("extractReplyText", () => {
  it("strips 'On … wrote:' quoted history", () => {
    const text = [
      "Approved, go ahead.",
      "",
      "On Mon, Aug 31, 2026 at 9:00 AM Scout <scout@wzrd.tech> wrote:",
      "> Done. Reply to approve."
    ].join("\n");
    expect(extractReplyText(text)).toBe("Approved, go ahead.");
  });

  it("strips trailing quote-only blocks", () => {
    const text = ["Sounds good", "", "> earlier message", "> more"].join("\n");
    expect(extractReplyText(text)).toBe("Sounds good");
  });

  it("keeps inline quotes when reply continues after them", () => {
    const text = ["> should we ship?", "Yes.", "> when?", "Tomorrow."].join("\n");
    expect(extractReplyText(text)).toBe("Yes.\nTomorrow.");
  });

  it("strips mobile signatures and -- sig blocks", () => {
    expect(extractReplyText("Ok\n\nSent from my iPhone")).toBe("Ok");
    expect(extractReplyText("Ok\n--\nJane Doe")).toBe("Ok");
  });
});

describe("extractReplyHtml", () => {
  it("removes blockquotes and gmail_quote containers", () => {
    expect(
      extractReplyHtml('<p>Yes</p><blockquote>old</blockquote>')
    ).toBe("<p>Yes</p>");
    expect(
      extractReplyHtml('<p>Yes</p><div class="gmail_quote">old</div>')
    ).toBe("<p>Yes</p>");
  });

  it("removes nested blockquotes without leaving stray markup", () => {
    expect(
      extractReplyHtml(
        "<p>Yes</p><blockquote>gen1<blockquote>gen2<blockquote>gen3</blockquote></blockquote></blockquote>"
      )
    ).toBe("<p>Yes</p>");
  });
});
