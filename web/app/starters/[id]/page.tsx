import { notFound } from "next/navigation";
import { STARTERS } from "@/lib/starters";
import { StarterFillPage } from "@/components/starter-fill/fill-page";

interface Props {
  params: { id: string };
}

export default function StarterFillRoute({ params }: Props) {
  const starter = STARTERS.find((s) => s.id === params.id);
  if (!starter) notFound();

  // Alternates share the same data shape: same category AND same lead tag
  // (e.g. all "resume" variants, or all "invoice" variants). The lead tag is
  // the primary type — switching designs preserves user data.
  const leadTag = starter.tags[0];
  const alternates = STARTERS.filter(
    (s) =>
      s.id !== starter.id &&
      s.category === starter.category &&
      s.tags[0] === leadTag,
  );

  return <StarterFillPage starter={starter} alternates={alternates} />;
}
