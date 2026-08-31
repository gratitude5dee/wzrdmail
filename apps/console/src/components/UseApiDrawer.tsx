import { useState } from "react";
import { API_BASE } from "../api";

export interface ApiExample {
  title: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function curlSnippet(ex: ApiExample): string {
  const body = ex.body ? ` \\\n  -d '${JSON.stringify(ex.body)}'` : "";
  return `curl -X ${ex.method} ${API_BASE}${ex.path} \\\n  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\\n  -H "Content-Type: application/json"${body}`;
}

function cliSnippet(ex: ApiExample): string {
  return `npx wzrdmail api ${ex.method.toLowerCase()} ${ex.path}${
    ex.body ? ` --data '${JSON.stringify(ex.body)}'` : ""
  }`;
}

function pythonSnippet(ex: ApiExample): string {
  return `import requests\n\nresp = requests.request(\n    "${ex.method}",\n    "${API_BASE}${ex.path}",\n    headers={"Authorization": f"Bearer {WZRDMAIL_API_KEY}"},${
    ex.body ? `\n    json=${JSON.stringify(ex.body)},` : ""
  }\n)\nprint(resp.json())`;
}

function tsSnippet(ex: ApiExample): string {
  return `const resp = await fetch("${API_BASE}${ex.path}", {\n  method: "${ex.method}",\n  headers: {\n    Authorization: \`Bearer \${process.env.WZRDMAIL_API_KEY}\`,\n    "Content-Type": "application/json"\n  }${ex.body ? `,\n  body: JSON.stringify(${JSON.stringify(ex.body)})` : ""}\n});\nconsole.log(await resp.json());`;
}

const TABS = ["cURL", "CLI", "Python", "TypeScript"] as const;

export function UseApiDrawer({
  examples,
  onClose
}: {
  examples: ApiExample[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("cURL");
  const render = (ex: ApiExample) =>
    tab === "cURL"
      ? curlSnippet(ex)
      : tab === "CLI"
        ? cliSnippet(ex)
        : tab === "Python"
          ? pythonSnippet(ex)
          : tsSnippet(ex);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <h2>Use the API</h2>
        <p className="dim">
          Everything on this page is a public API operation. Authenticate with{" "}
          <span className="mono">Authorization: Bearer wm_…</span>
        </p>
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        {examples.map((ex) => (
          <div key={ex.title}>
            <h4>{ex.title}</h4>
            <pre className="code">{render(ex)}</pre>
            <button
              className="btn sm"
              onClick={() => void navigator.clipboard.writeText(render(ex))}
            >
              Copy
            </button>
          </div>
        ))}
        <div style={{ marginTop: 16 }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}
