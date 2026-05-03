"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";

const ITEMS = [
  {
    q: "Can I self-host Drive360?",
    a: "Yes. The full stack ships as docker-compose: API, web, Postgres + pgvector, Redis, MinIO, and ONLYOFFICE. One command brings it up; everything is configured via environment variables.",
  },
  {
    q: "How does signing work?",
    a: "E-signature is built in. Send a generated document to a signer, they review and sign in-browser, and you get a tamper-evident audit trail with IP, user-agent, and timestamps — plus a webhook on every state change.",
  },
  {
    q: "Do you support OCR and scanned PDFs?",
    a: "Yes. PaddleOCR (PP-OCRv4 detection + recognition) powers the OCR pipeline; combined with the AI extract step you can pull structured fields out of scans, IDs, and receipts, with per-field confidence and a human review queue.",
  },
  {
    q: "What about embedding forms on our own site?",
    a: "Public form, share, and review tokens render as standalone routes that are safe to iframe. Each org has a CSP-driven embed allowlist so only your domains can host them.",
  },
  {
    q: "How is the data stored?",
    a: "Files go to S3 / MinIO with presigned uploads (browsers never touch your API for blobs). Metadata lives in Postgres. Per-org encryption keys are supported for vaulted storage.",
  },
  {
    q: "Is there an API?",
    a: "Everything the UI does is exposed as a JSON API with API keys, scoped tokens, and a typed webhook payload for every event. There's a built-in playground for trying calls before wiring them in.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="scroll-mt-20 py-20 sm:py-28">
      <div className="container mx-auto px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-primary">
            FAQ
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Questions teams ask before switching
          </h2>
        </div>

        <div className="mx-auto mt-12 max-w-3xl space-y-3">
          {ITEMS.map((item, i) => {
            const isOpen = open === i;
            return (
              <div
                key={item.q}
                className={
                  "overflow-hidden rounded-xl border bg-card shadow-subtle transition-colors " +
                  (isOpen ? "border-primary/40" : "border-border")
                }
              >
                <button
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : i)}
                >
                  <span className="text-sm font-medium text-foreground">
                    {item.q}
                  </span>
                  <ChevronDown
                    className={
                      "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 " +
                      (isOpen ? "rotate-180" : "")
                    }
                  />
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="content"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: "easeOut" }}
                    >
                      <p className="px-5 pb-5 text-sm leading-relaxed text-muted-foreground">
                        {item.a}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
