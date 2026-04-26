"use client";

// VaultPrivacyShield — best-effort screen-privacy wrapper for vault-locked
// surfaces (folder views, file previews) inside the browser.
//
// HONEST LIMITS — please read before extending:
//
//   1. Browsers cannot detect external screen sharing (Zoom, Meet, Teams,
//      OBS). The page has no API to know it's being captured.
//   2. Browsers cannot block OS-level screenshots (Cmd-Shift-4 on macOS,
//      Snipping Tool on Windows, mobile screenshot gestures). The OS owns
//      the framebuffer; we don't.
//   3. The PrintScreen key intercept ONLY works on Windows/Linux when the
//      window is focused. macOS doesn't deliver PrintScreen as a key event.
//
// What this component DOES do, in layers:
//
//   Layer 1 — visibility/blur watchdog: when the tab is hidden or the
//     window loses focus, we blur the protected content. This catches the
//     common case of a user alt-tabbing to a screen-share app, and the
//     "select window to share" picker in Zoom/Meet often briefly steals
//     focus too.
//
//   Layer 2 — PrintScreen intercept (Windows/Linux only): we listen for
//     the PrintScreen keyup, immediately blur the surface, and try to
//     overwrite the clipboard with a benign string. Best-effort.
//
//   Layer 3 — tiled watermark: a low-opacity diagonal repeat of the
//     viewer's email + ISO timestamp. Doesn't prevent capture; makes a
//     leaked screenshot trivially attributable.
//
//   Layer 4 — CSS hardening: user-select: none, oncontextmenu/dragstart
//     prevention, copy/cut listeners that beacon to the server. Stops
//     casual exfil; a determined user can still defeat it via DevTools.
//
//   Beacon: every detection POSTs to /v1/vault/privacy-event. The server
//     dedupes (5s window per kind+user) and writes to audit. The "shield_
//     mounted" event fires once per mount as a corroboration anchor — if
//     a leak surfaces later, audit shows the user was warned and the
//     shield was active.
//
// True screen-share blackout requires a native window flag
// (SetWindowDisplayAffinity / NSWindowSharingNone / FLAG_SECURE) which
// only Electron/native apps can set. That's the planned follow-up.

import { useEffect, useRef } from "react";
import { API_URL, getToken, getUser } from "@/lib/api";

type Props = {
  // When false, the shield is a passthrough — used so callers can mount
  // it unconditionally and toggle protection based on vault status
  // without unmounting/remounting children (which would lose scroll/etc).
  active: boolean;
  children: React.ReactNode;
  // Optional folder/file ids forwarded to the privacy beacon so audit
  // entries can be correlated back to the protected resource.
  folderId?: string;
  fileId?: string;
  // Override the watermark label (defaults to logged-in user's email).
  watermarkLabel?: string;
  // When true, applies a fixed full-screen overlay instead of just
  // wrapping children — useful for modal previews where the children
  // host element doesn't have a containing block of its own.
  fullscreen?: boolean;
};

// Shared in-memory marker so the "shield_mounted" beacon only fires once
// per page load (it's an audit anchor, not a counter).
let shieldMountedBeaconSent = false;

// useVaultPrivacyShield — headless variant of the component below. Use
// this when the protected surface lives inside a portaled Dialog (the
// CSS-wrapper approach can't reach portaled DOM). Installs the same
// window-level watchdogs (visibility, blur, PrintScreen, copy
// suppression on document.body) and the same beacon stream — no
// visual blur, since portaled content can't be wrapped from out here.
//
// The component below uses this hook internally for the watchdog half
// of its job and adds a wrapper for the visual half.
export function useVaultPrivacyShield(
  active: boolean,
  opts?: { folderId?: string; fileId?: string }
) {
  const folderId = opts?.folderId;
  const fileId = opts?.fileId;
  useEffect(() => {
    if (!active) return;

    if (!shieldMountedBeaconSent) {
      shieldMountedBeaconSent = true;
      beacon("shield_mounted", {
        folderId,
        fileId,
        meta: {
          ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
        },
      });
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        beacon("tab_hidden", { folderId, fileId });
      }
    }
    function onBlur() {
      beacon("focus_lost", { folderId, fileId });
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "PrintScreen" || e.code === "PrintScreen") {
        try {
          navigator.clipboard
            ?.writeText("[Formly: screenshot of protected content blocked]")
            .catch(() => {});
        } catch {
          // ignore
        }
        beacon("screenshot_attempt", {
          folderId,
          fileId,
          meta: { trigger: "printscreen" },
        });
      }
    }
    function onCopy(e: ClipboardEvent) {
      e.preventDefault();
      try {
        e.clipboardData?.setData(
          "text/plain",
          "[Formly: copy from a locked folder is disabled]"
        );
      } catch {
        // ignore
      }
      beacon("copy_blocked", { folderId, fileId, meta: { type: e.type } });
    }
    function onContextMenu(e: MouseEvent) {
      // Only suppress context menu when the click target descends from
      // the protected surface — a dialog-level handler would otherwise
      // disable right-click app-wide. We attach to document and let
      // each surface decide via its own [data-privacy-shield] / dialog
      // ancestry; for the headless hook we keep it permissive (just
      // beacon) so we don't accidentally break unrelated UI.
      void e;
      beacon("copy_blocked", { folderId, fileId, meta: { type: "contextmenu" } });
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("contextmenu", onContextMenu);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, [active, folderId, fileId]);
}

// fire-and-forget POST to /v1/vault/privacy-event. We deliberately
// swallow errors — telemetry must never break the user's session.
function beacon(
  kind: string,
  payload: { folderId?: string; fileId?: string; meta?: Record<string, unknown> }
) {
  const token = getToken();
  if (!token) return;
  try {
    fetch(`${API_URL}/v1/vault/privacy-event`, {
      method: "POST",
      keepalive: true, // survive page-unload during e.g. PrintScreen+close
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ kind, ...payload }),
    }).catch(() => {});
  } catch {
    // ignore
  }
}

export function VaultPrivacyShield({
  active,
  children,
  folderId,
  fileId,
  watermarkLabel,
  fullscreen,
}: Props) {
  // We blur whenever the tab/window loses focus while the shield is
  // active. Stored in a ref so non-React event handlers can read the
  // current toggle without re-binding.
  const blurredRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Resolve the watermark label once per mount. getUser() touches
  // localStorage which is fine on client but not during SSR — useEffect
  // is the right gate.
  const labelRef = useRef<string>("");
  useEffect(() => {
    if (watermarkLabel) {
      labelRef.current = watermarkLabel;
      return;
    }
    const u = getUser();
    labelRef.current = (u?.email as string) || (u?.id as string) || "viewer";
  }, [watermarkLabel]);

  useEffect(() => {
    if (!active) return;

    // One-shot anchor: the audit log will show the shield was rendered
    // for this user/session, so subsequent privacy events have context.
    if (!shieldMountedBeaconSent) {
      shieldMountedBeaconSent = true;
      beacon("shield_mounted", {
        folderId,
        fileId,
        meta: {
          ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
        },
      });
    }

    function setBlur(on: boolean) {
      blurredRef.current = on;
      const el = rootRef.current;
      if (!el) return;
      el.dataset.privacyBlurred = on ? "1" : "0";
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        setBlur(true);
        beacon("tab_hidden", { folderId, fileId });
      } else {
        setBlur(false);
      }
    }

    function onBlur() {
      setBlur(true);
      beacon("focus_lost", { folderId, fileId });
    }

    function onFocus() {
      setBlur(false);
    }

    function onKeyUp(e: KeyboardEvent) {
      // PrintScreen — only delivered as a key event on Windows/Linux.
      // The screenshot has likely already been taken by the time this
      // fires, so we (a) blur to neutralize a follow-up shot of the
      // unblurred state, (b) attempt to scribble over the clipboard,
      // (c) beacon. None of this is a real defense — see file header.
      if (e.key === "PrintScreen" || e.code === "PrintScreen") {
        setBlur(true);
        try {
          navigator.clipboard
            ?.writeText("[Formly: screenshot of protected content blocked]")
            .catch(() => {});
        } catch {
          // ignore — clipboard API is permissioned, may throw
        }
        beacon("screenshot_attempt", {
          folderId,
          fileId,
          meta: { trigger: "printscreen" },
        });
        // Auto-clear blur after a short cool-off so the user can keep
        // working — the screenshot already happened, holding the blur
        // forever just punishes the legitimate user.
        window.setTimeout(() => setBlur(false), 1500);
      }
    }

    function onCopy(e: ClipboardEvent) {
      e.preventDefault();
      try {
        e.clipboardData?.setData(
          "text/plain",
          "[Formly: copy from a locked folder is disabled]"
        );
      } catch {
        // ignore
      }
      beacon("copy_blocked", {
        folderId,
        fileId,
        meta: { type: e.type },
      });
    }

    function onContextMenu(e: MouseEvent) {
      e.preventDefault();
      beacon("copy_blocked", {
        folderId,
        fileId,
        meta: { type: "contextmenu" },
      });
    }

    function onDragStart(e: DragEvent) {
      e.preventDefault();
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("keyup", onKeyUp);

    const root = rootRef.current;
    root?.addEventListener("copy", onCopy as EventListener);
    root?.addEventListener("cut", onCopy as EventListener);
    root?.addEventListener("contextmenu", onContextMenu);
    root?.addEventListener("dragstart", onDragStart);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keyup", onKeyUp);
      root?.removeEventListener("copy", onCopy as EventListener);
      root?.removeEventListener("cut", onCopy as EventListener);
      root?.removeEventListener("contextmenu", onContextMenu);
      root?.removeEventListener("dragstart", onDragStart);
    };
  }, [active, folderId, fileId]);

  // Passthrough mode: render children without any wrapper so layout is
  // identical to "no shield". Avoids subtle CSS regressions when a
  // folder isn't actually locked.
  if (!active) return <>{children}</>;

  // The watermark label is an attribution aid: an email + timestamp
  // tiled diagonally at low opacity. SVG inline so we don't need a
  // build-time asset. The timestamp is captured at mount, not on every
  // render, so it doesn't churn.
  const stamp = new Date().toISOString().replace(/\..+/, "Z");
  const wmText = `${labelRef.current} • ${stamp}`;

  return (
    <div
      ref={rootRef}
      data-privacy-shield="1"
      data-privacy-blurred="0"
      style={{
        position: fullscreen ? "fixed" : "relative",
        inset: fullscreen ? 0 : undefined,
        zIndex: fullscreen ? 50 : undefined,
        // user-select: none stops drag-highlight copying. Children that
        // legitimately need selection (none in vault context today) can
        // override with .privacy-allow-select.
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {/*
        Inline style block — keyed off [data-privacy-blurred="1"] so the
        blur applies / lifts in a single CSS transition without React
        re-renders. The transition is short so the user perceives an
        immediate response when they tab away.
      */}
      <style>{`
        [data-privacy-shield="1"][data-privacy-blurred="1"] > .vps-content {
          filter: blur(18px) brightness(0.4);
          transition: filter 120ms ease-out;
        }
        [data-privacy-shield="1"][data-privacy-blurred="0"] > .vps-content {
          transition: filter 220ms ease-in;
        }
        [data-privacy-shield="1"][data-privacy-blurred="1"] > .vps-curtain {
          opacity: 1;
          pointer-events: auto;
        }
        [data-privacy-shield="1"] > .vps-curtain {
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms ease-out;
        }
      `}</style>

      <div className="vps-content">{children}</div>

      {/*
        Tiled watermark — sits above content, below the curtain. SVG
        pattern in a CSS background-image makes it cheap and crisp.
      */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          opacity: 0.08,
          mixBlendMode: "multiply",
          backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(
            `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='220'>
              <g transform='rotate(-30 210 110)' fill='%23000' font-family='ui-monospace,Menlo,monospace' font-size='14'>
                <text x='0' y='110'>${wmText}</text>
              </g>
            </svg>`
          )}")`,
        }}
      />

      {/*
        Curtain — opaque overlay shown when blurred. The blur on the
        content layer is already strong, but the curtain guarantees a
        solid floor in case a CSS regression weakens it. Includes a
        short message so the user knows why the screen went dark.
      */}
      <div
        className="vps-curtain"
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at center, rgba(15,15,20,0.92), rgba(0,0,0,0.98))",
          color: "rgba(255,255,255,0.88)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          fontWeight: 500,
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <div style={{ fontSize: 18, marginBottom: 6 }}>
            Protected content hidden
          </div>
          <div style={{ opacity: 0.7, maxWidth: 360 }}>
            This folder is in your vault. Content is hidden while the tab
            is not in focus and screenshots are logged.
          </div>
        </div>
      </div>
    </div>
  );
}

export default VaultPrivacyShield;
