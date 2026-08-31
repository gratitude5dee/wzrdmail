/**
 * Minimal Accept-header negotiation: returns whether the given media
 * type is acceptable — i.e. any matching entry (case-insensitive,
 * duplicates considered) carries q > 0 (or no q parameter).
 */
export function accepts(header: string, mediaType: string): boolean {
  for (const part of header.split(",")) {
    const [type, ...params] = part.trim().split(";");
    if ((type ?? "").trim().toLowerCase() !== mediaType) {
      continue;
    }
    const q = params
      .map((param) => param.trim().split("="))
      .find(([key]) => (key ?? "").trim().toLowerCase() === "q");
    if (q === undefined || Number.parseFloat((q[1] ?? "").trim()) > 0) {
      return true;
    }
  }
  return false;
}
