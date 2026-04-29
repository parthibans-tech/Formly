"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CtaSection() {
  return (
    <section className="relative isolate overflow-hidden py-24">
      <div className="container mx-auto px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.55 }}
          className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-primary/15 via-card to-card p-10 shadow-elevated sm:p-14"
        >
          <div
            aria-hidden
            className="absolute -right-24 -top-24 h-64 w-64 rounded-full bg-primary/30 blur-3xl"
          />
          <div
            aria-hidden
            className="absolute -bottom-24 -left-20 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl"
          />

          <div className="relative grid items-center gap-8 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
                Ship documents like you ship code
              </h2>
              <p className="mt-3 max-w-xl text-pretty text-muted-foreground">
                Spin up Drive360 in minutes — no credit card, no sales call.
                Bring your team in once it earns its keep.
              </p>
            </div>
            <div className="flex flex-col gap-3 lg:items-end">
              <Button asChild size="lg" className="h-11 px-6">
                <Link href="/signup">
                  Create free account
                  <ArrowRight className="ml-1" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 px-6">
                <Link href="/login">I have an account</Link>
              </Button>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
