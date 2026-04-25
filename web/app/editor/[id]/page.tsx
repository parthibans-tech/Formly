"use client";

// /editor/[id] — full-screen ONLYOFFICE editor (document, spreadsheet,
// or presentation; the document server picks the editor from the
// `documentType` field in the config).
//
// Flow when the user clicks a DOCX/XLSX/PPTX/etc. row in the drive:
//   1. Drive routes here (window.location or router.push).
//   2. We fetch /v1/files/{id}/onlyoffice/config — auth'd; the API
//      enforces the read/edit ACL and returns a JWT-signed editor
//      config plus the browser-facing ONLYOFFICE URL.
//   3. We inject `<script src="${publicUrl}/web-apps/apps/api/documents/api.js">`,
//      then call `new DocsAPI.DocEditor("placeholder", config)`. ONLYOFFICE
//      handles everything from there — fetching the bytes from our
//      content endpoint, broadcasting edits, posting save events to our
//      callback endpoint.
//   4. On unmount, we call editor.destroyEditor() so the iframe and the
//      WebSocket connection are released cleanly (otherwise we'd leak
//      slots against the Document Server's 20-connection cap).
//
// Why not iframe directly? ONLYOFFICE's api.js does the iframe insertion
// itself, plus wires up its postMessage protocol for events (save,
// document-ready, errors, force-save trigger). Building that ourselves
// would re-implement Document Server's public surface for no gain.

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, AlertTriangle, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";

// DocsAPI is injected onto `window` by ONLYOFFICE's api.js. We don't
// model the full surface — the editor returns an opaque controller and
// we only call destroyEditor() on it.
declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (placeholderId: string, config: unknown) => {
        destroyEditor?: () => void;
      };
    };
  }
}

type ConfigResponse = {
  config: Record<string, unknown>;
  publicUrl: string;
};

export default function OnlyOfficeEditorPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const fileId = params.id;

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Track the controller so we can tear it down on unmount.
  const editorRef = useRef<{ destroyEditor?: () => void } | null>(null);
  // Stable script element reference so we only inject once even under
  // React strict-mode double-mount.
  const scriptRef = useRef<HTMLScriptElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let mountedEditor: { destroyEditor?: () => void } | null = null;
    let injectedScript: HTMLScriptElement | null = null;

    async function boot() {
      try {
        const resp = await api<ConfigResponse>(
          `/v1/files/${fileId}/onlyoffice/config`
        );
        if (cancelled) return;

        const apiJsURL = `${resp.publicUrl.replace(
          /\/$/,
          ""
        )}/web-apps/apps/api/documents/api.js`;

        // If the script is already on the page (e.g. after client-side
        // navigation), reuse it instead of re-injecting.
        const existing = document.querySelector<HTMLScriptElement>(
          `script[src="${apiJsURL}"]`
        );
        if (existing && window.DocsAPI) {
          mountedEditor = mount(resp.config);
          editorRef.current = mountedEditor;
          setLoading(false);
          return;
        }

        injectedScript = document.createElement("script");
        injectedScript.src = apiJsURL;
        injectedScript.async = true;
        injectedScript.onload = () => {
          if (cancelled) return;
          if (!window.DocsAPI) {
            setError(
              "ONLYOFFICE editor failed to initialize — DocsAPI not present after script load."
            );
            setLoading(false);
            return;
          }
          mountedEditor = mount(resp.config);
          editorRef.current = mountedEditor;
          setLoading(false);
        };
        injectedScript.onerror = () => {
          if (cancelled) return;
          setError(
            `Could not load ONLYOFFICE from ${resp.publicUrl}. Is the document server running?`
          );
          setLoading(false);
        };
        document.head.appendChild(injectedScript);
        scriptRef.current = injectedScript;
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError) {
          if (e.status === 400 && e.code === "unsupported_type") {
            setError(
              "This file type can't be edited in the document editor."
            );
          } else if (e.status === 404) {
            setError("File not found or you don't have access.");
          } else {
            setError(e.message);
          }
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
      }
    }

    boot();

    return () => {
      cancelled = true;
      // Tear the editor down so the WebSocket + iframe release their
      // slot against the Document Server's connection cap. Without
      // this, navigating away would leave ghost editors holding slots
      // until they idle-time-out (~30 min).
      try {
        editorRef.current?.destroyEditor?.();
      } catch {
        // Defensive — destroyEditor can throw on partially-initialized
        // editors. We don't have a useful recovery; just swallow.
      }
      editorRef.current = null;
    };
  }, [fileId]);

  function mount(config: Record<string, unknown>) {
    if (!window.DocsAPI) throw new Error("DocsAPI missing");
    return new window.DocsAPI.DocEditor("onlyoffice-placeholder", config);
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/drive")}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to drive
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          ONLYOFFICE editor
        </span>
      </header>

      <div className="relative flex-1">
        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading editor…
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <div className="flex-1">
                  <h2 className="font-medium">Couldn't open the editor</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {error}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link href="/drive">Back to drive</Link>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {/* Placeholder div ONLYOFFICE replaces with its iframe. The
            iframe stretches via the editor config (width/height: "100%"). */}
        <div id="onlyoffice-placeholder" className="h-full w-full" />
      </div>
    </div>
  );
}
