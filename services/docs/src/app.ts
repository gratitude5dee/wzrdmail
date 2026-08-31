import { Hono } from "hono";
import type { Context } from "hono";
import { accepts } from "./accept.js";
import { findPage, INDEX_MARKDOWN, llmsFullTxt, llmsTxt } from "./content.js";
import type { DocPage } from "./content.js";
import type { Env } from "./env.js";
import { pageHtml } from "./html.js";
import { renderMarkdown } from "./markdown.js";

function wantsMarkdown(c: Context<{ Bindings: Env }>): boolean {
  return accepts(c.req.header("Accept") ?? "", "text/markdown");
}

/**
 * The docs are mounted under a path prefix (`/docs` on mail.wzrd.tech), so
 * every generated link is written relative to it. `index.ts` strips the
 * prefix from the request before routing.
 */
export function basePath(env: Env): string {
  return (env.DOCS_BASE_PATH ?? "").replace(/\/+$/, "");
}

/** Rewrite root-relative markdown links so content honors the mount prefix. */
export function prefixRootLinks(markdown: string, prefix: string): string {
  if (prefix === "") return markdown;
  return markdown.replaceAll("](/", `](${prefix}/`);
}

function servePage(
  c: Context<{ Bindings: Env }>,
  page: DocPage,
  forceMarkdown: boolean
): Response {
  const markdown = prefixRootLinks(page.markdown, basePath(c.env));
  if (forceMarkdown || wantsMarkdown(c)) {
    return c.text(markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8"
    });
  }
  return c.html(
    pageHtml(
      page.title,
      page.description,
      renderMarkdown(markdown),
      page.slug,
      basePath(c.env)
    )
  );
}

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/llms.txt", (c) =>
    c.text(llmsTxt(), 200, { "Content-Type": "text/plain; charset=utf-8" })
  );

  app.get("/llms-full.txt", (c) =>
    c.text(prefixRootLinks(llmsFullTxt(), basePath(c.env)), 200, {
      "Content-Type": "text/plain; charset=utf-8"
    })
  );

  app.get("/health", (c) => c.json({ ok: true, env: c.env.WZRDMAIL_ENV }));

  app.get("/", (c) => {
    const markdown = prefixRootLinks(INDEX_MARKDOWN, basePath(c.env));
    if (wantsMarkdown(c)) {
      return c.text(markdown, 200, {
        "Content-Type": "text/markdown; charset=utf-8"
      });
    }
    return c.html(
      pageHtml(
        "wzrdmail docs",
        "Email for AI agents — docs for the wzrd.tech API, MCP, CLI, and SDKs.",
        renderMarkdown(markdown),
        "",
        basePath(c.env)
      )
    );
  });

  app.get("/index.md", (c) =>
    c.text(prefixRootLinks(INDEX_MARKDOWN, basePath(c.env)), 200, {
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
