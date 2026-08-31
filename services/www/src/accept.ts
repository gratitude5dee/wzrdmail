/**
 * Minimal Accept-header negotiation: returns whether the given media
 * type is acceptable (present, case-insensitive, with q > 0).
 */
export function accepts(header: string, mediaType: string): boolean {
  for (const part of header.split(",")) {
    const [type, ...params] = part.trim().split(";");
    if ((type ?? "").trim().toLowerCase() !== mediaType) {
      continue;
    }
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if ((key ?? "").trim().toLowerCase() === "q") {
        return Number.parseFloat((value ?? "").trim()) > 0;
      }
    }
    return true;
  }
  return false;
}
