import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="grid min-h-screen place-items-center text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  );
}
