import { useState } from "react";
import { ApiRequestError, api } from "../api";

export function LoginPage({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/console/login", { method: "POST", body: JSON.stringify({ email }) });
      setStage("code");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not send the code");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/console/verify", {
        method: "POST",
        body: JSON.stringify({ email, otp_code: code })
      });
      await onLogin();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not verify the code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>wzrdmail console</h1>
        <p className="dim">Sign in with the email that owns your organization.</p>
        {stage === "email" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
          >
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
            <button className="btn primary" disabled={busy || !email}>
              {busy ? "Sending…" : "Send sign-in code"}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <p className="dim">
              We sent a 6-digit code to <b>{email}</b>.
            </p>
            <div className="field">
              <label>Code</label>
              <input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
                required
              />
            </div>
            <button className="btn primary" disabled={busy || code.length < 6}>
              {busy ? "Verifying…" : "Sign in"}
            </button>{" "}
            <button type="button" className="btn" onClick={() => setStage("email")}>
              Back
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
        <p className="dim" style={{ marginTop: 16 }}>
          No organization yet? Sign up via the API:{" "}
          <a href="https://mail.wzrd.tech/docs" target="_blank" rel="noreferrer">
            docs
          </a>
        </p>
      </div>
    </div>
  );
}
