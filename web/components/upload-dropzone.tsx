"use client";

// UploadDropzone — drag a file or folder from your OS onto the browser
// window and the drive picks it up. Mounted once on a page; renders an
// overlay only while a drag is in progress, so it doesn't interfere
// with normal pointer events the rest of the time.
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
// HTML5 drag-drop only carries File objects; folder structure is
// recovered via `webkitGetAsEntry` and the FileSystemEntry API. We
// recurse the tree, attaching a relativePath to each File so the
// upload pipeline can mirror the directory structure server-side.

import { useEffect, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

export type UploadItem = {
  file: File;
  // relativePath is set when the file came out of a dropped folder
  // (or a webkitdirectory picker). For a plain file drop it is
  // undefined and the upload lands directly in the current folder.
  relativePath?: string;
};

type Props = {
  // onFiles is called once per drop with the dropped items. Multiple
  // files in a single drop arrive together; the parent decides whether
  // to upload them in parallel or sequentially.
  onFiles: (items: UploadItem[]) => void;
  // disabled lets the parent skip the dropzone (e.g. while a modal is
  // open or a previous upload is still running) without unmounting.
  disabled?: boolean;
  // label customizes the overlay text — defaults to a generic "Drop
  // files to upload" so the component is reusable across pages.
  label?: string;
  // sublabel shows secondary context (e.g. "Uploading to: Marketing").
  sublabel?: string;
};

type FSEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void, err?: () => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: FSEntry[]) => void, err?: () => void) => void;
  };
};

// Walk a FileSystemEntry recursively, returning every leaf File along
// with its path relative to the dropped root.
async function walkEntry(
  entry: FSEntry,
  parentPath: string
): Promise<UploadItem[]> {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File | null>((resolve) => {
      entry.file!(
        (file) => resolve(file),
        () => resolve(null)
      );
    });
    if (!f) return [];
    const relativePath = parentPath
      ? `${parentPath}/${entry.name}`
      : entry.name;
    return [{ file: f, relativePath }];
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const childBase = parentPath
      ? `${parentPath}/${entry.name}`
      : entry.name;
    const out: UploadItem[] = [];
    // readEntries returns batches (Chrome caps at ~100 per call);
    // keep reading until an empty batch comes back.
    while (true) {
      const batch = await new Promise<FSEntry[]>((resolve) => {
        reader.readEntries(
          (entries) => resolve(entries),
          () => resolve([])
        );
      });
      if (batch.length === 0) break;
      for (const child of batch) {
        const sub = await walkEntry(child, childBase);
        out.push(...sub);
      }
    }
    return out;
  }
  return [];
}

export function UploadDropzone({
  onFiles,
  disabled,
  label = "Drop files to upload",
  sublabel,
}: Props) {
  const [active, setActive] = useState(false);
  // Drag events fire dragenter on every child element entered, then
  // dragleave when leaving each. A naive "active = true on enter,
  // false on leave" toggles madly when the user moves over nested
  // elements. Counting enters and leaves balances them.
  const counterRef = useRef(0);
  // Keep onFiles fresh without resubscribing the window listeners on
  // every parent re-render.
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    if (disabled) return;

    // Detect "is the dragged thing actually a file?" via dataTransfer.types.
    // This is the only reliable way to ignore in-page drags (text
    // selections, draggable images), since dataTransfer.files is empty
    // until the drop event fires.
    const isFileDrag = (e: DragEvent) => {
      const t = e.dataTransfer?.types;
      if (!t) return false;
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

    const onDrop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      counterRef.current = 0;
      setActive(false);

      const dt = e.dataTransfer;
      if (!dt) return;

      const items = dt.items;
      const out: UploadItem[] = [];

      if (items && items.length > 0) {
        // Snapshot the entry list synchronously — DataTransferItem
        // objects become inert after the drop event tick, so any
        // attempt to call webkitGetAsEntry() inside an awaited
        // promise later would return null.
        const entries: Array<FSEntry | null> = [];
        const fallbackFiles: Array<File | null> = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind !== "file") {
            entries.push(null);
            fallbackFiles.push(null);
            continue;
          }
          const entry = (
            item as DataTransferItem & {
              webkitGetAsEntry?: () => FSEntry | null;
            }
          ).webkitGetAsEntry?.();
          entries.push(entry || null);
          fallbackFiles.push(item.getAsFile());
        }

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (entry?.isDirectory) {
            const sub = await walkEntry(entry, "");
            out.push(...sub);
          } else {
            const f = fallbackFiles[i];
            if (f) out.push({ file: f });
          }
        }
      } else {
        // Older browsers — no items list, just files. Folders won't
        // appear here at all so we treat everything as a flat drop.
        const fl = dt.files;
        for (let i = 0; i < fl.length; i++) out.push({ file: fl[i] });
      }

      if (out.length > 0) onFilesRef.current(out);
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
  }, [disabled]);

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
