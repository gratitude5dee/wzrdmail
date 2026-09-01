import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { createThirdwebClient } from "thirdweb";
import { ConnectEmbed, ThirdwebProvider, useActiveWallet, useAuthToken } from "thirdweb/react";
import { inAppWallet } from "thirdweb/wallets";
import { ApiRequestError, api } from "../api";
import CardNav from "../components/reactbits/CardNav";

const Silk = lazy(() => import("../components/reactbits/Silk"));

class SilkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const NAV_ITEMS = [
  {
    label: "Product",
    bgColor: "#1b1728",
    textColor: "#e7e9ee",
    links: [
      { label: "Landing", href: "https://mail.wzrd.tech", ariaLabel: "wzrdmail landing page" },
      { label: "Docs", href: "https://mail.wzrd.tech/docs", ariaLabel: "wzrdmail documentation" }
    ]
  },
  {
    label: "Build",
    bgColor: "#221c33",
    textColor: "#e7e9ee",
    links: [
      { label: "API reference", href: "https://mail.wzrd.tech/docs", ariaLabel: "API reference" },
      { label: "llms.txt", href: "https://mail.wzrd.tech/llms.txt", ariaLabel: "llms.txt" }
    ]
  },
  {
    label: "Agents",
    bgColor: "#2a2340",
    textColor: "#e7e9ee",
    links: [
      { label: "MCP server", href: "https://mcp.mail.wzrd.tech/mcp", ariaLabel: "MCP server" },
      { label: "Quickstart", href: "https://mail.wzrd.tech/docs", ariaLabel: "Agent quickstart" }
    ]
  }
];

declare const __THIRDWEB_CLIENT_ID__: string;

const client = createThirdwebClient({ clientId: __THIRDWEB_CLIENT_ID__ });

// Accounts are keyed by verified email, so only email-bearing auth methods
// are offered (passkey-only profiles carry no email).
const wallets = [
  inAppWallet({
    auth: { options: ["google", "apple", "email"] }
  })
];

const SIGNED_OUT_KEY = "wzrdmail:signed-out";

interface ExchangeResult {
  registered: boolean;
  email?: string;
  organization_id?: string;
}

function LoginInner({ onLogin }: { onLogin: () => Promise<void> }) {
  const authToken = useAuthToken();
  const wallet = useActiveWallet();
  const [stage, setStage] = useState<"connect" | "username" | "finishing" | "session-retry">(
    "connect"
  );
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
        try {
          await onLogin();
        } catch {
          // The session cookie is already set; only loading it failed.
          setStage("session-retry");
          setError("signed in, but loading the console failed");
        }
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
    if (!authToken || stage !== "connect" || exchanging.current) return;
    if (localStorage.getItem(SIGNED_OUT_KEY)) {
      // Explicit logout: drop the lingering thirdweb wallet instead of
      // silently minting a fresh session from it.
      if (wallet) {
        void wallet.disconnect().then(() => {
          localStorage.removeItem(SIGNED_OUT_KEY);
        });
      }
      return;
    }
    exchanging.current = true;
    void exchange().finally(() => {
      exchanging.current = false;
    });
  }, [authToken, stage, wallet]);

  return (
    <div className="login-scene">
      <div className="login-bg" aria-hidden="true">
        {!prefersReducedMotion && (
          <SilkBoundary>
            <Suspense fallback={null}>
              <Silk speed={4} scale={1.1} color="#2a2545" noiseIntensity={1.2} rotation={0.35} />
            </Suspense>
          </SilkBoundary>
        )}
      </div>
      <CardNav
        logo={<span className="login-nav-logo">wzrdmail</span>}
        items={NAV_ITEMS}
        baseColor="rgba(19, 21, 25, 0.92)"
        menuColor="#e7e9ee"
        cta={
          <a className="card-nav-cta-button" href="https://mail.wzrd.tech/docs">
            Read the docs
          </a>
        }
      />
      <div className="login-wrap">
      <div className="card login">
        <h1>wzrdmail console</h1>
        {stage === "session-retry" ? (
          <>
            <p className="dim">You are signed in, but the console failed to load.</p>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void onLogin()
                  .catch(() => setError("still could not load the console; try again"))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Loading…" : "Retry"}
            </button>
          </>
        ) : stage === "username" ? (
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
