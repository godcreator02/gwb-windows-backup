import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "windowsbackup:inline-flex windowsbackup:shrink-0 windowsbackup:items-center windowsbackup:justify-center windowsbackup:gap-2 windowsbackup:rounded-md windowsbackup:text-sm windowsbackup:font-medium windowsbackup:whitespace-nowrap windowsbackup:transition-all windowsbackup:outline-none windowsbackup:focus-visible:border-ring windowsbackup:focus-visible:ring-[3px] windowsbackup:focus-visible:ring-ring/50 windowsbackup:disabled:pointer-events-none windowsbackup:disabled:opacity-50 windowsbackup:aria-invalid:border-destructive windowsbackup:aria-invalid:ring-destructive/20 windowsbackup:dark:aria-invalid:ring-destructive/40 windowsbackup:[&_svg]:pointer-events-none windowsbackup:[&_svg]:shrink-0 windowsbackup:[&_svg:not([class*=size-])]:size-4",
  {
    variants: {
      variant: {
        default: "windowsbackup:bg-primary windowsbackup:text-primary-foreground windowsbackup:hover:bg-primary/90",
        destructive:
          "windowsbackup:bg-destructive windowsbackup:text-white windowsbackup:hover:bg-destructive/90 windowsbackup:focus-visible:ring-destructive/20 windowsbackup:dark:bg-destructive/60 windowsbackup:dark:focus-visible:ring-destructive/40",
        outline:
          "windowsbackup:border windowsbackup:bg-background windowsbackup:shadow-xs windowsbackup:hover:bg-accent windowsbackup:hover:text-accent-foreground windowsbackup:dark:border-input windowsbackup:dark:bg-input/30 windowsbackup:dark:hover:bg-input/50",
        secondary:
          "windowsbackup:bg-secondary windowsbackup:text-secondary-foreground windowsbackup:hover:bg-secondary/80",
        ghost:
          "windowsbackup:hover:bg-accent windowsbackup:hover:text-accent-foreground windowsbackup:dark:hover:bg-accent/50",
        link: "windowsbackup:text-primary windowsbackup:underline-offset-4 windowsbackup:hover:underline",
      },
      size: {
        default: "windowsbackup:h-9 windowsbackup:px-4 windowsbackup:py-2 windowsbackup:has-[>svg]:px-3",
        xs: "windowsbackup:h-6 windowsbackup:gap-1 windowsbackup:rounded-md windowsbackup:px-2 windowsbackup:text-xs windowsbackup:has-[>svg]:px-1.5 windowsbackup:[&_svg:not([class*=size-])]:size-3",
        sm: "windowsbackup:h-8 windowsbackup:gap-1.5 windowsbackup:rounded-md windowsbackup:px-3 windowsbackup:has-[>svg]:px-2.5",
        lg: "windowsbackup:h-10 windowsbackup:rounded-md windowsbackup:px-6 windowsbackup:has-[>svg]:px-4",
        icon: "windowsbackup:size-9",
        "icon-xs": "windowsbackup:size-6 windowsbackup:rounded-md windowsbackup:[&_svg:not([class*=size-])]:size-3",
        "icon-sm": "windowsbackup:size-8",
        "icon-lg": "windowsbackup:size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
