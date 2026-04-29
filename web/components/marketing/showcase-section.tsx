"use client";

import { motion } from "framer-motion";
import {
  CheckCircle2,
  FileSignature,
  GitBranch,
  Sparkles,
  Wand2,
} from "lucide-react";

export function ShowcaseSection() {
  return (
    <section className="relative overflow-hidden py-20 sm:py-28">
      <div className="container mx-auto grid gap-16 px-4 sm:px-6 lg:grid-cols-2 lg:items-center">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.6 }}
        >
          <p className="text-sm font-medium uppercase tracking-widest text-primary">
            Built for scale
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Ship the messy paperwork in <em className="not-italic text-primary">minutes</em>
          </h2>
          <p className="mt-4 text-muted-foreground">
            Drop in a template, point at a CSV, and the queue takes care of
            generation, signature collection, delivery, and webhook fan-out.
            Every step is observable, retryable, and auditable.
          </p>

          <ul className="mt-7 space-y-3 text-sm">
            {[
              {
                icon: GitBranch,
                title: "Versioned templates",
                body: "Promote drafts to live without breaking integrations.",
              },
              {
                icon: Wand2,
                title: "Smart field mapping",
                body: "Map CSV headers once, reuse across every batch.",
              },
              {
                icon: FileSignature,
                title: "Native e-signature",
                body: "Same flow, no third-party tab-shuffling.",
              },
              {
                icon: Sparkles,
                title: "AI-assisted review",
                body: "Flag risky fields before they hit production.",
              },
            ].map((b) => (
              <li key={b.title} className="flex gap-3">
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
                  <b.icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="font-medium text-foreground">{b.title}</p>
                  <p className="text-muted-foreground">{b.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.7 }}
          className="relative"
        >
          <div className="absolute inset-0 -z-10 rounded-[2rem] bg-gradient-to-br from-primary/20 via-cyan-400/10 to-fuchsia-400/15 blur-3xl" />
          <div className="rounded-2xl border border-border bg-card p-1 shadow-elevated">
            <div className="flex items-center gap-1.5 border-b border-border/70 px-4 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-destructive/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-warning/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
              <span className="ml-3 font-mono text-[11px] text-muted-foreground">
                drive360 / batches / april-onboarding
              </span>
            </div>
            <pre className="overflow-x-auto px-5 py-4 text-[12.5px] leading-relaxed">
              <code className="font-mono">
                <Token c="muted">{"// 1. Render a template against a CSV row\n"}</Token>
                <Token c="kw">await</Token> drive360.batches.<Token c="fn">create</Token>({"{\n"}
                {"  template: "}<Token c="str">"onboarding-agreement-v3"</Token>,{"\n"}
                {"  source:   "}<Token c="str">"s3://hr/exports/q2.csv"</Token>,{"\n"}
                {"  signer:   "}<Token c="str">"row.email"</Token>,{"\n"}
                {"  webhook:  "}<Token c="str">"https://hr.acme.co/hooks/d360"</Token>,{"\n"}
                {"});\n\n"}
                <Token c="muted">{"// 2. Stream events back as they happen\n"}</Token>
                <Token c="kw">for await</Token> ({"{ event, doc }"} <Token c="kw">of</Token> drive360.events.stream()) {"{\n"}
                {"  console.log(event, doc.id, doc.url);\n"}
                {"}"}
              </code>
            </pre>
            <div className="border-t border-border/70 px-5 py-3 text-[11px] text-muted-foreground">
              <CheckCircle2 className="-mt-0.5 mr-1 inline h-3.5 w-3.5 text-success" />
              1,248 docs queued · 312 signed · 0 failed
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function Token({
  c,
  children,
}: {
  c: "kw" | "str" | "fn" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    c === "kw"
      ? "text-fuchsia-500 dark:text-fuchsia-400"
      : c === "str"
      ? "text-emerald-600 dark:text-emerald-400"
      : c === "fn"
      ? "text-cyan-600 dark:text-cyan-400"
      : "text-muted-foreground";
  return <span className={cls}>{children}</span>;
}
