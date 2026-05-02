"use client";

// Mounts the Web Vitals collector exactly once per browser tab.
// Renders nothing — it's a thin wrapper around startRUM() that
// satisfies React's "side effects belong in useEffect" rule and
// gives us a single import site on app/layout.tsx.
//
// Why a component (not just a top-level call in layout.tsx):
// layout.tsx is a server component, so a top-level browser-API
// import there would crash the SSR build. A "use client" file with
// a no-render component is the canonical Next App Router seam for
// "do this in the browser as the tree hydrates."

import { useEffect } from "react";
import { startRUM } from "@/lib/rum";

export function RUMCollector() {
  useEffect(() => {
    // startRUM is internally idempotent (a `started` guard), so
    // StrictMode's double-effect-in-dev doesn't double-subscribe.
    startRUM();
  }, []);
  return null;
}
