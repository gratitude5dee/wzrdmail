import { SCOPE_LABELS, type Scope } from "./scopes.js";

/**
 * The consent pages (muse.md §7.4).
 *
 * Plain server-rendered HTML with no client framework and no third-party
 * script: this Worker has no bundler, and a sign-in page is the last place to
 * start loading someone else's JavaScript. Styling mirrors the docs site's
 * dark theme so the flow does not look like a phishing page to the person
 * who just got sent here from another product.
 */

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0b0f; color: #e8e8ed; padding: 24px;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { width: 100%; max-width: 420px; }
  .card { background: #141419; border: 1px solid #26262e; border-radius: 14px; padding: 28px; }
  h1 { font-size: 19px; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { color: #a0a0ab; margin: 0 0 18px; }
  p.tight { margin-bottom: 10px; }
  label { display: block; font-size: 13px; color: #c8c8d2; margin: 0 0 6px; }
  input[type="text"], input[type="email"] {
    width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid #33333d;
    background: #0e0e13; color: #e8e8ed; font-size: 15px; font-family: inherit;
  }
  input:focus { outline: 2px solid #6d5efc; outline-offset: 1px; border-color: transparent; }
  .suffix { display: flex; align-items: center; gap: 8px; }
  .suffix input { flex: 1; }
  .suffix span { color: #8a8a96; font-size: 14px; }
  button {
    width: 100%; margin-top: 18px; padding: 11px 14px; border-radius: 9px; border: 0;
    background: #6d5efc; color: #fff; font-size: 15px; font-weight: 550; font-family: inherit;
    cursor: pointer;
  }
  button:hover { background: #7d70ff; }
  button.secondary { background: transparent; color: #a0a0ab; border: 1px solid #33333d; margin-top: 8px; }
  ul.scopes { list-style: none; padding: 0; margin: 0 0 4px; }
  ul.scopes li { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid #1f1f27; align-items: flex-start; }
  ul.scopes li:last-child { border-bottom: 0; }
  ul.scopes input { margin-top: 3px; }
  ul.scopes label { margin: 0; color: #e8e8ed; font-size: 14px; }
  .locked { color: #8a8a96; font-size: 12px; }
  .error { background: #2a1416; border: 1px solid #5c2027; color: #ffb4b4; padding: 10px 12px; border-radius: 9px; margin: 0 0 16px; font-size: 14px; }
  .brand { display: flex; align-items: center; gap: 9px; margin: 0 0 20px; }
  .brand b { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .dot { width: 9px; height: 9px; border-radius: 3px; background: #6d5efc; }
  .foot { color: #6f6f7b; font-size: 12px; text-align: center; margin: 16px 0 0; }
  .inbox { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfcfd8; }
`;

const page = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex">` +
      `<title>${escapeHtml(title)} · wzrdmail</title><style>${STYLE}</style></head>` +
      `<body><main><div class="brand"><span class="dot"></span><b>wzrdmail</b></div>` +
      `<div class="card">${body}</div>` +
      `<p class="foot">You are connecting an app to your wzrdmail account.</p>` +
      `</main></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

const errorBlock = (error: string | null): string =>
  error === null ? "" : `<p class="error">${escapeHtml(error)}</p>`;

const hidden = (nonce: string): string =>
  `<input type="hidden" name="csrf" value="${escapeHtml(nonce)}">`;

export const emailPage = (clientName: string, nonce: string, error: string | null): Response =>
  page(
    "Connect",
    `<h1>Connect ${escapeHtml(clientName)}</h1>` +
      `<p>Sign in with your email to give ${escapeHtml(clientName)} access to a wzrdmail inbox. ` +
      `No account yet? You will get one, and your agent will get its own address.</p>` +
      errorBlock(error) +
      `<form method="post" action="/authorize/email">${hidden(nonce)}` +
      `<label for="email">Email address</label>` +
      `<input id="email" name="email" type="email" autocomplete="email" required autofocus ` +
      `placeholder="you@example.com">` +
      `<button type="submit">Continue</button></form>`
  );

export const usernamePage = (
  clientName: string,
  email: string,
  nonce: string,
  error: string | null
): Response =>
  page(
    "Choose an address",
    `<h1>Give ${escapeHtml(clientName)} its own address</h1>` +
      `<p>No wzrdmail account uses ${escapeHtml(email)} yet, so we will create one. ` +
      `Pick the address your agent will send and receive mail from.</p>` +
      errorBlock(error) +
      `<form method="post" action="/authorize/signup">${hidden(nonce)}` +
      `<label for="username">Address</label>` +
      `<div class="suffix"><input id="username" name="username" type="text" required autofocus ` +
      `pattern="[a-z0-9._-]{3,64}" placeholder="scout"><span>@wzrd.tech</span></div>` +
      `<button type="submit">Send me a code</button></form>`
  );

export const codePage = (email: string, nonce: string, error: string | null): Response =>
  page(
    "Enter your code",
    `<h1>Check your email</h1>` +
      `<p>We sent a one-time code to ${escapeHtml(email)}. It expires in ten minutes.</p>` +
      errorBlock(error) +
      `<form method="post" action="/authorize/verify">${hidden(nonce)}` +
      `<label for="otp_code">One-time code</label>` +
      `<input id="otp_code" name="otp_code" type="text" inputmode="numeric" autocomplete="one-time-code" ` +
      `required autofocus pattern="[0-9]{6}" placeholder="123456">` +
      `<button type="submit">Verify</button></form>`
  );

export const consentPage = (input: {
  clientName: string;
  requestedScopes: Scope[];
  inboxes: { inbox_id: string }[];
  newUser: boolean;
  nonce: string;
  error: string | null;
}): Response => {
  const scopeItems = input.requestedScopes
    .map((scope) => {
      const locked = scope === "mail:read";
      const checkbox = locked
        ? `<input type="checkbox" id="${scope}" name="scopes" value="${scope}" checked disabled>` +
          `<input type="hidden" name="scopes" value="${scope}">`
        : `<input type="checkbox" id="${scope}" name="scopes" value="${scope}" checked>`;
      return (
        `<li>${checkbox}<div><label for="${scope}">${escapeHtml(SCOPE_LABELS[scope])}</label>` +
        (locked ? `<div class="locked">Always required</div>` : "") +
        `</div></li>`
      );
    })
    .join("");

  const inboxChoice =
    input.inboxes.length <= 1
      ? input.inboxes
          .map(
            (inbox) =>
              `<input type="hidden" name="inbox_id" value="${escapeHtml(inbox.inbox_id)}">` +
              `<p class="tight">Inbox: <span class="inbox">${escapeHtml(inbox.inbox_id)}</span></p>`
          )
          .join("")
      : `<label for="inbox_id">Inbox</label><select id="inbox_id" name="inbox_id" style="width:100%;padding:10px 12px;border-radius:9px;border:1px solid #33333d;background:#0e0e13;color:#e8e8ed;font-size:15px;">` +
        input.inboxes
          .map(
            (inbox) =>
              `<option value="${escapeHtml(inbox.inbox_id)}">${escapeHtml(inbox.inbox_id)}</option>`
          )
          .join("") +
        `</select>`;

  return page(
    "Authorize",
    `<h1>Allow ${escapeHtml(input.clientName)}?</h1>` +
      (input.newUser
        ? `<p>Your account is ready. This connection is limited to one inbox and cannot create more.</p>`
        : `<p>This connection is limited to the one inbox you choose and cannot create more.</p>`) +
      errorBlock(input.error) +
      `<form method="post" action="/authorize/approve">${hidden(input.nonce)}` +
      inboxChoice +
      `<ul class="scopes">${scopeItems}</ul>` +
      `<button type="submit" name="decision" value="allow">Allow access</button>` +
      `<button class="secondary" type="submit" name="decision" value="deny">Cancel</button>` +
      `</form>`
  );
};

export const noticePage = (title: string, message: string): Response =>
  page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
