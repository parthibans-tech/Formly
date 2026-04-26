"use client";

/**
 * Route shell for the new doc-mode designer (Tier A).
 *
 * Kept deliberately thin: all domain UI lives in
 * <DocDesigner> (components/doc-designer/designer.tsx).  This page just:
 *   - gates on auth
 *   - fetches the template metadata
 *   - renders the designer, or a friendly fallback for non-doc templates
 *
 * We route this under `designer-v2` while doc mode is behind a flag. Once
 * it graduates, we'll branch from the main /designer page on `tpl.mode`.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, getToken } from "@/lib/api";
import DocDesigner, {
  type DocDesignerTemplate,
} from "@/components/doc-designer/designer";

export default function DocDesignerPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [tpl, setTpl] = useState<DocDesignerTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const t = await api<DocDesignerTemplate>(`/v1/templates/${params.id}`);
        setTpl(t);
      } catch (e) {
        setError((e as Error).message || "Failed to load template");
      }
    })();
  }, [params.id, router]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-sm">
        <div className="text-destructive mb-2">{error}</div>
        <button
          type="button"
          className="underline text-muted-foreground"
          onClick={() => router.back()}
        >
          Go back
        </button>
      </div>
    );
  }

  if (!tpl) {
    return (
      <div className="flex items-center justify-center h-screen text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (tpl.mode !== "doc") {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-sm text-muted-foreground gap-2">
        <div>
          This template is <code className="font-mono">{tpl.mode}</code> mode —
          the doc designer only opens doc-mode templates.
        </div>
        <button
          type="button"
          className="underline"
          onClick={() => router.replace(`/templates/${tpl.id}/designer`)}
        >
          Open in the classic designer
        </button>
      </div>
    );
  }

  return <DocDesigner tpl={tpl} fileId={tpl.fileId} />;
}
