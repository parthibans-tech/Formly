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
  Users,
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

// Workspace shape — controlled by the radio at the top of the form.
//   - "personal": creates a sealed single-member workspace. The org row
//     lands with kind='personal' on the server; CreateInvite will refuse
//     401/409 against it. The form hides the org-name field entirely
//     since the server pins it to "Personal workspace".
//   - "team":     creates a regular kind='team' org. The org-name field
//     becomes required (no more silent "<name>'s Org" fallback at the
//     UI level — we want the admin to make a deliberate choice). The
//     server still falls back if somehow blank, but the UI insists.
type WorkspaceKind = "personal" | "team";

// We build the schema with a discriminator so orgName is only required
// when kind='team'. Zod's superRefine keeps the error attached to the
// orgName field so the FormMessage renders it inline.
const schema = z
  .object({
    kind: z.enum(["personal", "team"]),
    name: z.string().min(2, "Please enter your full name"),
    orgName: z.string().optional(),
    email: z.string().min(1, "Email is required").email("Enter a valid email"),
    password: z
      .string()
      .min(8, "Use at least 8 characters")
      .regex(/[A-Z]/, "Add an uppercase letter")
      .regex(/[0-9]/, "Add a number"),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "team" && (!v.orgName || v.orgName.trim().length < 2)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["orgName"],
        message: "Organization name is required",
      });
    }
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
    defaultValues: {
      kind: "personal",
      name: "",
      orgName: "",
      email: "",
      password: "",
    },
  });

  const password = form.watch("password");
  const kind = form.watch("kind");

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    try {
      // Translate the UI's discriminator into the server's wire shape.
      // Server expects `personal: bool`; orgName is ignored on the
      // personal branch (server overrides to "Personal workspace") so
      // we drop it from the payload to keep the request honest.
      const body: Record<string, unknown> = {
        name: values.name,
        email: values.email,
        password: values.password,
        personal: values.kind === "personal",
      };
      if (values.kind === "team" && values.orgName) {
        body.orgName = values.orgName;
      }
      const res = await api<{ token: string; user: any }>("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify(body),
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
        <h1 className="text-center text-2xl font-semibold tracking-tight">
          Create your account
        </h1>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Workspace-kind picker. Renders as two large radio cards
                so the choice is obvious — text-only radios kept getting
                missed by users who scrolled straight to the org-name
                input. The hidden native input keeps RHF + a11y happy. */}
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>What are you setting up?</FormLabel>
                  <FormControl>
                    <div
                      role="radiogroup"
                      aria-label="Workspace type"
                      className="grid grid-cols-2 gap-2"
                    >
                      <WorkspaceCard
                        active={field.value === "personal"}
                        onSelect={() => field.onChange("personal")}
                        icon={<User className="h-4 w-4" />}
                        title="Just me"
                        sub="Personal workspace"
                      />
                      <WorkspaceCard
                        active={field.value === "team"}
                        onSelect={() => field.onChange("team")}
                        icon={<Users className="h-4 w-4" />}
                        title="My team"
                        sub="Invite teammates"
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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

            {/* Org-name field is conditional on kind='team'. We render
                it only on the team branch so personal signups don't see
                it at all (mirrors the server: the field is ignored on
                personal). When team is selected the schema's
                superRefine makes it required. */}
            {kind === "team" && (
              <FormField
                control={form.control}
                name="orgName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Organization</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          {...field}
                          autoComplete="organization"
                          placeholder="Acme, Inc."
                          className="pl-9"
                          error={!!form.formState.errors.orgName}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {kind === "personal" ? "Email" : "Work email"}
                  </FormLabel>
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
              {kind === "personal" ? (
                <>
                  You can join a team later if someone invites you — your
                  personal workspace stays separate.
                </>
              ) : (
                <>
                  By creating an account you agree to our Terms and Privacy
                  Policy.
                </>
              )}
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

// WorkspaceCard is the radio "card" used by the kind picker. Behaves
// like a native radio (role + aria-checked + Enter/Space) so screen
// readers and keyboard users get the same affordance the visual users
// see.
function WorkspaceCard({
  active,
  onSelect,
  icon,
  title,
  sub,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary/5"
          : "border-border hover:border-foreground/30"
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 text-sm font-medium",
          active ? "text-primary" : "text-foreground"
        )}
      >
        {icon}
        {title}
      </div>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </button>
  );
}
