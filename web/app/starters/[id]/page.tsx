import { notFound } from "next/navigation";
import { STARTERS } from "@/lib/starters";
import { StarterFillPage } from "@/components/starter-fill/fill-page";

interface Props {
  params: { id: string };
}

export default function StarterFillRoute({ params }: Props) {
  const starter = STARTERS.find((s) => s.id === params.id);
  if (!starter) notFound();

  const alternates = STARTERS.filter(
    (s) => s.id !== starter.id && s.category === starter.category,
  );

  return <StarterFillPage starter={starter} alternates={alternates} />;
}
