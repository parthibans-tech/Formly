"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /**
   * When true, applies the destructive border and focus ring. Pair
   * with the `Field` wrapper (or your own caption rendering) to surface
   * the error message below the input.
   */
  error?: boolean;
}

// Input — height matches the default Button (36px) so a row of
// "<Input/> <Button/>" lines up cleanly without consumers picking
// sizes manually. Treatment is border-driven:
//
//   - Resting: hairline border, transparent fill (the surrounding
//     surface bleeds through, which is why the input adapts to cards
//     vs canvas vs dialogs without per-context tuning).
//   - Hover: border darkens one step. This is the single most-missed
//     "premium" detail in stock shadcn — the user feels which row
//     they're targeting before they click.
//   - Focus: 2px ring at primary, 1px offset from the input edge so
//     it doesn't push siblings around in dense forms (the designer's
//     properties pane stacks 30+ inputs).
//   - Error: border + ring flip to destructive; hover keeps the
//     destructive border so the error doesn't appear to "heal" on
//     hover.
//
// File inputs get a sensible style for their browser-injected button.
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        aria-invalid={error || undefined}
        className={cn(
          "flex h-9 w-full rounded-md border bg-transparent px-3 py-2 text-sm",
          "transition-colors duration-fast ease-out",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "placeholder:text-muted-foreground/70",
          "hover:border-border-strong",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          error
            ? "border-destructive hover:border-destructive focus-visible:ring-destructive"
            : "border-input",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

// Field — the wrapper that pairs an input with its label, helper text,
// and error message. Optional but recommended; it encodes the
// 4px-gap-between-label-and-input + 6px-gap-between-input-and-helper
// rhythm so dense forms stay aligned without per-form tuning.
//
// Usage:
//   <Field label="Email" helper="We never share your email">
//     <Input type="email" />
//   </Field>
//   <Field label="Name" error="Required">
//     <Input error />
//   </Field>
//
// `error` and `helper` are mutually exclusive at render time — when
// `error` is set it takes precedence. This matches user expectation:
// a form with both helper AND error text is reading too much at the
// user, and consolidating to one slot lets the field row stay one
// line tall in the common case.
export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  helper?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
}

const Field = React.forwardRef<HTMLDivElement, FieldProps>(
  ({ className, label, helper, error, required, children, ...props }, ref) => {
    const id = React.useId();
    const messageId = `${id}-msg`;
    const message = error ?? helper;
    return (
      <div ref={ref} className={cn("flex flex-col gap-1.5", className)} {...props}>
        {label && (
          <label
            htmlFor={id}
            className="text-sm font-medium leading-none text-foreground"
          >
            {label}
            {required && (
              <span className="ml-0.5 text-destructive" aria-hidden>
                *
              </span>
            )}
          </label>
        )}
        {/* Clone the input child so the wrapper can wire id + aria
            without forcing every consumer to repeat the prop dance.
            We only inject when the child is a single element — multi-
            child fields opt out of the auto-wiring. */}
        {React.isValidElement(children)
          ? React.cloneElement(
              children as React.ReactElement,
              {
                id,
                "aria-describedby": message ? messageId : undefined,
                "aria-invalid": error ? true : undefined,
              } as React.HTMLAttributes<HTMLElement>
            )
          : children}
        {message && (
          <p
            id={messageId}
            className={cn(
              "text-xs leading-4",
              error ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {message}
          </p>
        )}
      </div>
    );
  }
);
Field.displayName = "Field";

export { Input, Field };
