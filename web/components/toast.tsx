"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Toast = { id: number; kind: "success" | "error" | "info"; text: string };
type Ctx = { show: (kind: Toast["kind"], text: string) => void };

const ToastCtx = createContext<Ctx>({ show: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "rounded-md shadow-lg px-4 py-2 text-sm text-white " +
              (t.kind === "success" ? "bg-green-600" : t.kind === "error" ? "bg-red-600" : "bg-gray-800")
            }
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
