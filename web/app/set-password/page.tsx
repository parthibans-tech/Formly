"use client";

// Forced password-reset landing page.
//
// When the API's /v1/auth/login response includes
// `forcePasswordReset: true`, the login flow stashes the JWT and
// redirects here. The page asks for a new password (no current-pw
// field — see backend SetPassword for the rationale) and clears the
// flag on success. Until the user submits a valid new password, this
// page is the only screen they can use; everything else assumes a
// "settled" account.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff, KeyRound, ShieldCheck } from "lucide-react";
import { api, clearSession } from "@/lib/api";
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
import { useToast } from "@/components/toast";

const schema = z
  .object({
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ["confirm"],
    message: "Passwords don't match",
  });

type FormValues = z.infer<typeof schema>;

export default function SetPasswordPage() {
  const router = useRouter();
  const toast = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { newPassword: "", confirm: "" },
  });

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    try {
      await api("/v1/auth/set-password", {
        method: "POST",
        body: JSON.stringify({
          // currentPassword is ignored when force_pw_reset=true on the
          // server, but include an empty string to keep the contract
          // single-shape across both flows (see settings/security).
          currentPassword: "",
          newPassword: values.newPassword,
        }),
      });
      toast.show("success", "Password updated");
      router.replace("/drive");
    } catch (e: any) {
      toast.show("error", "Couldn't update password", {
        description: e?.message,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function signOut() {
    clearSession();
    router.replace("/login");
  }

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700">
            <ShieldCheck className="h-3.5 w-3.5" />
            Action required
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Set a new password
          </h1>
          <p className="text-sm text-muted-foreground">
            Your administrator has asked you to choose a new password
            before continuing. The previous one will stop working.
          </p>
        </div>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-3"
          >
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        {...field}
                        type={showPassword ? "text" : "password"}
                        autoFocus
                        autoComplete="new-password"
                        placeholder="At least 8 characters"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={
                          showPassword ? "Hide password" : "Show password"
                        }
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
            <FormField
              control={form.control}
              name="confirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm password</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button
              type="submit"
              loading={submitting}
              disabled={!form.formState.isValid}
              className="w-full"
            >
              <KeyRound className="h-4 w-4" />
              Update password
            </Button>
          </form>
        </Form>

        <button
          type="button"
          onClick={signOut}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Sign out instead
        </button>
      </div>
    </AuthLayout>
  );
}
