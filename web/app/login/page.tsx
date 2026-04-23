"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff, LogIn, Mail, ShieldCheck } from "lucide-react";
import { api, setSession } from "@/lib/api";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/components/toast";

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<FormValues | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    reValidateMode: "onChange",
    defaultValues: { email: "", password: "" },
  });

  async function attempt(values: FormValues, code?: string) {
    setFormError(null);
    setSubmitting(true);
    try {
      const body: any = { ...values };
      if (code) body.mfaCode = code;
      const res = await api<{
        token?: string;
        user?: any;
        mfaRequired?: boolean;
      }>("/v1/auth/login", { method: "POST", body: JSON.stringify(body) });
      if (res.mfaRequired) {
        setMfaRequired(true);
        setPending(values);
        return;
      }
      setSession(res.token!, res.user);
      toast.show("success", "Welcome back");
      router.replace("/drive");
    } catch (e: any) {
      setFormError(e.message || "Unable to sign in");
      toast.show("error", "Unable to sign in", { description: e.message });
    } finally {
      setSubmitting(false);
    }
  }

  const onSubmit = (values: FormValues) => attempt(values);
  const onMfaSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending || mfaCode.trim().length < 6) return;
    attempt(pending, mfaCode.trim());
  };

  if (mfaRequired) {
    return (
      <AuthLayout>
        <div className="space-y-6">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <ShieldCheck className="h-3.5 w-3.5" />
              Two-factor authentication
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Enter your verification code
            </h1>
            <p className="text-sm text-muted-foreground">
              Open your authenticator app and enter the 6-digit code for{" "}
              <span className="font-medium text-foreground">
                {pending?.email}
              </span>
              . Or use one of your recovery codes.
            </p>
          </div>
          <form onSubmit={onMfaSubmit} className="space-y-4">
            <div>
              <Label htmlFor="mfa-challenge">Code</Label>
              <Input
                id="mfa-challenge"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="mt-1 font-mono text-lg tracking-widest"
                maxLength={16}
              />
              {formError && (
                <p className="mt-1 text-xs text-destructive">{formError}</p>
              )}
            </div>
            <Button
              type="submit"
              className="w-full"
              loading={submitting}
              disabled={mfaCode.trim().length < 6}
            >
              <LogIn className="h-4 w-4" />
              Verify & sign in
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setMfaRequired(false);
                setMfaCode("");
                setPending(null);
                setFormError(null);
              }}
            >
              Back
            </Button>
          </form>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to your Formly workspace to continue.
          </p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        {...field}
                        type="email"
                        autoComplete="email"
                        placeholder="you@company.com"
                        className="pl-9"
                        error={!!form.formState.errors.email}
                      />
                    </div>
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
                  <div className="flex items-center justify-between">
                    <FormLabel>Password</FormLabel>
                    <Link
                      href="#"
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Forgot password?
                    </Link>
                  </div>
                  <FormControl>
                    <div className="relative">
                      <Input
                        {...field}
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        className="pr-9"
                        error={!!form.formState.errors.password}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
                        aria-label={showPassword ? "Hide password" : "Show password"}
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

            {formError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {formError}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              loading={form.formState.isSubmitting}
              disabled={!form.formState.isValid || form.formState.isSubmitting}
            >
              <LogIn className="h-4 w-4" />
              Sign in
            </Button>
          </form>
        </Form>

        <p className="text-center text-sm text-muted-foreground">
          No account?{" "}
          <Link
            href="/signup"
            className="font-medium text-primary hover:underline"
          >
            Create one
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
