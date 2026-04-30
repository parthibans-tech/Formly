"use client";

// Inspired by react-hot-toast library
import * as React from "react";
import type { ToastActionElement, ToastProps } from "@/components/ui/toast";

// How many toasts can stack at once. More than three feels noisy.
const TOAST_LIMIT = 3;
// Delay between Radix calling onOpenChange(false) and us actually
// dropping the toast from state. Short enough that closed toasts
// don't pile up invisibly, long enough for the slide-out animation
// to finish (~200ms).
const TOAST_REMOVE_DELAY = 400;
// Auto-dismiss duration handed to each Toast.Root via the `duration`
// prop. Radix counts this from when the toast mounts; hovering the
// viewport pauses it (built-in).
export const TOAST_AUTO_CLOSE_MS = 3500;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
} as const;

let count = 0;
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type ActionType = typeof actionTypes;
type Action =
  | { type: ActionType["ADD_TOAST"]; toast: ToasterToast }
  | { type: ActionType["UPDATE_TOAST"]; toast: Partial<ToasterToast> }
  | { type: ActionType["DISMISS_TOAST"]; toastId?: ToasterToast["id"] }
  | { type: ActionType["REMOVE_TOAST"]; toastId?: ToasterToast["id"] };

interface State {
  toasts: ToasterToast[];
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) return;
  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({ type: "REMOVE_TOAST", toastId });
  }, TOAST_REMOVE_DELAY);
  toastTimeouts.set(toastId, timeout);
};

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST":
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };
    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      };
    case "DISMISS_TOAST": {
      const { toastId } = action;
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => addToRemoveQueue(toast.id));
      }
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined ? { ...t, open: false } : t
        ),
      };
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) return { ...state, toasts: [] };
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners: Array<(state: State) => void> = [];
let memoryState: State = { toasts: [] };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => listener(memoryState));
}

type Toast = Omit<ToasterToast, "id">;

// Two ReactNodes are "equivalent" for dedupe purposes when their
// stringified forms match. We only ever pass strings/numbers/null
// through the toast() helper in this codebase, so a String() coercion
// is safe and avoids a deep-equal dependency.
function sameNode(a: React.ReactNode, b: React.ReactNode): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function toast({ ...props }: Toast) {
  // Dedupe: if an identical toast (same variant + title + description)
  // is already open, refresh it instead of stacking a duplicate.
  // Spamming a copy button then reads as "the toast is still there"
  // instead of three near-identical cards piling on top of each other.
  const existing = memoryState.toasts.find(
    (t) =>
      t.open !== false &&
      t.variant === props.variant &&
      sameNode(t.title, props.title) &&
      sameNode(t.description, props.description),
  );
  if (existing) {
    const id = existing.id;
    const update = (next: ToasterToast) =>
      dispatch({ type: "UPDATE_TOAST", toast: { ...next, id } });
    const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });
    return { id, dismiss, update };
  }

  const id = genId();
  const update = (props: ToasterToast) =>
    dispatch({ type: "UPDATE_TOAST", toast: { ...props, id } });
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });
  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });
  return { id, dismiss, update };
}

function useToastStore() {
  const [state, setState] = React.useState<State>(memoryState);
  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) listeners.splice(index, 1);
    };
  }, [state]);
  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}

export { useToastStore, toast };
