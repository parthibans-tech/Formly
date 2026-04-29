"use client";

import { motion } from "framer-motion";
import { FileUp, Wand2, Send } from "lucide-react";

const STEPS = [
  {
    n: "01",
    icon: FileUp,
    title: "Upload your template",
    body: "Drop in a PDF or HTML doc. Drive360 detects fields and gives you a clean designer to label, validate, and brand.",
  },
  {
    n: "02",
    icon: Wand2,
    title: "Wire it to data",
    body: "Connect a CSV, an API call, or a public form. We map columns to fields, validate, and version the contract.",
  },
  {
    n: "03",
    icon: Send,
    title: "Generate, sign, deliver",
    body: "Fan out one or a million. Signers, webhooks, and audit trails are wired in — no glue code.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how"
      className="relative scroll-mt-20 border-y border-border/60 bg-muted/20 py-20 sm:py-28"
    >
      <div className="container mx-auto px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-primary">
            How it works
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Three steps from blank page to signed PDF
          </h2>
        </div>

        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="group relative overflow-hidden rounded-2xl border border-border bg-card p-7 shadow-card"
            >
              <div className="absolute right-4 top-3 font-mono text-5xl font-bold text-foreground/[0.04]">
                {s.n}
              </div>
              <div className="relative">
                <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
                  <s.icon className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  aria-hidden
                  className="absolute right-0 top-1/2 hidden h-px w-8 translate-x-full bg-gradient-to-r from-border to-transparent lg:block"
                />
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
