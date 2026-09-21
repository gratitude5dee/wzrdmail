/**
 * Air × Muse compatibility lane for the hosted WZRDMail MCP endpoint.
 *
 * WZRDMail keeps owning requests authenticated with its `wm_…` API keys.
 * Every other `/mcp` request is a pass-through to the Air × Muse OAuth
 * resource. This lets a connector use one public endpoint without ever
 * presenting an Air OAuth token to the WZRDMail API or Durable Object.
 */

export const DEFAULT_MUSE_ORIGIN = "https://muse.wzrd.tech";

/** An explicit WZRDMail key always wins, even if a client also sends Bearer. */
export function isWzrdmailRequest(request: Request): boolean {
  const headerKey = request.headers.get("x-api-key")?.trim();
  if (headerKey) return true;

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.toLowerCase().startsWith("bearer ")) return false;
  return authorization.slice("bearer ".length).trim().startsWith("wm_");
}

export function isMuseDiscoveryPath(pathname: string): boolean {
  return pathname === "/.well-known/mcp.json" ||
    pathname === "/.well-known/oauth-protected-resource/mcp" ||
    pathname === "/muse.md";
}

export function museTarget(request: Request, origin = DEFAULT_MUSE_ORIGIN): string {
  const target = new URL(request.url);
  const upstream = new URL(origin);
  target.protocol = upstream.protocol;
  target.host = upstream.host;
  return target.toString();
}

/** Preserve the full MCP request (including the opaque OAuth bearer) on the
 * hop to Air. `Request` construction changes only the origin, so Cloudflare
 * supplies the upstream Host rather than forwarding mcp.mail.wzrd.tech. */
export async function proxyMuse(
  request: Request,
  origin?: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return fetchImpl(new Request(museTarget(request, origin), request));
}
