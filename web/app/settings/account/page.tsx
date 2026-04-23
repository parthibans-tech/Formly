"use client";

import { useEffect, useState } from "react";
import { Mail, User as UserIcon } from "lucide-react";
import { getUser } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export default function AccountSettings() {
  const [user, setUser] = useState<any>(null);
  useEffect(() => {
    setUser(getUser());
  }, []);

  if (!user) return null;
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground">
          Your profile and organization.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserIcon className="h-5 w-5 text-primary" />
            Profile
          </CardTitle>
          <CardDescription>
            Read-only for now. Edit support is on the roadmap.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input readOnly value={user.name || "—"} />
          </div>
          <div className="space-y-1">
            <Label>Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input readOnly value={user.email || "—"} className="pl-9" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Organization ID</Label>
            <Input readOnly value={user.orgId || "—"} className="font-mono text-xs" />
          </div>
        </CardContent>
      </Card>
    </>
  );
}
