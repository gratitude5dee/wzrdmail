import { useEffect, useRef, useState } from "react";
import { ApiRequestError, api } from "../api";

interface MuseConnectResult {
  redirect_to: string;
}

/**
 * This page is reached only from Air's authorization Worker. It exchanges the
 * existing WZRDMail console session for a short-lived, one-use server-side
 * handoff; no Thirdweb token, email, or console session crosses to Air.
 */
export function MuseConnectPage({ signedIn }: { signedIn: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const returnTo = new URLSearchParams(window.location.search).get("return_to");

  useEffect(() => {
    if (!signedIn || !returnTo || started.current) return;
    started.current = true;
    void api<MuseConnectResult>("/console/muse/complete", {
      method: "POST",
      body: JSON.stringify({ return_to: returnTo })
    })
      .then((result) => {
        window.location.assign(result.redirect_to);
      })
      .catch((err) => {
        setError(err instanceof ApiRequestError ? err.message : "could not continue to Air");
      });
  }, [signedIn, returnTo]);

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>Connect Air</h1>
        {!returnTo ? (
          <p className="error">This connection link is invalid. Return to Muse and try again.</p>
        ) : error ? (
          <p className="error">{error}</p>
        ) : (
          <p className="dim">Your WZRDMail account is verified. Continuing to Air…</p>
        )}
      </div>
    </div>
  );
}
