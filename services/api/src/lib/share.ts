/**
 * Share-link document builder (§ spec 4/P2): the snapshot served publicly at
 * GET /v0/share/:share_id. Same CSP sandbox the console wraps message HTML in,
 * with remote https images allowed — a shared link exists to be rendered by
 * third parties who never see the console's per-reader image opt-in.
 */
export const SHARE_CSP = [
  "default-src 'none'",
  "img-src data: https:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

const SHARE_STYLES =
  "html,body{margin:0;max-width:100%;overflow-wrap:anywhere}" +
  "img{max-width:100%;height:auto}table{max-width:100%!important}" +
  "pre{white-space:pre-wrap;font-family:ui-monospace,monospace}";

/** Wrap raw message HTML in the CSP-sandboxed document, snapshotted at mint. */
export function shareDocumentHtml(html: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="referrer" content="no-referrer">` +
    `<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">` +
    `<style>${SHARE_STYLES}</style></head><body>${html}</body></html>`
  );
}

/** Plain-text fallback document: the message text escaped into a <pre>. */
export function shareTextDocument(text: string): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="referrer" content="no-referrer">` +
    `<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">` +
    `<style>${SHARE_STYLES}</style></head><body><pre>${escaped}</pre></body></html>`
  );
}
