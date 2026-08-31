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
:root {
  --bg: #fafafa;
  --surface: #ffffff;
  --surface-2: #f4f4f5;
  --ring: rgba(0, 0, 0, 0.08);
  --border: #e6e8ec;
  --text: #1a1a1a;
  --muted: #8a8a8e;
  --muted-2: #5f5f66;
  --accent: #2b7fff;
  --accent-soft: rgba(43, 127, 255, 0.12);
  --outline: rgba(26, 26, 26, 0.85);
  --hard: rgba(26, 26, 26, 0.18);
  --shadow-hard: 2px 2px 0 var(--hard);
  --chrome-top: rgba(255, 255, 255, 0.55);
  --font-chrome: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101012;
    --surface: #1a1a1c;
    --surface-2: #232326;
    --ring: rgba(255, 255, 255, 0.12);
    --border: #2c2c31;
    --text: #f5f5f5;
    --muted: #a3a3a3;
    --muted-2: #8b8b93;
    --accent: #4d94ff;
    --accent-soft: rgba(77, 148, 255, 0.16);
    --outline: rgba(245, 245, 245, 0.85);
    --hard: rgba(0, 0, 0, 0.5);
    --chrome-top: rgba(255, 255, 255, 0.12);
  }
}
* { box-sizing: border-box; }
body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); color: var(--text);
  letter-spacing: -0.12px; line-height: 1.65;
  max-width: 56rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.chrome {
  font-family: var(--font-chrome); font-size: 10px;
  letter-spacing: 0.08em; text-transform: uppercase;
}
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3.5rem; }
header .brand { font-weight: 700; font-size: 1.05rem; }
header nav a {
  margin-left: 0.4rem; color: var(--muted-2); padding: 5px 10px;
  border: 1px solid transparent; border-radius: 7px;
}
header nav a:hover { text-decoration: none; color: var(--text); background: var(--surface-2); }
.hero .eyebrow { color: var(--muted); margin-bottom: 0.6rem; }
.hero h1 {
  font-size: 2.7rem; letter-spacing: -0.03em; line-height: 1.12; margin: 0 0 0.7rem;
  background: linear-gradient(92deg, var(--text) 25%, var(--accent) 55%, var(--text) 85%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.hero p.tagline { font-size: 1.12rem; color: var(--muted-2); max-width: 42rem; }
.cta { display: flex; gap: 0.7rem; margin: 1.4rem 0 0; }
.btn {
  display: inline-flex; align-items: center; padding: 8px 14px;
  background: var(--text); color: var(--bg);
  border: 1px solid var(--outline); border-radius: 7px;
  font-family: var(--font-chrome); font-size: 10px;
  letter-spacing: 0.08em; text-transform: uppercase;
  box-shadow: var(--shadow-hard);
}
.btn:hover { text-decoration: none; opacity: 0.85; }
.btn.ghost { background: transparent; color: var(--muted-2); border-color: var(--ring); box-shadow: none; }
.btn.ghost:hover { opacity: 1; color: var(--text); background: var(--surface-2); }
h2 { font-size: 1.35rem; letter-spacing: -0.01em; margin-top: 3rem; }
pre {
  background: var(--surface); border: 1px solid var(--outline);
  border-radius: 8px; box-shadow: var(--shadow-hard);
  padding: 1rem 1.1rem; overflow-x: auto; font-size: 0.8rem; line-height: 1.55;
}
code { font-family: var(--font-chrome); }
p > code {
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 5px; padding: 0.08em 0.35em; font-size: 0.85em;
}
.plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1.1rem; }
.plan {
  background: var(--surface); border: 1px solid var(--outline);
  border-radius: 10px; box-shadow: var(--shadow-hard), inset 0 2px 0 var(--chrome-top);
  padding: 1.1rem 1.25rem;
}
.plan.featured { border-color: var(--accent); box-shadow: 2px 2px 0 var(--accent-soft), inset 0 2px 0 var(--chrome-top); }
.plan h3 {
  margin: 0; font-family: var(--font-chrome); font-size: 10.5px;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted-2);
}
.plan .price { font-size: 1.7rem; font-weight: 700; margin: 0.35rem 0 0.7rem; }
.plan .per { font-size: 0.85rem; font-weight: 400; color: var(--muted); }
.plan ul { padding-left: 1.1rem; margin: 0; font-size: 0.9rem; color: var(--muted-2); }
footer { margin-top: 3.5rem; padding-top: 1.2rem; border-top: 1px solid var(--border); font-size: 0.88rem; color: var(--muted-2); }
</style>
</head>
<body>
<header>
  <span class="brand">wzrdmail</span>
  <nav><a href="/docs">Docs</a><a href="https://console.wzrd.tech">Console</a><a href="/llms.txt">llms.txt</a></nav>
</header>
<main>
<section class="hero">
  <p class="eyebrow chrome">@wzrd.tech · rest · mcp · cli · sdks · webhooks · websockets</p>
  <h1>Email for AI agents</h1>
  <p class="tagline">Real, persistent, two-way inboxes at <code>@wzrd.tech</code> — created by API in milliseconds, addressable from the whole internet, threaded, searchable, evented.</p>
  <div class="cta">
    <a class="btn" href="/docs/quickstart">Get started</a>
    <a class="btn ghost" href="https://console.wzrd.tech">Open console</a>
  </div>
</section>
<section>
  <h2>An inbox in under two minutes, with only curl</h2>
  <pre><code>${escapeHtml(GOLDEN_PATH)}</code></pre>
  <p>Any MCP client gets the same power with one line: <code>claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp</code></p>
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
  <p>Migrating from AgentMail? It's a base-URL and key-prefix swap: <a href="https://mail.wzrd.tech/docs/migrate-from-agentmail">read the guide</a>.</p>
  <p><a href="/docs">mail.wzrd.tech/docs</a> · <a href="https://console.wzrd.tech">console.wzrd.tech</a> · <a href="/llms.txt">/llms.txt</a> (if you are an AI agent, start there)</p>
</footer>
</body>
</html>`;
}
