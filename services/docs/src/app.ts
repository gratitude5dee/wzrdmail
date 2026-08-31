import { Hono } from "hono";
import type { Context } from "hono";
import { accepts } from "./accept.js";
import { findPage, INDEX_MARKDOWN, llmsFullTxt, llmsTxt } from "./content.js";
import type { DocPage } from "./content.js";
import type { Env } from "./env.js";
import { renderMarkdown } from "./markdown.js";

function wantsMarkdown(c: Context<{ Bindings: Env }>): boolean {
  return accepts(c.req.header("Accept") ?? "", "text/markdown");
}

function pageHtml(title: string, description: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · wzrdmail docs</title>
<meta name="description" content="${description}">
<style>
:root { color-scheme: light dark; }
body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; line-height: 1.6; }
nav { margin-bottom: 2rem; font-size: 0.9rem; }
nav a { margin-right: 1rem; }
pre { background: rgba(127,127,127,0.12); padding: 1rem; border-radius: 8px; overflow-x: auto; }
code { font-family: ui-monospace, monospace; font-size: 0.9em; }
table { border-collapse: collapse; }
th, td { border: 1px solid rgba(127,127,127,0.4); padding: 0.4rem 0.7rem; text-align: left; }
a { color: #6d28d9; }
</style>
</head>
<body>
<nav><a href="/">docs.wzrd.tech</a><a href="/quickstart">Quickstart</a><a href="/migrate-from-agentmail">Migrate from AgentMail</a><a href="https://wzrd.tech">wzrd.tech</a><a href="https://console.wzrd.tech">Console</a></nav>
<main>
${body}
</main>
</body>
</html>`;
}

function servePage(
  c: Context<{ Bindings: Env }>,
  page: DocPage,
  forceMarkdown: boolean
): Response {
  if (forceMarkdown || wantsMarkdown(c)) {
    return c.text(page.markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8"
    });
  }
  return c.html(pageHtml(page.title, page.description, renderMarkdown(page.markdown)));
}

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/llms.txt", (c) =>
    c.text(llmsTxt(), 200, { "Content-Type": "text/plain; charset=utf-8" })
  );

  app.get("/llms-full.txt", (c) =>
    c.text(llmsFullTxt(), 200, { "Content-Type": "text/plain; charset=utf-8" })
  );

  app.get("/health", (c) => c.json({ ok: true, env: c.env.WZRDMAIL_ENV }));

  app.get("/", (c) => {
    if (wantsMarkdown(c)) {
      return c.text(INDEX_MARKDOWN, 200, {
        "Content-Type": "text/markdown; charset=utf-8"
      });
    }
    return c.html(
      pageHtml(
        "wzrdmail docs",
        "Email for AI agents — docs for the wzrd.tech API, MCP, CLI, and SDKs.",
        renderMarkdown(INDEX_MARKDOWN)
      )
    );
  });

  app.get("/index.md", (c) =>
    c.text(INDEX_MARKDOWN, 200, {
      "Content-Type": "text/markdown; charset=utf-8"
    })
  );

  app.get("/*", (c) => {
    const path = c.req.path.replace(/^\/+/, "").replace(/\/+$/, "");
    const forceMarkdown = path.endsWith(".md");
    const slug = forceMarkdown ? path.slice(0, -3) : path;
    const page = findPage(slug);
    if (page === undefined) {
      return c.json({ name: "not_found", message: "no such page" }, 404);
    }
    return servePage(c, page, forceMarkdown);
  });

  return app;
}
