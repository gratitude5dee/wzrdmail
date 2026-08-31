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
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32">
<link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
:root {
  --bg: #060d13;
  --bg-glow: radial-gradient(80rem 40rem at 70% -10%, rgba(34, 211, 238, 0.07), transparent 60%),
             radial-gradient(50rem 30rem at 10% 0%, rgba(56, 130, 246, 0.06), transparent 55%);
  --surface: #0b141c;
  --surface-2: #101b25;
  --ring: rgba(148, 199, 214, 0.14);
  --border: rgba(148, 199, 214, 0.12);
  --text: #e7eef3;
  --muted: #71838f;
  --muted-2: #9db0bb;
  --accent: #4cc7e6;
  --accent-2: #7dd3fc;
  --accent-soft: rgba(76, 199, 230, 0.14);
  --outline: rgba(148, 199, 214, 0.22);
  --hard: rgba(0, 0, 0, 0.45);
  --shadow-hard: 0 8px 30px rgba(0, 0, 0, 0.35);
  --chrome-top: rgba(255, 255, 255, 0.04);
  --font-chrome: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); background-image: var(--bg-glow); background-repeat: no-repeat;
  color: var(--text);
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
header .brand { display: inline-flex; align-items: center; gap: 0.55rem; font-weight: 700; font-size: 1.05rem; color: var(--text); }
header .brand:hover { text-decoration: none; }
header .brand img { width: 26px; height: 26px; display: block; }
header nav a {
  margin-left: 0.4rem; color: var(--muted-2); padding: 5px 10px;
  border: 1px solid transparent; border-radius: 7px;
}
header nav a:hover { text-decoration: none; color: var(--text); background: var(--surface-2); }
.hero .eyebrow { color: var(--muted); margin-bottom: 0.6rem; }
.hero .heromark { width: 64px; height: 64px; margin-bottom: 1.1rem; display: block; filter: drop-shadow(0 6px 24px rgba(34, 211, 238, 0.25)); }
.hero h1 {
  font-size: 2.7rem; letter-spacing: -0.03em; line-height: 1.12; margin: 0 0 0.7rem;
  background: linear-gradient(92deg, var(--text) 25%, var(--accent-2) 55%, var(--text) 85%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.hero p.tagline { font-size: 1.12rem; color: var(--muted-2); max-width: 42rem; }
.cta { display: flex; gap: 0.7rem; margin: 1.4rem 0 0; }
.btn {
  display: inline-flex; align-items: center; padding: 8px 14px;
  background: var(--accent); color: #04121a;
  border: 1px solid rgba(125, 211, 252, 0.5); border-radius: 7px;
  font-family: var(--font-chrome); font-size: 10px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
  box-shadow: 0 4px 18px rgba(76, 199, 230, 0.25);
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
.plan.featured { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-soft), 0 8px 30px rgba(76, 199, 230, 0.12), inset 0 2px 0 var(--chrome-top); }
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
  <a class="brand" href="/"><img src="/logo.png" alt="wzrdmail logo" width="26" height="26">wzrdmail</a>
  <nav><a href="https://docs.wzrd.tech">Docs</a><a href="https://console.wzrd.tech">Console</a><a href="/llms.txt">llms.txt</a></nav>
</header>
<main>
<section class="hero">
  <img class="heromark" src="/logo.png" alt="" width="64" height="64">
  <p class="eyebrow chrome">@wzrd.tech · rest · mcp · cli · sdks · webhooks · websockets</p>
  <h1>Email for AI agents</h1>
  <p class="tagline">Real, persistent, two-way inboxes at <code>@wzrd.tech</code> — created by API in milliseconds, addressable from the whole internet, threaded, searchable, evented.</p>
  <div class="cta">
    <a class="btn" href="https://docs.wzrd.tech/quickstart">Get started</a>
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
  <p>Migrating from AgentMail? It's a base-URL and key-prefix swap: <a href="https://docs.wzrd.tech/migrate-from-agentmail">read the guide</a>.</p>
  <p><a href="https://docs.wzrd.tech">docs.wzrd.tech</a> · <a href="https://console.wzrd.tech">console.wzrd.tech</a> · <a href="/llms.txt">/llms.txt</a> (if you are an AI agent, start there)</p>
</footer>
</body>
</html>`;
}
