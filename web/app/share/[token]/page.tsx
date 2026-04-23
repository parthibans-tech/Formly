"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API_URL } from "@/lib/api";

type ResolveResp = {
  fileName: string;
  mime: string;
  size: number;
  downloadUrl: string;
  role: string;
};

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<ResolveResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/v1/public/shares/${params.token}`);
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error?.message || "share not available");
        }
        setData(await res.json());
      } catch (e: any) {
        setErr(e.message);
      }
    })();
  }, [params.token]);

  if (err) {
    return (
      <div className="min-h-screen grid place-items-center bg-gray-50">
        <div className="bg-white border rounded-lg p-8 shadow-sm max-w-md text-center">
          <div className="text-red-600 font-medium mb-2">Link unavailable</div>
          <div className="text-sm text-gray-600">{err}</div>
        </div>
      </div>
    );
  }
  if (!data) return <div className="min-h-screen grid place-items-center text-gray-500">Loading…</div>;

  return (
    <div className="min-h-screen flex flex-col bg-gray-100">
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div className="font-semibold">DocForge — Shared file</div>
        <a
          href={data.downloadUrl}
          download={data.fileName}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Download
        </a>
      </header>
      <div className="px-6 py-3 bg-white border-b text-sm text-gray-600">
        <strong>{data.fileName}</strong> · {data.mime} · {(data.size / 1024).toFixed(1)} KB · role: {data.role}
      </div>
      <div className="flex-1 min-h-0">
        <iframe src={data.downloadUrl} className="w-full h-full bg-white" title={data.fileName} />
      </div>
    </div>
  );
}
