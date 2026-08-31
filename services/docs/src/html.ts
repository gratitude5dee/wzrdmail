import { PAGES } from "./content.js";

/**
 * Docs shell — dark runtime-console design language (deep blue-black surfaces,
 * cyan accents, mono chrome type, Inter-ish prose) in a three-zone docs
 * layout: top header, grouped sidebar nav, content column.
 */

interface NavGroup {
  label: string;
  items: { slug: string; title: string; href: string }[];
}

function navGroups(basePath: string): NavGroup[] {
  const getStarted: NavGroup = { label: "Get Started", items: [] };
  const apiRef: NavGroup = { label: "API Reference", items: [] };
  for (const page of PAGES) {
    const item = {
      slug: page.slug,
      title: page.title.replace(/^API Reference:\s*/, ""),
      href: `${basePath}/${page.slug}`
    };
    if (page.slug.startsWith("api/")) {
      apiRef.items.push(item);
    } else {
      getStarted.items.push(item);
    }
  }
  return [getStarted, apiRef];
}

function sidebarHtml(activeSlug: string, basePath: string): string {
  return navGroups(basePath)
    .map(
      (group) => `<div class="navgroup">
<h3 class="chrome-2">${group.label}</h3>
<ul>
${group.items
  .map(
    (item) =>
      `<li><a class="navlink${item.slug === activeSlug ? " active" : ""}" href="${item.href}">${item.title}</a></li>`
  )
  .join("\n")}
</ul>
</div>`
    )
    .join("\n");
}

const STYLE = `
:root {
  --bg: #060d13;
  --bg-glow: radial-gradient(80rem 40rem at 70% -10%, rgba(34, 211, 238, 0.06), transparent 60%);
  --surface: #0b141c;
  --surface-2: #101b25;
  --ring: rgba(148, 199, 214, 0.14);
  --border: rgba(148, 199, 214, 0.12);
  --text: #e7eef3;
  --muted: #71838f;
  --muted-2: #9db0bb;
  --accent: #4cc7e6;
  --accent-soft: rgba(76, 199, 230, 0.14);
  --outline: rgba(148, 199, 214, 0.22);
  --hard: rgba(0, 0, 0, 0.45);
  --shadow-hard: 0 8px 30px rgba(0, 0, 0, 0.35);
  --font-chrome: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--bg); background-image: var(--bg-glow); background-repeat: no-repeat;
  color: var(--text);
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  letter-spacing: -0.12px; line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.chrome, .chrome-2 {
  font-family: var(--font-chrome);
  text-transform: uppercase;
}
.chrome { font-size: 10px; letter-spacing: 0.08em; }
.chrome-2 { font-size: 9px; letter-spacing: 0.12em; color: var(--muted); }
header.top {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 0.7rem 1.25rem;
  background: rgba(11, 20, 28, 0.85); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
header.top .brand {
  display: flex; align-items: center; gap: 0.55rem;
  color: var(--text); font-weight: 700;
}
header.top .brand img { width: 22px; height: 22px; display: block; }
header.top .brand:hover { text-decoration: none; }
header.top .brand .tag { color: var(--muted); font-weight: 400; }
header.top nav { display: flex; gap: 0.4rem; }
header.top nav a {
  color: var(--muted-2); padding: 5px 10px;
  border: 1px solid transparent; border-radius: 7px;
}
header.top nav a:hover {
  text-decoration: none; color: var(--text); background: var(--surface-2);
}
.layout {
  display: grid; grid-template-columns: 15.5rem minmax(0, 1fr);
  max-width: 72rem; margin: 0 auto; gap: 2.5rem;
  padding: 1.5rem 1.25rem 4rem;
}
aside.side { position: sticky; top: 4rem; align-self: start; }
.navgroup { margin-bottom: 1.4rem; }
.navgroup h3 { margin: 0 0 0.45rem; }
.navgroup ul { list-style: none; margin: 0; padding: 0; }
.navlink {
  display: block; padding: 5px 10px; margin: 1px 0;
  color: var(--muted-2); font-size: 0.86rem;
  border: 1px solid transparent; border-radius: 7px;
}
.navlink:hover { text-decoration: none; color: var(--text); background: var(--surface-2); }
.navlink.active {
  color: var(--accent); background: var(--accent-soft);
  border-color: rgba(76, 199, 230, 0.3);
}
main { min-width: 0; }
main h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin: 0.2rem 0 0.8rem; }
main h2 { font-size: 1.3rem; margin-top: 2.2rem; padding-top: 0.4rem; }
main h3 { font-size: 1.05rem; margin-top: 1.6rem; }
main pre {
  background: var(--surface); border: 1px solid var(--outline);
  border-radius: 8px; box-shadow: var(--shadow-hard);
  padding: 0.9rem 1rem; overflow-x: auto; font-size: 0.82rem; line-height: 1.55;
}
main code { font-family: var(--font-chrome); font-size: 0.88em; }
main :not(pre) > code {
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 5px; padding: 0.08em 0.35em;
}
main table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
main th, main td { border: 1px solid var(--border); padding: 0.45rem 0.7rem; text-align: left; }
main th { background: var(--surface-2); font-family: var(--font-chrome); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted-2); }
main ul, main ol { padding-left: 1.3rem; }
@media (max-width: 46rem) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  aside.side { position: static; }
  header.top nav { display: none; }
}
`;

export function pageHtml(
  title: string,
  description: string,
  body: string,
  activeSlug: string,
  basePath: string
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · wzrdmail docs</title>
<meta name="description" content="${description}">
<link rel="llms-txt" href="${basePath}/llms.txt">
<link rel="icon" href="https://mail.wzrd.tech/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" href="https://mail.wzrd.tech/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="https://mail.wzrd.tech/apple-touch-icon.png">
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="${basePath}/"><img src="https://mail.wzrd.tech/logo.png" alt="wzrdmail logo" width="22" height="22">wzrdmail <span class="tag chrome">docs</span></a>
  <nav>
    <a href="https://mail.wzrd.tech">mail.wzrd.tech</a>
    <a href="https://console.wzrd.tech">Console</a>
    <a href="${basePath}/llms.txt">llms.txt</a>
  </nav>
</header>
<div class="layout">
<aside class="side">
${sidebarHtml(activeSlug, basePath)}
</aside>
<main>
${body}
</main>
</div>
</body>
</html>`;
}
