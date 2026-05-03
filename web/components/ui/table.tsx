"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// Table — the system's tabular surface. Two design intents worth
// preserving when editing:
//
//   1. The header is the only place `border-strong` earns its existence.
//      A 1px hairline underline on `<thead>` separates header from body
//      with enough contrast to read at scan-distance, without the
//      "ruled-paper" look that comes from drawing every row's border.
//      Body rows get a softer `border-border` underline so a 50-row
//      table reads as a single column of text, not a grid.
//
//   2. Numeric columns get `tabular-nums` via JetBrains Mono so figures
//      align on the decimal without extra alignment classes per cell.
//      Pass `numeric` on a `TableCell` (and the matching `TableHead`)
//      and the cell switches to mono + right-aligned automatically.
//
// `density` toggles between two row heights: `comfortable` (44px, the
// default — pairs with 14px body text the way Button default does) and
// `compact` (32px, for high-density admin tables where a user is
// scanning 30+ rows at a glance).

type Density = "comfortable" | "compact";

const TableContext = React.createContext<{ density: Density }>({
  density: "comfortable",
});

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  density?: Density;
  /**
   * When true, wraps the table in a scrollable container with a sticky
   * `<thead>`. Use for long tables where the header should remain
   * visible as the body scrolls. The container needs a constrained
   * height (set via `containerClassName` or a parent wrapper) for
   * sticky to actually engage.
   */
  stickyHeader?: boolean;
  containerClassName?: string;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  (
    { className, containerClassName, density = "comfortable", stickyHeader, ...props },
    ref
  ) => (
    <TableContext.Provider value={{ density }}>
      <div
        className={cn(
          "relative w-full overflow-auto",
          // Hairline frame on the scroll container — keeps the table
          // visually contained without per-cell borders.
          "rounded-lg border border-border",
          containerClassName
        )}
        data-sticky-header={stickyHeader || undefined}
      >
        <table
          ref={ref}
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </div>
    </TableContext.Provider>
  )
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      // Subtle tint so the header reads as a distinct band even on a
      // surface that already has a border. `bg-muted/40` is the lightest
      // step that survives both light and dark mode without looking
      // patched on.
      "bg-muted/40 [&_tr]:border-b [&_tr]:border-border-strong",
      // Sticky support: when `data-sticky-header` is set on the wrapper,
      // the header pins to the top of its scroll container.
      "[[data-sticky-header]_&]:sticky [[data-sticky-header]_&]:top-0 [[data-sticky-header]_&]:z-10",
      className
    )}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "border-t border-border-strong bg-muted/40 font-medium [&>tr]:last:border-b-0",
      className
    )}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

export interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /**
   * When true, the row picks up cursor-pointer + a stronger hover tint.
   * Use for rows that navigate / open a side panel on click.
   */
  interactive?: boolean;
  /**
   * Selected state — used by data tables with row selection. Adds a
   * persistent accent tint that survives hover/focus.
   */
  selected?: boolean;
}

const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, interactive, selected, ...props }, ref) => (
    <tr
      ref={ref}
      data-state={selected ? "selected" : undefined}
      className={cn(
        "border-b border-border transition-colors duration-fast ease-out",
        "hover:bg-muted/50",
        interactive && "cursor-pointer hover:bg-accent/60",
        selected && "bg-accent/40 hover:bg-accent/50",
        className
      )}
      {...props}
    />
  )
);
TableRow.displayName = "TableRow";

export interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /** Right-align + tabular-nums for numeric columns. */
  numeric?: boolean;
}

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, numeric, ...props }, ref) => {
    const { density } = React.useContext(TableContext);
    return (
      <th
        ref={ref}
        className={cn(
          "text-left align-middle font-medium text-muted-foreground",
          // Type: 12px / uppercase / tracking-wider — the convention
          // for SaaS data tables. Reads as "label" rather than "data."
          "text-xs uppercase tracking-wider",
          density === "compact" ? "h-8 px-3" : "h-11 px-4",
          numeric && "text-right tabular-nums",
          // Checkbox column gets tighter padding so the control sits
          // flush with the row's left edge.
          "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
          className
        )}
        {...props}
      />
    );
  }
);
TableHead.displayName = "TableHead";

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** Right-align + tabular-nums + mono font for numeric columns. */
  numeric?: boolean;
}

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, numeric, ...props }, ref) => {
    const { density } = React.useContext(TableContext);
    return (
      <td
        ref={ref}
        className={cn(
          "align-middle",
          density === "compact" ? "py-1.5 px-3" : "py-3 px-4",
          numeric && "text-right tabular-nums font-mono text-[0.8125rem]",
          "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
          className
        )}
        {...props}
      />
    );
  }
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-sm text-muted-foreground", className)}
    {...props}
  />
));
TableCaption.displayName = "TableCaption";

// TableEmpty — the slot for "no rows" states. Spans full width and
// matches the body row height so the table doesn't visually collapse
// when filters return zero results.
export interface TableEmptyProps extends React.HTMLAttributes<HTMLTableCellElement> {
  colSpan: number;
}

const TableEmpty = React.forwardRef<HTMLTableCellElement, TableEmptyProps>(
  ({ className, colSpan, children, ...props }, ref) => (
    <tr>
      <td
        ref={ref}
        colSpan={colSpan}
        className={cn(
          "h-32 px-4 text-center align-middle text-sm text-muted-foreground",
          className
        )}
        {...props}
      >
        {children}
      </td>
    </tr>
  )
);
TableEmpty.displayName = "TableEmpty";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TableEmpty,
};
