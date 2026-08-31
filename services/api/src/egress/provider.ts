import type {
  DnsRecord,
  DomainRecord,
  DomainVerification,
  MailProvider,
  OutboundMime
} from "@wzrdmail/core";
import type { Env } from "../env.js";

/**
 * The one Cloudflare `MailProvider` implementation (§6.3). Nothing outside
 * this module imports Cloudflare email APIs.
 */
export class CloudflareEmailProvider implements MailProvider {
  constructor(private readonly env: Env) {}

  async send(msg: OutboundMime): Promise<{ providerMessageId: string }> {
    if (!this.env.EMAIL) {
      throw new Error("send_email binding EMAIL is not configured in this environment");
    }
    // "cloudflare:email" only exists in deployed runtimes with a send_email
    // binding; a static import would break local dev and tests.
    const { EmailMessage } = await import("cloudflare:email");
    for (const recipient of msg.to) {
      await this.env.EMAIL.send(new EmailMessage(msg.from, recipient, msg.raw));
    }
    // Email Service reports accept/reject synchronously; the MIME
    // Message-ID is the durable correlation id for DSN reconciliation.
    const messageId = /^Message-ID:\s*<([^>]+)>/im.exec(msg.raw)?.[1] ?? crypto.randomUUID();
    return { providerMessageId: messageId };
  }

  requiredDnsRecords(domain: DomainRecord): DnsRecord[] {
    return [
      { type: "MX", name: domain.name, value: "route1.mx.cloudflare.net", priority: 5 },
      { type: "MX", name: domain.name, value: "route2.mx.cloudflare.net", priority: 22 },
      { type: "MX", name: domain.name, value: "route3.mx.cloudflare.net", priority: 87 },
      {
        type: "TXT",
        name: domain.name,
        value: "v=spf1 include:_spf.mx.cloudflare.net ~all"
      }
    ];
  }

  async verifyDomain(domain: DomainRecord): Promise<DomainVerification> {
    // Custom-domain zone onboarding is M-later (§6.6); the shared platform
    // domain is provisioned out of band and marked verified in D1.
    return {
      verified: domain.verified,
      pending: domain.verified ? [] : this.requiredDnsRecords(domain)
    };
  }
}
