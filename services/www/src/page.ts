import { PLANS } from "@wzrdmail/core";
import type { PlanLimits, PlanName } from "@wzrdmail/core";

const GB = 1024 * 1024 * 1024;

const GOLDEN_PATH = `# 1. Sign up — an agent with only curl gets an inbox
curl -X POST https://api.wzrd.tech/v0/agent/sign-up \\
  -H "Content-Type: application/json" \\
  -d '{"human_email": "dev@example.com", "username": "scout"}'
# → { "api_key": "wm_live_…", "inbox_id": "scout@wzrd.tech", "organization_id": "org_…" }

# 2. Verify with the OTP from the developer's inbox
curl -X POST https://api.wzrd.tech/v0/agent/verify \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"otp_code": "482913"}'

# 3. Send real mail to the outside world
curl -X POST https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/messages/send \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to": ["human@gmail.com"], "subject": "Report ready", "text": "Done. Reply to approve."}'

# 4. The human replies from Gmail; your webhook fires and the reply is queryable
curl https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/threads \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY"`;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function planCard(name: PlanName, plan: PlanLimits, featured: boolean): string {
  const price =
    plan.priceUsdMonthly === null
      ? "Custom"
      : plan.priceUsdMonthly === 0
        ? "$0"
        : `$${String(plan.priceUsdMonthly)}<span class="per">/mo</span>`;
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return `<div class="plan${featured ? " featured" : ""}">
  <h3>${title}</h3>
  <p class="price">${price}</p>
  <ul>
    <li>${formatNumber(plan.inboxes)} inboxes</li>
    <li>${formatNumber(plan.emailsPerMonth)} emails/mo</li>
    <li>${String(plan.storageBytes / GB)} GB storage</li>
    <li>${formatNumber(plan.customDomains)} custom domains</li>
    <li>${formatNumber(plan.seats)} ${plan.seats === 1 ? "seat" : "seats"}</li>
  </ul>
</div>`;
}

export function landingHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wzrdmail — email for AI agents</title>
<meta name="description" content="Real, persistent, two-way email inboxes for AI agents at @wzrd.tech. REST, MCP, CLI, SDKs, webhooks, WebSockets.">
<style>
:root { color-scheme: light dark; }
body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 52rem; margin: 0 auto; padding: 2rem 1rem 4rem; line-height: 1.6; }
header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3rem; }
header nav a { margin-left: 1.2rem; color: #6d28d9; }
.hero h1 { font-size: 2.4rem; margin-bottom: 0.4rem; }
.hero p.tagline { font-size: 1.2rem; opacity: 0.85; }
pre { background: rgba(127,127,127,0.12); padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; }
code { font-family: ui-monospace, monospace; }
.plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; }
.plan { border: 1px solid rgba(127,127,127,0.4); border-radius: 10px; padding: 1rem 1.2rem; }
.plan.featured { border-color: #6d28d9; }
.plan .price { font-size: 1.6rem; font-weight: 700; margin: 0.2rem 0 0.6rem; }
.plan .per { font-size: 0.9rem; font-weight: 400; opacity: 0.7; }
.plan ul { padding-left: 1.1rem; margin: 0; }
footer { margin-top: 3rem; font-size: 0.9rem; opacity: 0.8; }
a { color: #6d28d9; }
</style>
</head>
<body>
<header>
  <strong>wzrdmail</strong>
  <nav><a href="https://docs.wzrd.tech">Docs</a><a href="https://console.wzrd.tech">Console</a><a href="/llms.txt">llms.txt</a></nav>
</header>
<main>
<section class="hero">
  <h1>Email for AI agents</h1>
  <p class="tagline">Real, persistent, two-way inboxes at <code>@wzrd.tech</code> — created by API in milliseconds, addressable from the whole internet, threaded, searchable, evented. REST, MCP, CLI, SDKs, webhooks, WebSockets.</p>
</section>
<section>
  <h2>An inbox in under two minutes, with only curl</h2>
  <pre><code>${escapeHtml(GOLDEN_PATH)}</code></pre>
  <p>Any MCP client gets the same power with one line: <code>claude mcp add --transport http wzrdmail https://mcp.wzrd.tech/mcp</code></p>
</section>
<section>
  <h2>Pricing</h2>
  <div class="plans">
${planCard("free", PLANS.free, false)}
${planCard("developer", PLANS.developer, true)}
${planCard("startup", PLANS.startup, false)}
  </div>
</section>
</main>
<footer>
  <p>Migrating from AgentMail? It's a base-URL and key-prefix swap: <a href="https://docs.wzrd.tech/migrate-from-agentmail">read the guide</a>.</p>
  <p><a href="https://docs.wzrd.tech">docs.wzrd.tech</a> · <a href="https://console.wzrd.tech">console.wzrd.tech</a> · <a href="/llms.txt">/llms.txt</a> (if you are an AI agent, start there)</p>
</footer>
</body>
</html>`;
}
