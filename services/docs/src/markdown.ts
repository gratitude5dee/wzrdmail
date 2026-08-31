/**
 * Minimal markdown → HTML renderer for the docs corpus.
 * Supports the subset the docs content uses: ATX headings, fenced code
 * blocks, unordered/ordered lists, tables, inline code, bold, links,
 * and paragraphs. Content is authored in-repo, so this never sees
 * untrusted input — but everything is still HTML-escaped.
 */

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2">$1</a>'
  );
  return out;
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "#").length;
      html.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      i += 1;
      continue;
    }

    if (line.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        rows.push(lines[i] ?? "");
        i += 1;
      }
      const cells = (row: string): string[] =>
        row.split("|").slice(1, -1).map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s\-|:]+\|$/.test(r));
      const [head, ...rest] = body;
      const table: string[] = ["<table>"];
      if (head !== undefined) {
        table.push(
          `<thead><tr>${cells(head)
            .map((c) => `<th>${renderInline(c)}</th>`)
            .join("")}</tr></thead>`
        );
      }
      table.push("<tbody>");
      for (const row of rest) {
        table.push(
          `<tr>${cells(row)
            .map((c) => `<td>${renderInline(c)}</td>`)
            .join("")}</tr>`
        );
      }
      table.push("</tbody></table>");
      html.push(table.join(""));
      continue;
    }

    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const items: string[] = [];
      const marker = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      while (i < lines.length && marker.test(lines[i] ?? "")) {
        items.push(
          `<li>${renderInline((lines[i] ?? "").replace(marker, ""))}</li>`
        );
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6})\s|^```|^\||^[-*]\s|^\d+\.\s/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  return html.join("\n");
}
