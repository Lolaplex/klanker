import { useEffect, useState } from "react";
import { api, localInstance } from "../services/api";
import { extractPairTokenFromHash } from "../relayEvents";

export type AuthState = "checking" | "needed" | "ok";

/** Same-origin relay token gate. "checking" renders the quiet spinner,
 *  "needed" the token form; a good login sets the cookie and reloads. */
export function AuthGate({ auth }: { auth: Exclude<AuthState, "ok"> }) {
  const [loginToken, setLoginToken] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [cookieWarning, setCookieWarning] = useState<string | null>(null);

  // Single-use `#pair=<token>` auto-redeem: scrub hash immediately from
  // location history, exchange for HttpOnly cookie, and reload on success.
  useEffect(() => {
    const pairToken = extractPairTokenFromHash(window.location.hash);
    if (!pairToken) return;
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {}
    let stop = false;
    setLoginBusy(true);
    setLoginError(null);
    void api
      .redeemPairToken(localInstance(), pairToken)
      .then(() => {
        if (!stop) window.location.reload();
      })
      .catch((err) => {
        if (!stop) {
          setLoginError(`pairing failed: ${err instanceof Error ? err.message : String(err)}`);
          setLoginBusy(false);
        }
      });
    return () => {
      stop = true;
    };
  }, []);

  // The relay reports an actionable warning when the session cookie was
  // minted under a different scheme/host (X-Forwarded-Proto mismatch).
  useEffect(() => {
    let stop = false;
    void fetch("/v1/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!stop && s?.cookie_warning) setCookieWarning(String(s.cookie_warning));
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loginBusy || !loginToken.trim()) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      await api.login(localInstance(), loginToken.trim());
      window.location.reload();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
      setLoginBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#000000] text-white font-sans">
      {auth === "needed" ? (
        <form onSubmit={submitLogin} className="w-72 flex flex-col gap-3 font-mono text-xs">
          <div className="text-[#a3a3a3] tracking-widest uppercase">KLANKER</div>
          <input
            type="password"
            value={loginToken}
            onChange={(e) => setLoginToken(e.target.value)}
            placeholder="relay web token"
            autoFocus
            className="bg-[#0a0a0a] border border-[#262626] px-3 py-2 outline-none focus:border-[#525252]"
          />
          {loginError && <div className="text-red-500">{loginError}</div>}
          {cookieWarning && <div className="text-amber-500">{cookieWarning}</div>}
          <button
            type="submit"
            disabled={loginBusy}
            className="border border-[#262626] px-3 py-2 hover:bg-[#171717] disabled:opacity-50"
          >
            {loginBusy ? "..." : "unlock"}
          </button>
        </form>
      ) : (
        <div className="text-[#525252] font-mono text-xs">…</div>
      )}
    </div>
  );
}
