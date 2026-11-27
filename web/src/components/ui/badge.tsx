import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]",
        secondary: "border-[var(--border)] bg-[var(--bg-subtle)] text-[var(--text-secondary)]",
        success: "border-transparent bg-[var(--success-soft)] text-[var(--success)]",
        warning: "border-transparent bg-[var(--warning-soft)] text-[var(--warning)]",
        destructive: "border-transparent bg-[var(--danger-soft)] text-[var(--danger)]",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
