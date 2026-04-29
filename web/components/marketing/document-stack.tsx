"use client";

import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  CheckCircle2,
  FileSignature,
  FileText,
  Send,
  Sparkles,
} from "lucide-react";

export function DocumentStack() {
  const reduced = useReducedMotion();
  const float: Variants[string] = reduced
    ? {}
    : {
        y: [0, -8, 0],
        transition: { duration: 6, repeat: Infinity, ease: "easeInOut" },
      };

  return (
    <div
      aria-hidden
      className="relative mx-auto h-[420px] w-full max-w-[520px] [perspective:1600px] sm:h-[480px]"
    >
      {/* Glow halo */}
      <div className="absolute inset-0 -z-10 mx-8 rounded-[2rem] bg-gradient-to-br from-primary/30 via-cyan-400/20 to-fuchsia-400/20 blur-3xl" />

      {/* Back card — pipeline */}
      <motion.div
        initial={{ opacity: 0, y: 24, rotateX: 12, rotateY: -12 }}
        animate={{ opacity: 1, y: 0, rotateX: 12, rotateY: -12 }}
        transition={{ duration: 0.7, delay: 0.05 }}
        whileHover={reduced ? undefined : { rotateY: -8, rotateX: 8 }}
        className="absolute left-2 top-6 w-[78%] origin-top-left rounded-2xl border border-border bg-card/90 p-4 shadow-elevated [transform-style:preserve-3d] backdrop-blur-md"
      >
        <motion.div animate={float}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Bulk run · 1,248 docs
            </span>
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
              ● live
            </span>
          </div>
          <Bar pct={92} label="Generated" />
          <Bar pct={68} label="Signed" delay={0.4} />
          <Bar pct={41} label="Delivered" delay={0.8} />
        </motion.div>
      </motion.div>

      {/* Middle card — form fields */}
      <motion.div
        initial={{ opacity: 0, y: 24, rotateX: 6, rotateY: -2 }}
        animate={{ opacity: 1, y: 0, rotateX: 6, rotateY: -2 }}
        transition={{ duration: 0.7, delay: 0.15 }}
        whileHover={reduced ? undefined : { rotateY: 2, rotateX: 2 }}
        className="absolute right-2 top-16 w-[72%] origin-top-right rounded-2xl border border-border bg-card p-5 shadow-elevated [transform-style:preserve-3d]"
      >
        <motion.div animate={float} transition={{ delay: 0.5 }}>
          <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
            <FileText className="h-3.5 w-3.5 text-primary" />
            <span className="font-medium text-foreground">
              Onboarding-Agreement.pdf
            </span>
            <span>· 3 fields</span>
          </div>
          <Field label="Full name" value="Aanya Sharma" />
          <Field label="Email" value="aanya@acme.co" delay={0.3} />
          <Field
            label="Signature"
            value="Aanya S."
            delay={0.6}
            icon={<FileSignature className="h-3.5 w-3.5" />}
          />
        </motion.div>
      </motion.div>

      {/* Front card — AI extract */}
      <motion.div
        initial={{ opacity: 0, y: 30, rotateX: -2, rotateY: 4 }}
        animate={{ opacity: 1, y: 0, rotateX: -2, rotateY: 4 }}
        transition={{ duration: 0.7, delay: 0.25 }}
        whileHover={reduced ? undefined : { rotateY: -2, rotateX: -4 }}
        className="absolute bottom-4 left-8 w-[80%] rounded-2xl border border-border bg-card p-5 shadow-elevated [transform-style:preserve-3d]"
      >
        <motion.div animate={float} transition={{ delay: 1 }}>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/10 text-primary">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <span>AI extracted</span>
            </div>
            <CheckCircle2 className="h-4 w-4 text-success" />
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <Chip label="Vendor" value="Acme Industries" />
            <Chip label="Total" value="$12,480.00" />
            <Chip label="Due" value="Apr 30, 2026" />
            <Chip label="PO #" value="PO-44219" />
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Send className="h-3 w-3" /> sent to /webhook
            </span>
            <span className="font-mono">200 OK · 84 ms</span>
          </div>
        </motion.div>
      </motion.div>

      {/* Floating ping */}
      {!reduced && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: [0, 1, 0.9, 1] }}
          transition={{ duration: 1.2, delay: 1, repeat: Infinity, repeatDelay: 3 }}
          className="absolute right-10 top-2 grid h-9 w-9 place-items-center rounded-full bg-primary/15 text-primary shadow-card backdrop-blur"
        >
          <Sparkles className="h-4 w-4" />
        </motion.span>
      )}
    </div>
  );
}

function Bar({
  pct,
  label,
  delay = 0,
}: {
  pct: number;
  label: string;
  delay?: number;
}) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono text-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1.4, delay: 0.3 + delay, ease: "easeOut" }}
          className="h-full rounded-full bg-gradient-to-r from-primary to-cyan-400"
        />
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  delay = 0,
  icon,
}: {
  label: string;
  value: string;
  delay?: number;
  icon?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.4 + delay }}
      className="mb-2 last:mb-0 rounded-md border border-border/70 bg-background/60 px-3 py-2"
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        {icon}
        {value}
      </div>
    </motion.div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/70 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="font-medium text-foreground">{value}</div>
    </div>
  );
}
