"use client";

import { motion } from "framer-motion";
import {
  Boxes,
  FileSignature,
  FileSpreadsheet,
  Globe,
  Lock,
  Sparkles,
  Webhook,
  Workflow,
} from "lucide-react";

const FEATURES = [
  {
    icon: FileSpreadsheet,
    title: "Field-aware PDF designer",
    body: "Drop a PDF, we detect AcroForm fields and let you map them to friendly names, defaults, and validation. No re-typing.",
  },
  {
    icon: Workflow,
    title: "Bulk generate from CSV",
    body: "Upload a CSV, hit go. Async workers fan out and stitch each row into a finished document — minutes, not hours.",
  },
  {
    icon: FileSignature,
    title: "E-sign in the same flow",
    body: "Send a generated doc straight to a signer. Audit trail, evidence summary, and rejection reasons baked in.",
  },
  {
    icon: Globe,
    title: "Embed forms anywhere",
    body: "Per-org allowlist, CSP-friendly iframes, and a public-token surface so /form/<token> drops into any site.",
  },
  {
    icon: Sparkles,
    title: "AI extract & summarize",
    body: "PaddleOCR + LLM pipeline pulls fields out of PDFs, IDs, receipts, and scans — with a human-in-the-loop review queue.",
  },
  {
    icon: Webhook,
    title: "Webhooks & API",
    body: "Every event is a typed JSON payload. Subscribe your services to generations, signatures, uploads, mentions.",
  },
  {
    icon: Lock,
    title: "Vaulted storage",
    body: "Per-org KMS keys, signed-URL uploads direct to S3/MinIO, and granular share scopes — no public buckets.",
  },
  {
    icon: Boxes,
    title: "Templates that scale",
    body: "Versioned templates with previews, presets, and an integration playground so you ship without breaking callers.",
  },
];

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
};

export function FeatureGrid() {
  return (
    <section id="features" className="relative scroll-mt-20 py-20 sm:py-28">
      <div className="container mx-auto px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-primary">
            Everything in one platform
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            One workspace for every document your team touches
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            Stop wiring six tools together. Drive360 gives you the design,
            data, delivery, and audit surfaces — with the API hooks to glue it
            into the rest of your stack.
          </p>
        </div>

        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.15 }}
          transition={{ staggerChildren: 0.05 }}
          className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4"
        >
          {FEATURES.map((f) => (
            <motion.div
              key={f.title}
              variants={card}
              transition={{ duration: 0.45, ease: "easeOut" }}
              className="group relative overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-card transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-elevated"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-primary/10 opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
              />
              <div className="relative">
                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="text-base font-semibold text-foreground">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {f.body}
                </p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
