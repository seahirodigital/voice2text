import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/20 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-[#0071e3] px-5 py-2.5 text-white shadow-[0_12px_30px_rgba(0,113,227,0.24)] hover:bg-[#0077ed]",
        secondary:
          "border border-black/10 bg-white px-5 py-2.5 text-[#1d1d1f] hover:border-black/15 hover:bg-black/[0.03]",
        ghost:
          "px-4 py-2 text-[#1d1d1f]/72 hover:bg-black/[0.04] hover:text-[#1d1d1f]",
        danger:
          "border border-[#d92d20]/10 bg-[#fff5f4] px-5 py-2.5 text-[#b42318] hover:bg-[#ffeceb]",
      },
      size: {
        default: "min-h-11",
        sm: "min-h-9 px-4 text-xs",
        lg: "min-h-12 px-6 text-base",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

