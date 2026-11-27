import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { kbDebugEnabled } from "./kbDebug";
import { migrateLegacyStorage } from "./chatBuckets";
import { ThemeRoot } from "./ThemeRoot";
import { bootstrapTheme } from "./theme";
import "./index.css";

// Apply the persisted/system theme before first paint — no dark flash in
// light mode, no light flash in dark mode.
bootstrapTheme();

// One-time workspace-first storage migration (klanker#150): legacy
// `klanker.chats.<inst> …` buckets, `klanker.sel.*` selection and
// `klanker.titles` merge into the `klanker.ws.*` keyspace before any hook
// reads localStorage.
migrateLegacyStorage();

if (
  import.meta.env.PROD &&
  "serviceWorker" in navigator &&
  !("__TAURI_INTERNALS__" in window) &&
  !("__TAURI__" in window)
) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeRoot>
      <App />
    </ThemeRoot>
  </React.StrictMode>
);

// ?kbdebug=1 keyboard forensics overlay — dynamic import keeps it out of the
// default bundle path entirely; it mounts its own root so the app is untouched.
if (kbDebugEnabled(window.location.search)) {
  void import("./KbDebugOverlay").then(({ KbDebugOverlay }) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    ReactDOM.createRoot(host).render(<KbDebugOverlay />);
  });
}
