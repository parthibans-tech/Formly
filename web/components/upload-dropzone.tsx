"use client";

// UploadDropzone — drag a file from your OS onto the browser window and
// the drive picks it up. Mounted once on a page; renders an overlay
// only while a drag is in progress, so it doesn't interfere with normal
// pointer events the rest of the time.
//
// Why a window-level listener and not a `onDrop` on a container
//
// Browser drag/drop bubbles unpredictably across nested DOM trees, and
// any element that doesn't preventDefault() on `dragover` causes the
// browser to navigate to the dropped file — which is the worst
// possible failure mode for an upload feature. Wiring the listeners
// to `window` once means we can't miss a dragover, and a single ref
// counter handles the dragenter/dragleave noise from child elements.
//
// Folder drops
//
// HTML5 drag-drop only carries File objects; folders need
// `webkitGetAsEntry` to walk recursively. We keep this scope to
// "files only" for now and surface a quiet toast if the user tries to
// drop a folder, so the failure mode is "nothing happens + you see
// why" rather than a silent no-op.

import { useEffect, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

type Props = {
  // onFiles is called once per drop with the dropped files. Multiple
  // files in a single drop arrive together; the parent decides whether
  // to upload them in parallel or sequentially.
  onFiles: (files: File[]) => void;
  // disabled lets the parent skip the dropzone (e.g. while a modal is
  // open or a previous upload is still running) without unmounting.
  disabled?: boolean;
  // label customizes the overlay text — defaults to a generic "Drop
  // files to upload" so the component is reusable across pages.
  label?: string;
  // sublabel shows secondary context (e.g. "Uploading to: Marketing").
  sublabel?: string;
  // onFolderRejected fires when the user drops something that smells
  // like a folder. The parent typically hooks this to a toast.
  onFolderRejected?: () => void;
};

export function UploadDropzone({
  onFiles,
  disabled,
  label = "Drop files to upload",
  sublabel,
  onFolderRejected,
}: Props) {
  const [active, setActive] = useState(false);
  // Drag events fire dragenter on every child element entered, then
  // dragleave when leaving each. A naive "active = true on enter,
  // false on leave" toggles madly when the user moves over nested
  // elements. Counting enters and leaves balances them.
  const counterRef = useRef(0);

  useEffect(() => {
    if (disabled) return;

    // Detect "is the dragged thing actually a file?" via dataTransfer.types.
    // This is the only reliable way to ignore in-page drags (text
    // selections, draggable images), since dataTransfer.files is empty
    // until the drop event fires.
    const isFileDrag = (e: DragEvent) => {
      const t = e.dataTransfer?.types;
      if (!t) return false;
      // DataTransferItemList vs array depending on browser; both
      // expose .includes() / iteration for "Files".
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "Files") return true;
      }
      return false;
    };

    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      counterRef.current += 1;
      if (counterRef.current === 1) setActive(true);
    };

    const onDragOver = (e: DragEvent) => {
      // Critical: without this, the browser navigates to the file on
      // drop. Has to fire on every dragover, not just the first.
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      counterRef.current = Math.max(0, counterRef.current - 1);
      if (counterRef.current === 0) setActive(false);
    };

    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      counterRef.current = 0;
      setActive(false);

      const dt = e.dataTransfer;
      if (!dt) return;

      // Folder detection: if any item exposes a directory entry via
      // webkitGetAsEntry, it's a folder. We don't recurse (yet) — the
      // upload pipeline only takes File objects — so we surface the
      // rejection and skip those entries.
      let sawFolder = false;
      const files: File[] = [];
      const items = dt.items;
      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind !== "file") continue;
          // webkitGetAsEntry is non-standard but ubiquitous; the cast
          // keeps TS quiet without pulling in a polyfill type pack.
          const entry = (item as DataTransferItem & {
            webkitGetAsEntry?: () => { isDirectory: boolean } | null;
          }).webkitGetAsEntry?.();
          if (entry?.isDirectory) {
            sawFolder = true;
            continue;
          }
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      } else {
        // Older browsers — no items list, just files. Folders won't
        // appear here at all so no rejection check needed.
        const fl = dt.files;
        for (let i = 0; i < fl.length; i++) files.push(fl[i]);
      }

      if (sawFolder && onFolderRejected) onFolderRejected();
      if (files.length > 0) onFiles(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [disabled, onFiles, onFolderRejected]);

  if (!active) return null;

  return (
    <div
      // pointer-events: none so the overlay is purely visual — the
      // window-level listeners do the real work and the user's drag
      // gesture isn't interrupted by this DOM node.
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-primary/10 backdrop-blur-sm"
      aria-hidden
    >
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/60 bg-background/95 px-10 py-8 shadow-2xl">
        <UploadCloud className="h-10 w-10 text-primary" />
        <div className="text-center">
          <div className="text-base font-semibold">{label}</div>
          {sublabel && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {sublabel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
