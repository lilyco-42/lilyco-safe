import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 shadow-xs",
        secondary: "bg-[var(--bg-subtle)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--bg-hover)]",
        outline: "border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text)] hover:bg-[var(--bg-hover)]",
        ghost: "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
        destructive: "bg-[var(--danger-soft)] text-[var(--danger)] border border-transparent hover:bg-[var(--danger)] hover:text-white",
      },
      size: {
        default: "h-9 px-3.5 py-2",
        sm: "h-7.5 px-2.5 text-xs",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
