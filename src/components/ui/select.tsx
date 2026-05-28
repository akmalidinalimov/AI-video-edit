"use client";

import * as React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { cn } from "@/lib/utils";
import { ChevronDown, Check } from "lucide-react";

/* ───────────────────────────── Root ───────────────────────────── */

interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
}

function Select({ value, onValueChange, children, disabled }: SelectProps) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(val: string | null) => {
        if (val !== null && onValueChange) onValueChange(val);
      }}
      disabled={disabled}
    >
      {children}
    </BaseSelect.Root>
  );
}

/* ───────────────────────────── Trigger ─────────────────────────── */

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"button"> & { className?: string }) {
  return (
    <BaseSelect.Trigger
      className={cn(
        "flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate",
        className
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon>
        <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

/* ───────────────────────────── Value ──────────────────────────── */

function SelectValue({ placeholder }: { placeholder?: string }) {
  return <BaseSelect.Value placeholder={placeholder} />;
}

/* ──────────────────────────── Content ─────────────────────────── */

function SelectContent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        className="z-50"
        sideOffset={4}
      >
        <BaseSelect.Popup
          className={cn(
            "relative min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            className
          )}
        >
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

/* ───────────────────────────── Item ──────────────────────────── */

function SelectItem({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <BaseSelect.Item
      value={value}
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
    >
      <BaseSelect.ItemIndicator className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <Check className="h-3.5 w-3.5" />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  );
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
