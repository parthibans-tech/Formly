"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowRightLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  LogIn,
  LogOut,
  ShieldAlert,
  UserCheck,
  UserPlus,
} from "lucide-react";
import {
  API_URL,
  api,
  clearSession,
  getToken,
  getUser,
  setSession,
} from "@/lib/api";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";

// Mirrors team.publicInviteResp on the server.
type Resolve = {
  email: string;
  role: string;
  orgName: string;
  expired: boolean;
  accepted: boolean;
  revoked: boolean;
  existingUser: boolean;
};

// Shape returned by the Accept handler on success. Fields are optional
// because the response varies by branch:
//   - new user → { token, user, joinedOrgId, joinedOrgName, existingUser:false }
//   - existing user via password → same as above (but existingUser:true)
//   - existing user via Bearer → { user, joinedOrgId, joinedOrgName,
//                                  existingUser:true } — NO token. The
//     caller's existing session is preserved.
type AcceptResp = {
  token?: string;
  user?: {
    id: string;
    email: string;
    name: string;
    orgId: string;
    role: string;
  };
  joinedOrgId?: string;
  joinedOrgName?: string;
  existingUser?: boolean;
};

// Schemas. Keep them branch-specific so the existing-user "Sign in to
// accept" form doesn't trip the new-user uppercase / digit policy.
const newUserSchema = z.object({
  name: z.string().min(2, "Please enter your full name"),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .regex(/[A-Z]/, "Add an uppercase letter")
    .regex(/[0-9]/, "Add a number"),
});
type NewUserValues = z.infer<typeof newUserSchema>;

const passwordSignInSchema = z.object({
  password: z.string().min(1, "Password is required"),
});
type PasswordSignInValues = z.infer<typeof passwordSignInSchema>;

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const toast = useToast();

  const [info, setInfo] = useState<Resolve | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Cached current-session user, evaluated on mount only. We don't react
  // to localStorage changes — if the user signs in/out in another tab
  // they can refresh this one. Avoids hydration mismatches.
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  useEffect(() => {
    const u = getUser();
    setCurrentUserEmail(u?.email ?? null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `${API_URL}/v1/public/invites/${params.token}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error?.message || "invitation not found");
        }
        setInfo(await res.json());
      } catch (e: any) {
        setErr(e.message);
      }
    })();
  }, [params.token]);

  // ---- terminal / error states ------------------------------------------
  if (err) {
    return (
      <AuthLayout>
        <ErrorState title="Invitation unavailable" message={err} />
      </AuthLayout>
    );
  }
  if (!info) {
    return (
      <AuthLayout>
        <div className="h-6 animate-pulse rounded bg-muted" />
      </AuthLayout>
    );
  }
  if (info.revoked) {
    return (
      <AuthLayout>
        <ErrorState
          title="Invitation revoked"
          message="This invitation was revoked by an admin. Ask them to send a new one."
        />
      </AuthLayout>
    );
  }
  if (info.accepted) {
    return (
      <AuthLayout>
        <ErrorState
          title="Already accepted"
          message="This invitation was already accepted. Try signing in instead."
          cta={
            <Button asChild>
              <a href="/login">Go to sign in</a>
            </Button>
          }
        />
      </AuthLayout>
    );
  }
  if (info.expired) {
    return (
      <AuthLayout>
        <ErrorState
          title="Invitation expired"
          message="Ask an admin at your workspace to send a fresh invite."
        />
      </AuthLayout>
    );
  }

  // ---- live-flow branching ----------------------------------------------
  // The four states the accept page can be in once the invite is valid:
  //
  //   1. existingUser=false                          → "Set up your account"
  //                                                    form (name + password).
  //   2. existingUser=true, signed in as <invitee>    → one-tap "Accept as
  //                                                    {email}" button using
  //                                                    the current Bearer.
  //   3. existingUser=true, NOT signed in             → "Sign in to accept"
  //                                                    — either via the
  //                                                    `?next=` round trip to
  //                                                    /login, or by entering
  //                                                    a password right here.
  //   4. existingUser=true, signed in as someone else → warn + offer sign-out
  //                                                    so they can come back
  //                                                    as the invitee.

  if (!info.existingUser) {
    return (
      <NewUserForm
        token={params.token}
        info={info}
        toast={toast}
        router={router}
      />
    );
  }

  const signedInAsInvitee =
    currentUserEmail !== null &&
    currentUserEmail.toLowerCase() === info.email.toLowerCase();
  const signedInAsOther =
    currentUserEmail !== null && !signedInAsInvitee;

  if (signedInAsInvitee) {
    return (
      <ExistingUserBearerAccept
        token={params.token}
        info={info}
        toast={toast}
        router={router}
      />
    );
  }
  if (signedInAsOther) {
    return (
      <WrongUserSignedIn
        info={info}
        currentEmail={currentUserEmail!}
        afterSignOut={() => setCurrentUserEmail(null)}
      />
    );
  }
  return (
    <ExistingUserSignIn
      token={params.token}
      info={info}
      toast={toast}
      router={router}
    />
  );
}

// ---------------------------------------------------------------------------
// Branch 1 — new user. Mirrors the old form 1:1.
function NewUserForm({
  token,
  info,
  toast,
  router,
}: {
  token: string;
  info: Resolve;
  toast: ReturnType<typeof useToast>;
  router: ReturnType<typeof useRouter>;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<NewUserValues>({
    resolver: zodResolver(newUserSchema),
    mode: "onChange",
    defaultValues: { name: "", password: "" },
  });

  async function submit(values: NewUserValues) {
    try {
      const res = await fetch(
        `${API_URL}/v1/public/invites/${token}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      const body: AcceptResp & { error?: { message?: string } } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error?.message || "couldn't accept");
      }
      if (body.token && body.user) {
        setSession(body.token, body.user);
      }
      toast.show("success", `Welcome to ${info.orgName}`);
      router.replace("/drive");
    } catch (e: any) {
      form.setError("root", { message: e.message });
    }
  }

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            You&apos;re invited
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Join {info.orgName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Create your account to start collaborating as{" "}
            <Badge variant="outline" className="text-[10px] font-normal">
              {info.role}
            </Badge>
            .
          </p>
          <p className="pt-1 text-xs text-muted-foreground">
            Email on file: <strong>{info.email}</strong>
          </p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      autoComplete="name"
                      placeholder="Ada Lovelace"
                      error={!!form.formState.errors.name}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        {...field}
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        placeholder="At least 8 characters, 1 upper, 1 number"
                        className="pr-9"
                        error={!!form.formState.errors.password}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
                        aria-label={showPassword ? "Hide" : "Show"}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {form.formState.errors.root && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {form.formState.errors.root.message}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              loading={form.formState.isSubmitting}
              disabled={!form.formState.isValid || form.formState.isSubmitting}
            >
              <UserPlus className="h-4 w-4" />
              Accept &amp; join
            </Button>
          </form>
        </Form>
      </div>
    </AuthLayout>
  );
}

// ---------------------------------------------------------------------------
// Branch 2 — existing user, already signed in as the invitee.
// One-tap accept; the current Bearer JWT proves identity. The server
// withholds a fresh token so the user's session is preserved exactly
// as-is (active org, claims, etc.). We then offer to switch into the
// joined org via /v1/me/switch-org.
function ExistingUserBearerAccept({
  token,
  info,
  toast,
  router,
}: {
  token: string;
  info: Resolve;
  toast: ReturnType<typeof useToast>;
  router: ReturnType<typeof useRouter>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ orgId: string; orgName: string } | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);

  async function accept() {
    setSubmitting(true);
    setErr(null);
    try {
      const bearer = getToken();
      const res = await fetch(
        `${API_URL}/v1/public/invites/${token}/accept`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          },
          // Empty body — the Bearer is enough. The server skips Name /
          // Password validation in the existing-user branch.
          body: JSON.stringify({}),
        },
      );
      const body: AcceptResp & { error?: { message?: string } } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error?.message || "couldn't accept");
      }
      // Bearer-authenticated path returns no fresh token. If one comes
      // through anyway (server policy change), honor it.
      if (body.token && body.user) {
        setSession(body.token, body.user);
      }
      setDone({
        orgId: body.joinedOrgId ?? "",
        orgName: body.joinedOrgName ?? info.orgName,
      });
      toast.show("success", `Joined ${info.orgName}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function switchToJoined() {
    if (!done?.orgId) return;
    try {
      const r = await api<{ token: string; user: any }>(
        "/v1/me/switch-org",
        {
          method: "POST",
          body: JSON.stringify({ orgId: done.orgId }),
        },
      );
      setSession(r.token, r.user);
      toast.show("success", `Switched to ${done.orgName}`);
      // Hard navigation so every component re-reads /v1/me/profile etc.
      window.location.href = "/drive";
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  if (done) {
    return (
      <AuthLayout>
        <div className="space-y-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-success/10 text-success">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              You&apos;ve joined {done.orgName}
            </h1>
            <p className="text-sm text-muted-foreground">
              Your current session keeps you in your previous workspace —
              switch over whenever you&apos;re ready.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button onClick={switchToJoined}>
              <ArrowRightLeft className="h-4 w-4" />
              Switch to {done.orgName}
            </Button>
            <Button variant="outline" onClick={() => router.replace("/drive")}>
              Stay where I am
            </Button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <UserCheck className="h-3.5 w-3.5 text-success" />
            Accept as {info.email}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Join {info.orgName}
          </h1>
          <p className="text-sm text-muted-foreground">
            You&apos;re signed in as{" "}
            <strong>{info.email}</strong>. We&apos;ll add this workspace to
            your account as a{" "}
            <Badge variant="outline" className="text-[10px] font-normal">
              {info.role}
            </Badge>
            ; your current session stays put.
          </p>
        </div>

        {err && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {err}
          </div>
        )}

        <Button
          onClick={accept}
          loading={submitting}
          disabled={submitting}
          className="w-full"
        >
          <UserCheck className="h-4 w-4" />
          Accept invitation
        </Button>
      </div>
    </AuthLayout>
  );
}

// ---------------------------------------------------------------------------
// Branch 3 — existing user, not signed in. Two paths to accept:
//   - Click "Sign in to accept" → /login?next=/accept/{token}, the login
//     page bounces back here and Branch 2 takes over.
//   - Or enter the password inline; the server password-checks against
//     the existing user_hash and skips the user INSERT.
function ExistingUserSignIn({
  token,
  info,
  toast,
  router,
}: {
  token: string;
  info: Resolve;
  toast: ReturnType<typeof useToast>;
  router: ReturnType<typeof useRouter>;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<PasswordSignInValues>({
    resolver: zodResolver(passwordSignInSchema),
    mode: "onChange",
    defaultValues: { password: "" },
  });

  const loginHref = useMemo(
    () => `/login?next=${encodeURIComponent(`/accept/${token}`)}`,
    [token],
  );

  async function submit(values: PasswordSignInValues) {
    try {
      const res = await fetch(
        `${API_URL}/v1/public/invites/${token}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: values.password }),
        },
      );
      const body: AcceptResp & { error?: { message?: string } } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error?.message || "couldn't accept");
      }
      if (body.token && body.user) {
        setSession(body.token, body.user);
      }
      toast.show(
        "success",
        `Joined ${body.joinedOrgName ?? info.orgName}`,
        {
          description:
            "You're signed in to your existing workspace — switch from the org picker any time.",
        },
      );
      router.replace("/drive");
    } catch (e: any) {
      form.setError("root", { message: e.message });
    }
  }

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <LogIn className="h-3.5 w-3.5 text-primary" />
            Sign in to accept
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Join {info.orgName}
          </h1>
          <p className="text-sm text-muted-foreground">
            An account already exists for <strong>{info.email}</strong>.
            Sign in to add this workspace as a{" "}
            <Badge variant="outline" className="text-[10px] font-normal">
              {info.role}
            </Badge>
            .
          </p>
        </div>

        <Button asChild className="w-full">
          <Link href={loginHref}>
            <LogIn className="h-4 w-4" />
            Continue to sign in
          </Link>
        </Button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-[11px] uppercase tracking-wide">
            <span className="bg-background px-2 text-muted-foreground">
              or accept here
            </span>
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password for {info.email}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        {...field}
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        placeholder="Your existing password"
                        className="pr-9"
                        error={!!form.formState.errors.password}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
                        aria-label={showPassword ? "Hide" : "Show"}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {form.formState.errors.root && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {form.formState.errors.root.message}
              </div>
            )}

            <Button
              type="submit"
              variant="outline"
              className="w-full"
              loading={form.formState.isSubmitting}
              disabled={!form.formState.isValid || form.formState.isSubmitting}
            >
              <UserCheck className="h-4 w-4" />
              Verify password &amp; accept
            </Button>
          </form>
        </Form>
      </div>
    </AuthLayout>
  );
}

// ---------------------------------------------------------------------------
// Branch 4 — signed in as a different user. Point this out clearly and
// offer to sign out so they can come back as the right account.
function WrongUserSignedIn({
  info,
  currentEmail,
  afterSignOut,
}: {
  info: Resolve;
  currentEmail: string;
  afterSignOut: () => void;
}) {
  function signOut() {
    clearSession();
    afterSignOut();
  }

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-3.5 w-3.5" />
            Different account signed in
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            This invitation is for a different account
          </h1>
          <p className="text-sm text-muted-foreground">
            You&apos;re signed in as <strong>{currentEmail}</strong>, but the
            invite to <strong>{info.orgName}</strong> is for{" "}
            <strong>{info.email}</strong>. Sign out and back in as the
            invited address to accept.
          </p>
        </div>

        <Button variant="outline" className="w-full" onClick={signOut}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </AuthLayout>
  );
}

// ---------------------------------------------------------------------------
function ErrorState({
  title,
  message,
  cta,
}: {
  title: string;
  message: string;
  cta?: React.ReactNode;
}) {
  return (
    <div className="space-y-3 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <ShieldAlert className="h-6 w-6" />
      </div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      {cta}
    </div>
  );
}

