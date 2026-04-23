"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="h-8 w-8" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error occurred. Try again or return to the home page.
        </p>
        {error.message && (
          <pre className="mt-4 max-h-32 overflow-auto rounded-md border bg-muted/50 px-3 py-2 text-left text-xs text-muted-foreground">
            {error.message}
          </pre>
        )}
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button onClick={reset}>
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
          <Button asChild variant="outline">
            <a href="/drive">Go home</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
