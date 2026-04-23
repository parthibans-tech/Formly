"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Building2,
  Check,
  Eye,
  EyeOff,
  Mail,
  UserPlus,
  User,
  X,
} from "lucide-react";
import { api, setSession } from "@/lib/api";
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
import { cn } from "@/lib/utils";

const schema = z.object({
  name: z.string().min(2, "Please enter your full name"),
  orgName: z.string().optional(),
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .regex(/[A-Z]/, "Add an uppercase letter")
    .regex(/[0-9]/, "Add a number"),
});

type FormValues = z.infer<typeof schema>;

const rules = [
  { label: "At least 8 characters", test: (v: string) => v.length >= 8 },
  { label: "One uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { label: "One number", test: (v: string) => /[0-9]/.test(v) },
];

export default function SignupPage() {
  const router = useRouter();
  const toast = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    reValidateMode: "onChange",
    defaultValues: { name: "", orgName: "", email: "", password: "" },
  });

  const password = form.watch("password");

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    try {
      const res = await api<{ token: string; user: any }>("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify(values),
      });
      setSession(res.token, res.user);
      toast.show("success", "Account created");
      router.replace("/drive");
    } catch (e: any) {
      setFormError(e.message || "Unable to create account");
      toast.show("error", "Signup failed", { description: e.message });
    }
  };

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            Create your account
          </h1>
          <p className="text-sm text-muted-foreground">
            Start designing documents in minutes. No credit card required.
          </p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        {...field}
                        autoComplete="name"
                        placeholder="Ada Lovelace"
                        className="pl-9"
                        error={!!form.formState.errors.name}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="orgName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Organization{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        {...field}
                        autoComplete="organization"
                        placeholder="Acme, Inc."
                        className="pl-9"
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Work email</FormLabel>
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
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        {...field}
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        placeholder="Create a strong password"
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
                  <ul className="space-y-1 pt-1" aria-label="Password strength">
                    {rules.map((r) => {
                      const ok = r.test(password || "");
                      return (
                        <li
                          key={r.label}
                          className={cn(
                            "flex items-center gap-2 text-xs transition-colors",
                            ok
                              ? "text-success"
                              : "text-muted-foreground"
                          )}
                        >
                          {ok ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <X className="h-3.5 w-3.5 opacity-50" />
                          )}
                          {r.label}
                        </li>
                      );
                    })}
                  </ul>
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
              <UserPlus className="h-4 w-4" />
              Create account
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              By creating an account you agree to our Terms and Privacy Policy.
            </p>
          </form>
        </Form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-primary hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
