export function LandingJsonLd() {
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Drive360",
      url: "https://drive360.app",
      logo: "https://drive360.app/icon.png",
      sameAs: [],
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Drive360",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description:
        "Document automation platform: design, fill, sign, and share PDF & HTML documents at scale.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: "4.8",
        ratingCount: "127",
      },
    },
  ];
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
