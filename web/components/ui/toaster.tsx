"use client";

import { TOAST_AUTO_CLOSE_MS, useToastStore } from "@/hooks/use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastIcon,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";

export function Toaster() {
  const { toasts } = useToastStore();
  return (
    // duration on the Provider applies to every toast that doesn't
    // override it. Radix pauses the timer while the pointer is over
    // the viewport, so toasts won't yank themselves away mid-read.
    <ToastProvider duration={TOAST_AUTO_CLOSE_MS} swipeDirection="right">
      {toasts.map(({ id, title, description, action, variant, ...props }) => (
        <Toast key={id} variant={variant} {...props}>
          <ToastIcon variant={variant} />
          <div className="grid flex-1 gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
