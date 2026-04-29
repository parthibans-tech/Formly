"use client";

import { useReducedMotion } from "framer-motion";

export function AnimatedMesh() {
  const reduced = useReducedMotion();
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.18),transparent_55%)]" />
      <div
        className={
          "absolute -top-32 -left-24 h-[28rem] w-[28rem] rounded-full bg-primary/20 blur-3xl " +
          (reduced ? "" : "animate-blob-1")
        }
      />
      <div
        className={
          "absolute -top-10 right-[-6rem] h-[26rem] w-[26rem] rounded-full bg-cyan-400/20 blur-3xl dark:bg-cyan-300/10 " +
          (reduced ? "" : "animate-blob-2")
        }
      />
      <div
        className={
          "absolute bottom-[-8rem] left-1/3 h-[24rem] w-[24rem] rounded-full bg-fuchsia-400/15 blur-3xl dark:bg-fuchsia-300/10 " +
          (reduced ? "" : "animate-blob-3")
        }
      />
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.18] dark:opacity-[0.12]"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern
            id="grid"
            width="56"
            height="56"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 56 0 L 0 0 0 56"
              fill="none"
              stroke="hsl(var(--foreground))"
              strokeOpacity="0.15"
              strokeWidth="1"
            />
          </pattern>
          <radialGradient id="mask" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="white" stopOpacity="1" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <mask id="grid-mask">
            <rect width="100%" height="100%" fill="url(#mask)" />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="url(#grid)"
          mask="url(#grid-mask)"
        />
      </svg>
    </div>
  );
}
