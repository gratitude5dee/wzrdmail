/**
 * Reply extraction (§6.1.3): strip quoted history from a plain-text reply
 * to produce `extracted_text`. Heuristic port of the classic email_reply_parser
 * approach; the fixture corpus in fixtures/emails/ grows with real cases.
 */

const QUOTE_HEADER_RES: RegExp[] = [
  /^On .{1,200} wrote:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^From:\s.+$/,
  /^Le .{1,200} a écrit\s*:\s*$/,
  /^Am .{1,200} schrieb .+:\s*$/,
  /^_{4,}\s*$/
];

const SIGNATURE_RES: RegExp[] = [
  /^--\s*$/,
  /^Sent from my (iPhone|iPad|Android|Galaxy|mobile)/i,
  /^Get Outlook for (iOS|Android)/i
];

export function extractReplyText(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (QUOTE_HEADER_RES.some((re) => re.test(line.trim()))) break;
    if (SIGNATURE_RES.some((re) => re.test(line.trim()))) break;
    if (line.trimStart().startsWith(">")) {
      // A quoted block ends extraction only if everything after is quote/blank.
      const rest = lines.slice(i);
      const allQuoted = rest.every(
        (l) => l.trim() === "" || l.trimStart().startsWith(">")
      );
      if (allQuoted) break;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Strip quoted history from HTML replies via common quote containers. */
export function extractReplyHtml(html: string): string {
  return html
    .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>[\s\S]*$/i, "")
    .trim();
}
