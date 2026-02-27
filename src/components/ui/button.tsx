import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phoenix focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-surface-0",
  {
    variants: {
      variant: {
        default: "bg-phoenix text-white hover:bg-phoenix-dark shadow-lg shadow-phoenix/20",
        destructive:
          "bg-error text-white hover:bg-error/90",
        outline:
          "border border-border-default hover:bg-surface-3 hover:text-text-primary",
        secondary:
          "bg-surface-3 text-text-primary hover:bg-surface-hover",
        ghost: "hover:bg-surface-3 hover:text-text-primary",
        link: "underline-offset-4 hover:underline text-phoenix",
      },
      size: {
        default: "h-10 py-2 px-4",
        sm: "h-9 px-3 rounded-md",
        lg: "h-11 px-8 rounded-md",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
