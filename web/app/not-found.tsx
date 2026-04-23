import Link from "next/link";
import { Home, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-full bg-primary/10 text-primary">
          <SearchX className="h-8 w-8" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn&apos;t find the page you&apos;re looking for. It may have
          been moved or deleted.
        </p>
        <div className="mt-6">
          <Button asChild>
            <Link href="/drive">
              <Home className="h-4 w-4" />
              Back to Drive
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
