"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  Download,
  FileSignature,
  KeyRound,
  LinkIcon,
  ShieldAlert,
} from "lucide-react";
import { API_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type InfoResp = {
  fileName: string;
  mime: string;
  size: number;
  role: string;
  expiresAt?: string;
  passwordProtected: boolean;
  oneTime: boolean;
  downloadsRemaining?: number;
  consumed: boolean;
};

type ResolveResp = {
  fileName: string;
  mime: string;
  size: number;
  downloadUrl: string;
  role: string;
};

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const [info, setInfo] = useState<InfoResp | null>(null);
  const [data, setData] = useState<ResolveResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);

  const loadInfo = useCallback(async () => {
    try {
      const r = await fetch(
        `${API_URL}/v1/public/shares/${params.token}/info`
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error?.message || "share not available");
      }
      setInfo(await r.json());
    } catch (e: any) {
      setErr(e.message);
    }
  }, [params.token]);

  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  const resolve = useCallback(
    async (pwd?: string, action: "view" | "download" = "view") => {
      setPwdError(null);
      const r = await fetch(`${API_URL}/v1/public/shares/${params.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd ?? "", action }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        const msg = e.error?.message || "share not available";
        if (e.error?.code === "bad_password") {
          setPwdError(msg);
          return null;
        }
        if (e.error?.code === "password_required") {
          return null;
        }
        throw new Error(msg);
      }
      return (await r.json()) as ResolveResp;
    },
    [params.token]
  );

  // Auto-resolve non-password shares once we've fetched info.
  useEffect(() => {
    if (!info || data) return;
    if (info.passwordProtected) return;
    if (info.consumed) return;
    resolve()
      .then((d) => d && setData(d))
      .catch((e) => setErr(e.message));
  }, [info, data, resolve]);

  async function onUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim()) return;
    setUnlocking(true);
    try {
      const d = await resolve(password.trim());
      if (d) setData(d);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setUnlocking(false);
    }
  }

  async function download() {
    if (!info) return;
    const d = await resolve(password || undefined, "download");
    if (d) {
      window.location.href = d.downloadUrl;
      // Refresh info so the remaining-count badge updates.
      setTimeout(() => loadInfo(), 500);
    }
  }

  if (err) {
    return (
      <Shell>
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-destructive/10 text-destructive">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <CardTitle className="text-center">Link unavailable</CardTitle>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            {err}
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (!info) {
    return (
      <Shell>
        <Skeleton className="h-64 w-full max-w-md" />
      </Shell>
    );
  }

  if (info.consumed) {
    return (
      <Shell>
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <CardTitle className="text-center">
              This one-time link has been used
            </CardTitle>
            <CardDescription className="text-center">
              Contact the sender for a new link if you still need access.
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  if (info.passwordProtected && !data) {
    return (
      <Shell>
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
              <KeyRound className="h-6 w-6" />
            </div>
            <CardTitle className="text-center">
              Password required
            </CardTitle>
            <CardDescription className="text-center">
              &quot;{info.fileName}&quot; is protected. Enter the password the
              sender shared with you.
            </CardDescription>
          </CardHeader>
          <form onSubmit={onUnlock}>
            <CardContent>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoFocus
              />
              {pwdError && (
                <p className="mt-1 text-xs text-destructive">{pwdError}</p>
              )}
            </CardContent>
            <CardFooter>
              <Button
                type="submit"
                className="w-full"
                loading={unlocking}
                disabled={!password.trim()}
              >
                Unlock
              </Button>
            </CardFooter>
          </form>
        </Card>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <Skeleton className="h-64 w-full max-w-md" />
      </Shell>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 md:px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
              <FileSignature className="h-4 w-4" />
            </span>
            Drive360
            <Badge variant="outline" className="ml-1 gap-1">
              <LinkIcon className="h-3 w-3" />
              Shared file
            </Badge>
            {info.oneTime && (
              <Badge
                variant="outline"
                className="border-sky-500/40 text-sky-600"
              >
                One-time
              </Badge>
            )}
            {info.downloadsRemaining !== undefined && (
              <Badge variant="outline">
                {info.downloadsRemaining} downloads left
              </Badge>
            )}
          </div>
          <Button onClick={download}>
            <Download className="h-4 w-4" />
            Download
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{data.fileName}</span>
          <span>·</span>
          <span>{data.mime}</span>
          <span>·</span>
          <span>{(data.size / 1024).toFixed(1)} KB</span>
          <span>·</span>
          <Badge variant="secondary" className="capitalize">
            {data.role}
          </Badge>
        </div>
      </header>
      <div className="flex-1 min-h-0 p-4">
        <iframe
          src={data.downloadUrl}
          className="h-full w-full rounded-lg border bg-background shadow-sm"
          title={data.fileName}
        />
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      {children}
    </div>
  );
}
