"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, setSession } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", orgName: "" });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const res = await api<{ token: string; user: any }>("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setSession(res.token, res.user);
      router.replace("/drive");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  const upd = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="min-h-screen grid place-items-center">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-lg shadow p-6 space-y-4">
        <h1 className="text-2xl font-semibold">Create your account</h1>
        <input className="w-full border rounded px-3 py-2" placeholder="Full name"
          value={form.name} onChange={upd("name")} required />
        <input className="w-full border rounded px-3 py-2" placeholder="Organization (optional)"
          value={form.orgName} onChange={upd("orgName")} />
        <input className="w-full border rounded px-3 py-2" placeholder="Email" type="email"
          value={form.email} onChange={upd("email")} required />
        <input className="w-full border rounded px-3 py-2" placeholder="Password" type="password"
          value={form.password} onChange={upd("password")} required minLength={8} />
        {err && <div className="text-sm text-red-600">{err}</div>}
        <button disabled={loading} className="w-full bg-blue-600 text-white rounded py-2 hover:bg-blue-700 disabled:opacity-50">
          {loading ? "Creating..." : "Create account"}
        </button>
        <p className="text-sm text-center">
          Have an account? <Link href="/login" className="text-blue-600">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
