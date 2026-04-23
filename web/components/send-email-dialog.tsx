"use client";

import { useState } from "react";
import { Mail, Send, X } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templateId: string;
  templateName: string;
  placeholders: string[];
};

export function SendEmailDialog({
  open,
  onOpenChange,
  templateId,
  templateName,
  placeholders,
}: Props) {
  const toast = useToast();
  const [to, setTo] = useState("");
  const [cc, setCC] = useState("");
  const [bcc, setBCC] = useState("");
  const [subject, setSubject] = useState(`Your ${templateName}`);
  const [body, setBody] = useState(
    "Please find your document attached.\n\nThanks,\nThe team"
  );
  const [dataJSON, setDataJSON] = useState(
    JSON.stringify(skeleton(placeholders), null, 2)
  );
  const [filename, setFilename] = useState("");
  const [sending, setSending] = useState(false);

  function splitAddrs(v: string): string[] {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function send() {
    if (!to.trim()) {
      toast.show("error", "At least one recipient is required");
      return;
    }
    let data: any = {};
    try {
      data = JSON.parse(dataJSON);
    } catch (e: any) {
      toast.show("error", "Invalid JSON in data");
      return;
    }
    setSending(true);
    try {
      await api(`/v1/templates/${templateId}/send`, {
        method: "POST",
        body: JSON.stringify({
          data,
          to: splitAddrs(to),
          cc: splitAddrs(cc),
          bcc: splitAddrs(bcc),
          subject: subject.trim(),
          body,
          filename: filename.trim() || undefined,
        }),
      });
      toast.show("success", "Email sent", {
        description: "Check Settings → Email for the delivery log.",
      });
      onOpenChange(false);
    } catch (e: any) {
      toast.show("error", "Send failed", { description: e.message });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Generate &amp; email
          </DialogTitle>
          <DialogDescription>
            Renders the template as a PDF and sends it to the addresses below.
            Requires Email settings to be configured first.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-3 overflow-y-auto px-1">
          <div className="space-y-1.5">
            <Label htmlFor="send-to">To</Label>
            <Input
              id="send-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="alice@example.com, bob@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="send-cc">CC (optional)</Label>
              <Input
                id="send-cc"
                value={cc}
                onChange={(e) => setCC(e.target.value)}
                placeholder="ops@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="send-bcc">BCC (optional)</Label>
              <Input
                id="send-bcc"
                value={bcc}
                onChange={(e) => setBCC(e.target.value)}
                placeholder="archive@example.com"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="send-subject">Subject</Label>
            <Input
              id="send-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="send-body">Body (plain text)</Label>
            <textarea
              id="send-body"
              className="h-28 w-full resize-none rounded-md border bg-background p-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="send-filename">Attachment filename (optional)</Label>
            <Input
              id="send-filename"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder={`${templateName}.pdf`}
            />
          </div>

          <Separator />

          <div className="space-y-1.5">
            <Label htmlFor="send-data">Data (JSON)</Label>
            <textarea
              id="send-data"
              className="h-48 w-full rounded-md border bg-background p-3 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={dataJSON}
              onChange={(e) => setDataJSON(e.target.value)}
              spellCheck={false}
            />
            <p className="text-[10px] text-muted-foreground">
              Keys should match the template&apos;s placeholders.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sending}
          >
            <X className="h-4 w-4" />
            Cancel
          </Button>
          <Button onClick={send} loading={sending}>
            <Send className="h-4 w-4" />
            Generate &amp; send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function skeleton(placeholders: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of placeholders) setDeep(out, p, "");
  return out;
}
function setDeep(obj: Record<string, any>, path: string, value: any) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null)
      cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
