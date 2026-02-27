import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-phoenix focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-phoenix text-white hover:bg-phoenix-dark shadow-[0_0_10px_rgba(255,107,53,0.3)]",
        secondary:
          "border-transparent bg-surface-3 text-text-primary hover:bg-surface-hover",
        destructive:
          "border-transparent bg-error text-white hover:bg-error/80",
        outline: "text-text-primary border-border-default",
        success:
          "border-transparent bg-success/20 text-success hover:bg-success/30 border-success/20",
        warning:
          "border-transparent bg-warning/20 text-warning hover:bg-warning/30 border-warning/20",
        error:
          "border-transparent bg-error/20 text-error hover:bg-error/30 border-error/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
