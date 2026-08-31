import { useEffect, useRef, useState } from "react";
import { createThirdwebClient } from "thirdweb";
import { ConnectEmbed, ThirdwebProvider, useActiveWallet, useAuthToken } from "thirdweb/react";
import { inAppWallet } from "thirdweb/wallets";
import { ApiRequestError, api } from "../api";

declare const __THIRDWEB_CLIENT_ID__: string;

const client = createThirdwebClient({ clientId: __THIRDWEB_CLIENT_ID__ });

const wallets = [
  inAppWallet({
    auth: { options: ["google", "apple", "email", "passkey"] }
  })
];

interface ExchangeResult {
  registered: boolean;
  email?: string;
  organization_id?: string;
}

function LoginInner({ onLogin }: { onLogin: () => Promise<void> }) {
  const authToken = useAuthToken();
  const wallet = useActiveWallet();
  const [stage, setStage] = useState<"connect" | "username" | "finishing">("connect");
  const [email, setEmail] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exchanging = useRef(false);

  const exchange = async (withUsername?: string) => {
    if (!authToken) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ExchangeResult>("/console/thirdweb", {
        method: "POST",
        body: JSON.stringify(
          withUsername ? { token: authToken, username: withUsername } : { token: authToken }
        )
      });
      if (res.registered) {
        setStage("finishing");
        await onLogin();
      } else {
        setEmail(res.email ?? null);
        setStage("username");
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not complete sign-in");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (authToken && stage === "connect" && !exchanging.current) {
      exchanging.current = true;
      void exchange().finally(() => {
        exchanging.current = false;
      });
    }
  }, [authToken, stage]);

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>wzrdmail console</h1>
        {stage === "username" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void exchange(username);
            }}
          >
            <p className="dim">
              Welcome{email ? ` ${email}` : ""} — pick a username to create your organization.
            </p>
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
            <button className="btn primary" disabled={busy || !username}>
              {busy ? "Creating…" : "Create account"}
            </button>
          </form>
        ) : (
          <>
            <p className="dim">Sign in or sign up with email, Google, and more.</p>
            <ConnectEmbed
              client={client}
              wallets={wallets}
              theme="dark"
              showThirdwebBranding={false}
            />
            {(busy || stage === "finishing") && <p className="dim">Signing you in…</p>}
            {authToken && !busy && stage === "connect" && error && (
              <button className="btn primary" onClick={() => void exchange()}>
                Retry sign-in
              </button>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        {stage === "username" && wallet && (
          <p className="dim" style={{ marginTop: 16 }}>
            Wrong account?{" "}
            <a
              href="#restart"
              onClick={(e) => {
                e.preventDefault();
                void wallet.disconnect().then(() => {
                  setStage("connect");
                  setEmail(null);
                  setError(null);
                });
              }}
            >
              Start over
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

export function LoginPage({ onLogin }: { onLogin: () => Promise<void> }) {
  return (
    <ThirdwebProvider>
      <LoginInner onLogin={onLogin} />
    </ThirdwebProvider>
  );
}
