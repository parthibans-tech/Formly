"use client";

import { motion } from "framer-motion";
import {
  Boxes,
  Cloud,
  Database,
  FileCode2,
  GitBranch,
  KeyRound,
  Mailbox,
  ShieldCheck,
  Webhook,
  Workflow,
} from "lucide-react";

const ITEMS = [
  { icon: Cloud, label: "S3 / MinIO" },
  { icon: Database, label: "Postgres" },
  { icon: Webhook, label: "Webhooks" },
  { icon: Workflow, label: "Asynq" },
  { icon: KeyRound, label: "OIDC / SAML" },
  { icon: Mailbox, label: "SMTP" },
  { icon: GitBranch, label: "GitHub" },
  { icon: Boxes, label: "Docker" },
  { icon: FileCode2, label: "REST API" },
  { icon: ShieldCheck, label: "SOC 2" },
];

export function IntegrationsStrip() {
  return (
    <section id="integrations" className="scroll-mt-20 py-20 sm:py-24">
      <div className="container mx-auto px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-primary">
            Connect everything
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Plays nicely with the stack you already run
          </h2>
        </div>

        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          transition={{ staggerChildren: 0.04 }}
          className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5"
        >
          {ITEMS.map((it) => (
            <motion.div
              key={it.label}
              variants={{
                hidden: { opacity: 0, y: 8 },
                show: { opacity: 1, y: 0 },
              }}
              transition={{ duration: 0.35 }}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-subtle transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-card"
            >
              <span className="grid h-8 w-8 place-items-center rounded-md bg-muted text-foreground">
                <it.icon className="h-4 w-4" />
              </span>
              <span className="text-sm font-medium">{it.label}</span>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
