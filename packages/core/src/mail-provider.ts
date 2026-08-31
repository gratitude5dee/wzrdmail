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

export interface MailProvider {
  send(msg: OutboundMime): Promise<{ providerMessageId: string }>;
  verifyDomain(domain: DomainRecord): Promise<DomainVerification>;
  requiredDnsRecords(domain: DomainRecord): DnsRecord[];
}
