"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, PlayCircle, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnimatedMesh } from "./animated-mesh";
import { DocumentStack } from "./document-stack";

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
};

export function Hero() {
  return (
    <section className="relative isolate">
      <AnimatedMesh />
      <div className="container mx-auto px-4 pb-16 pt-14 sm:px-6 sm:pb-24 sm:pt-20 lg:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <motion.span
              {...fadeUp}
              transition={{ duration: 0.4 }}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1 text-xs font-medium text-muted-foreground shadow-subtle backdrop-blur"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              AI-powered document automation
            </motion.span>

            <motion.h1
              {...fadeUp}
              transition={{ duration: 0.5, delay: 0.05 }}
              className="mt-5 text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl"
            >
              Turn paperwork into a{" "}
              <span className="bg-gradient-to-r from-primary via-cyan-500 to-fuchsia-500 bg-clip-text text-transparent">
                pipeline
              </span>
              .
            </motion.h1>

            <motion.p
              {...fadeUp}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mt-5 max-w-xl text-pretty text-lg text-muted-foreground"
            >
              Drive360 lets your team design, fill, sign, and share PDF & HTML
              documents at scale. Bulk-generate from CSV, embed branded forms
              anywhere, and ship the workflow your customers actually finish.
            </motion.p>

            <motion.div
              {...fadeUp}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center"
            >
              <Button asChild size="lg" className="h-11 px-6">
                <Link href="/signup">
                  Start free
                  <ArrowRight className="ml-1 transition-transform group-hover:translate-x-1" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 px-5">
                <a href="#how">
                  <PlayCircle className="mr-1" />
                  See how it works
                </a>
              </Button>
            </motion.div>

            <motion.ul
              {...fadeUp}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"
            >
              <li className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-success" />
                SOC 2-aligned controls
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Self-host or cloud
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-500" />
                10k+ docs / minute
              </li>
            </motion.ul>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="lg:col-span-6"
          >
            <DocumentStack />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
