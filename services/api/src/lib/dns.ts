/**
 * DNS-over-HTTPS lookups (RFC 8484 JSON API) against cloudflare-dns.com.
 * Used only for custom-domain verification (§6.6) — we never touch the
 * customer's DNS, we just read it.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

const TYPE_CODES = { TXT: 16, MX: 15 } as const;

export type DnsLookupType = keyof typeof TYPE_CODES;

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

export class DnsLookupError extends Error {
  constructor(name: string, type: DnsLookupType, detail: string) {
    super(`DNS ${type} lookup for ${name} failed: ${detail}`);
    this.name = "DnsLookupError";
  }
}

/** TXT record data arrives as one or more quoted strings; join and unquote. */
function unquoteTxt(data: string): string {
  return data
    .split(/"\s+"/)
    .map((part) => part.replace(/^"|"$/g, ""))
    .join("");
}

/**
 * Resolve a record set. Returns normalized record data strings: TXT values
 * unquoted, MX values as `<priority> <host>` with the trailing dot kept.
 * NOERROR/NXDOMAIN with no answers → empty array; transport or server
 * failures throw DnsLookupError so callers can distinguish "record absent"
 * from "could not check".
 */
export async function lookupDns(name: string, type: DnsLookupType): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/dns-json" } });
  } catch (err) {
    throw new DnsLookupError(name, type, String(err));
  }
  if (!res.ok) {
    throw new DnsLookupError(name, type, `resolver returned ${res.status}`);
  }
  const body = (await res.json()) as { Status?: number; Answer?: DohAnswer[] };
  // Status 0 = NOERROR, 3 = NXDOMAIN (record simply absent). Anything else
  // (SERVFAIL etc.) means the check could not run.
  if (body.Status !== 0 && body.Status !== 3) {
    throw new DnsLookupError(name, type, `resolver status ${body.Status ?? "unknown"}`);
  }
  return (body.Answer ?? [])
    .filter((a) => a.type === TYPE_CODES[type])
    .map((a) => (type === "TXT" ? unquoteTxt(a.data) : a.data.trim()));
}
