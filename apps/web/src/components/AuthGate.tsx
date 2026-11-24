import { useEffect, useState } from "react";
import { api, localInstance } from "../services/api";
import { classifyPairHash } from "../pairLink";

export type AuthState = "checking" | "needed" | "ok";

interface PairPrompt {
  token: string;
  ws: string;
  mode: string;
}

/** Same-origin relay token gate. "checking" renders the quiet spinner,
 *  "needed" the token form; a good login sets the cookie and reloads. */
export function AuthGate({ auth }: { auth: Exclude<AuthState, "ok"> }) {
  const [loginToken, setLoginToken] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [cookieWarning, setCookieWarning] = useState<string | null>(null);
  const [pairPrompt, setPairPrompt] = useState<PairPrompt | null>(null);
  const [pairCopied, setPairCopied] = useState(false);

  const redeem = (token: string) => {
    setLoginBusy(true);
    setLoginError(null);
    void api
      .redeemPairToken(localInstance(), token)
      .then((res) => {
        if (res.mode && res.mode !== "web") {
          // The stored mode wins: a ws/remote invite redeemed here minted
          // a device credential instead of a cookie — the link is spent.
          setPairPrompt(null);
          setLoginError(
            `that link paired a ${res.mode} device — it is consumed; mint a fresh invite and use Connect in the app`
          );
          setLoginBusy(false);
          return;
        }
        window.location.reload();
      })
      .catch((err) => {
        setLoginError(`pairing failed: ${err instanceof Error ? err.message : String(err)}`);
        setLoginBusy(false);
      });
    // callers own the stop flag via unmount/choice
  };

  // `#pair=<token>` handling (klanker#151): only a BARE web-session link
  // auto-redeems. A fragment carrying ws=/kind= markers is a device or
  // workspace invite — burning the single-use token in a browser would
  // mint a device credential nobody holds, so the user picks intent first.
  useEffect(() => {
    const action = classifyPairHash(window.location.hash);
    if (action.kind === "none") return;
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {}
    if (action.kind === "confirm") {
      setPairPrompt({ token: action.token, ws: action.ws, mode: action.mode });
      return;
    }
    let stop = false;
    setLoginBusy(true);
    setLoginError(null);
    void api
      .redeemPairToken(localInstance(), action.token)
      .then((res) => {
        if (res.mode && res.mode !== "web") {
          if (!stop) {
            setLoginError(
              `that link paired a ${res.mode} device — it is consumed; mint a fresh invite and use Connect in the app`
            );
            setLoginBusy(false);
          }
          return;
        }
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

  if (pairPrompt) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#000000] text-white font-sans p-4">
        <div className="w-80 flex flex-col gap-3 font-mono text-xs">
          <div className="text-[#a3a3a3] tracking-widest uppercase">KLANKER</div>
          <div className="text-white">pair device or web login?</div>
          <p className="text-[#737373] leading-relaxed">
            This link {pairPrompt.ws ? (
              <>joins workspace <span className="text-white">{pairPrompt.ws}</span> — it pairs a <span className="text-white">device</span>, not a browser.</>
            ) : (
              <>carries a <span className="text-white">{pairPrompt.mode || "device"}</span> pairing token — it pairs a device, not a browser.</>
            )}{" "}
            It is single-use: redeeming it on the wrong surface consumes it.
          </p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(pairPrompt.token).then(() => setPairCopied(true)).catch(() => {});
            }}
            className="border border-[#262626] px-3 py-2 text-left hover:bg-[#171717]"
          >
            {pairCopied ? "invite copied — paste it in the app's Connect flow" : "copy invite for the app — Connect → pair device"}
          </button>
          <button
            type="button"
            disabled={loginBusy}
            onClick={() => redeem(pairPrompt.token)}
            className="border border-[#262626] px-3 py-2 hover:bg-[#171717] disabled:opacity-50"
          >
            {loginBusy ? "…" : "web login — redeem here (consumes the link)"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPairPrompt(null);
              setLoginBusy(false);
            }}
            className="text-[#525252] hover:text-white text-left"
          >
            dismiss — plain token login
          </button>
          {loginError && <div className="text-red-500">{loginError}</div>}
        </div>
      </div>
    );
  }

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
