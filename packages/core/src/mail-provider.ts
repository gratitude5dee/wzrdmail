/**
 * The provider seam (§6.3). All mail egress goes through this interface;
 * nothing outside the implementing module may import a Cloudflare email API.
 * v1 ships a single CloudflareEmailProvider in services/api.
 */

export interface OutboundMime {
  from: string;
  to: string[];
  raw: string; // full RFC 5322 message
}

export interface DomainRecord {
  domain_id: string;
  organization_id: string | null;
  name: string;
  verified: boolean;
}

export interface DnsRecord {
  type: "MX" | "TXT" | "CNAME" | "NS";
  name: string;
  value: string;
  priority?: number;
}

export interface DomainVerification {
  verified: boolean;
  pending: DnsRecord[];
}

export interface SendOutcome {
  providerMessageId: string;
  accepted: string[];
  rejected: { address: string; error: string }[];
}

export interface MailProvider {
  /** Per-recipient outcomes: a partial failure must not erase acceptances. */
  send(msg: OutboundMime): Promise<SendOutcome>;
  verifyDomain(domain: DomainRecord): Promise<DomainVerification>;
  requiredDnsRecords(domain: DomainRecord): DnsRecord[];
}
