"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  ShieldAlert,
  UserPlus,
} from "lucide-react";
import { API_URL, setSession } from "@/lib/api";
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

type Resolve = {
  email: string;
  role: string;
  orgName: string;
  expired: boolean;
  accepted: boolean;
  revoked: boolean;
};

const schema = z.object({
  name: z.string().min(2, "Please enter your full name"),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .regex(/[A-Z]/, "Add an uppercase letter")
    .regex(/[0-9]/, "Add a number"),
});

type Values = z.infer<typeof schema>;

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<Resolve | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { name: "", password: "" },
  });

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/v1/public/invites/${params.token}`);
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

  async function submit(values: Values) {
    try {
      const res = await fetch(
        `${API_URL}/v1/public/invites/${params.token}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || "couldn't accept");
      }
      const json = await res.json();
      setSession(json.token, json.user);
      router.replace("/drive");
    } catch (e: any) {
      form.setError("root", { message: e.message });
    }
  }

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
          <form
            onSubmit={form.handleSubmit(submit)}
            className="space-y-4"
          >
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
