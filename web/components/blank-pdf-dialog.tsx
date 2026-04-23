"use client";

import { useState } from "react";
import { FileType2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BlankPdfOpts } from "@/lib/create-pdf";

type PageSize = NonNullable<BlankPdfOpts["pageSize"]>;
type Orient = NonNullable<BlankPdfOpts["orientation"]>;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (opts: Omit<BlankPdfOpts, "folderId">) => Promise<void>;
  busy: boolean;
};

export function BlankPdfDialog({ open, onOpenChange, onCreate, busy }: Props) {
  const [name, setName] = useState("Untitled PDF");
  const [pageSize, setPageSize] = useState<PageSize>("Letter");
  const [orientation, setOrientation] = useState<Orient>("portrait");
  const [pages, setPages] = useState(1);
  const [nameErr, setNameErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 1) {
      setNameErr("Name is required");
      return;
    }
    setNameErr(null);
    await onCreate({
      name: name.trim(),
      pageSize,
      orientation,
      pages,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileType2 className="h-5 w-5 text-primary" />
            New blank PDF
          </DialogTitle>
          <DialogDescription>
            Creates a blank PDF and opens the static designer so you can drop
            text, dates, and checkboxes onto the page.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pdf-name">Name</Label>
            <Input
              id="pdf-name"
              value={name}
              error={!!nameErr}
              onChange={(e) => {
                setName(e.target.value);
                if (nameErr) setNameErr(null);
              }}
              placeholder="Untitled PDF"
              autoFocus
            />
            {nameErr && (
              <p className="text-xs font-medium text-destructive">{nameErr}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pdf-size">Page size</Label>
              <Select
                value={pageSize}
                onValueChange={(v) => setPageSize(v as PageSize)}
              >
                <SelectTrigger id="pdf-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Letter">Letter (8.5 × 11 in)</SelectItem>
                  <SelectItem value="Legal">Legal (8.5 × 14 in)</SelectItem>
                  <SelectItem value="A4">A4 (210 × 297 mm)</SelectItem>
                  <SelectItem value="A3">A3 (297 × 420 mm)</SelectItem>
                  <SelectItem value="A5">A5 (148 × 210 mm)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pdf-orient">Orientation</Label>
              <Select
                value={orientation}
                onValueChange={(v) => setOrientation(v as Orient)}
              >
                <SelectTrigger id="pdf-orient">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="portrait">Portrait</SelectItem>
                  <SelectItem value="landscape">Landscape</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pdf-pages">Pages (1–20)</Label>
            <Input
              id="pdf-pages"
              type="number"
              min={1}
              max={20}
              value={pages}
              onChange={(e) =>
                setPages(
                  Math.max(1, Math.min(20, parseInt(e.target.value || "1", 10)))
                )
              }
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              <FileType2 className="h-4 w-4" />
              Create PDF
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
