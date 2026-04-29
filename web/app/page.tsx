import type { Metadata } from "next";
import { SiteNav } from "@/components/marketing/site-nav";
import { Hero } from "@/components/marketing/hero";
import { FeatureGrid } from "@/components/marketing/feature-grid";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { ShowcaseSection } from "@/components/marketing/showcase-section";
import { IntegrationsStrip } from "@/components/marketing/integrations-strip";
import { Faq } from "@/components/marketing/faq";
import { CtaSection } from "@/components/marketing/cta-section";
import { SiteFooter } from "@/components/marketing/site-footer";
import { LandingJsonLd } from "@/components/marketing/json-ld";

export const metadata: Metadata = {
  title: "Drive360 — Document automation for modern teams",
  description:
    "Design, fill, sign, and share PDF & HTML documents at scale. Bulk-generate from CSV, embed forms anywhere, and automate the paperwork your team still does by hand.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "Drive360 — Document automation for modern teams",
    description:
      "Design, fill, sign, and share PDF & HTML documents at scale. Bulk-generate, embed, and automate.",
    siteName: "Drive360",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Drive360 — Document automation for modern teams",
    description:
      "Design, fill, sign, and share PDF & HTML documents at scale.",
  },
};

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <LandingJsonLd />
      <SiteNav />
      <main>
        <Hero />
        <FeatureGrid />
        <ShowcaseSection />
        <HowItWorks />
        <IntegrationsStrip />
        <Faq />
        <CtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
