import type { Config } from "tailwindcss";

/*
 * Tailwind theme — wired to the design tokens in app/globals.css.
 *
 * This file does NOT bake any colour, radius, or shadow value of its
 * own. Everything resolves through CSS variables, so theme switching
 * (light/dark, plus per-tenant brand overrides later) is a one-file
 * CSS variable swap. Every utility you reach for in JSX —
 * `bg-card`, `text-muted-foreground`, `shadow-card` — eventually
 * lands on a `--something` declared in globals.css.
 */
export default {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        "border-strong": "hsl(var(--border-strong))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        // Three radius tokens, one base unit. The -2 / -4 px steps
        // match shadcn convention so any copy-pasted primitive lands
        // on the right shape; the named lg/xl tokens carry the
        // card / modal sizes used elsewhere in the system.
        sm: "calc(var(--radius) - 4px)",
        md: "calc(var(--radius) - 2px)",
        lg: "var(--radius)",
        xl: "var(--radius-xl)",
      },
      fontFamily: {
        // Sans is the only UI face. next/font in app/layout.tsx
        // self-hosts Inter and exposes the variable here.
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        // Mono for code, kbd hints, IDs, tabular numbers in tables.
        // JetBrains Mono via next/font.
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      // Token-bound shadows — five elevation levels. Naming follows the
      // Material precedent (number = altitude) but the values are this
      // system's own layered stacks defined in globals.css. Stick to
      // these; never hand-roll a shadow inline.
      boxShadow: {
        e1: "var(--shadow-e1)",
        e2: "var(--shadow-e2)",
        e3: "var(--shadow-e3)",
        e4: "var(--shadow-e4)",
        e5: "var(--shadow-e5)",
        // Compatibility aliases for existing code paths.
        subtle: "var(--shadow-e1)",
        card: "var(--shadow-e2)",
        elevated: "var(--shadow-e4)",
      },
      // Motion tokens — exposed as Tailwind utilities so component code
      // can write `duration-base ease-out` instead of inline styles.
      // The four durations match the four interaction tiers defined in
      // globals.css; the easings are the system's three official curves.
      transitionDuration: {
        instant: "var(--duration-instant)",
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
        slow: "var(--duration-slow)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
        spring: "var(--ease-spring)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        // Dialog enter — a modest scale-up combined with fade. The
        // 96 → 100 scale step matches HIG's modal entrance and avoids
        // the 95 → 100 "popping" feel that stock shadcn ships with.
        "dialog-enter": {
          from: { opacity: "0", transform: "translate(-50%, -48%) scale(0.96)" },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
        },
        "dialog-exit": {
          from: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
          to: { opacity: "0", transform: "translate(-50%, -48%) scale(0.98)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-1000px 0" },
          "100%": { backgroundPosition: "1000px 0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down var(--duration-base) var(--ease-out)",
        "accordion-up": "accordion-up var(--duration-base) var(--ease-out)",
        "fade-in": "fade-in var(--duration-fast) var(--ease-out)",
        "fade-in-up": "fade-in-up var(--duration-base) var(--ease-out)",
        "slide-in-right": "slide-in-right var(--duration-base) var(--ease-out)",
        "dialog-enter": "dialog-enter var(--duration-slow) var(--ease-out)",
        "dialog-exit": "dialog-exit var(--duration-fast) var(--ease-in-out)",
        shimmer: "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
