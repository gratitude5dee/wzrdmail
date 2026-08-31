import { useState } from "react";
import { ApiRequestError, api } from "../api";

export function LoginPage({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
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

  const signUp = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ delivered: boolean; message: string }>("/console/signup", {
        method: "POST",
        body: JSON.stringify({ email, username })
      });
      if (res.delivered) {
        setStage("code");
      } else {
        setError(res.message);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not create the account");
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
        <p className="dim">
          {mode === "signin"
            ? "Sign in with the email that owns your organization."
            : "Create an organization — pick your email and an inbox username."}
        </p>
        {stage === "email" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (mode === "signin" ? sendCode() : signUp());
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
            {mode === "signup" && (
              <div className="field">
                <label>Username</label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="yourname"
                  required
                />
                <p className="dim">
                  Your first inbox will be {(username || "yourname").toLowerCase()}@wzrd.tech
                </p>
              </div>
            )}
            <button
              className="btn primary"
              disabled={busy || !email || (mode === "signup" && !username)}
            >
              {busy
                ? mode === "signin"
                  ? "Sending…"
                  : "Creating…"
                : mode === "signin"
                  ? "Send sign-in code"
                  : "Create account"}
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
          {mode === "signin" ? (
            <>
              No organization yet?{" "}
              <a
                href="#signup"
                onClick={(e) => {
                  e.preventDefault();
                  setMode("signup");
                  setStage("email");
                  setError(null);
                }}
              >
                Sign up
              </a>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <a
                href="#signin"
                onClick={(e) => {
                  e.preventDefault();
                  setMode("signin");
                  setStage("email");
                  setError(null);
                }}
              >
                Sign in
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
