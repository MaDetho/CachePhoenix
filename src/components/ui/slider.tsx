import * as React from "react"
import { cn } from "@/lib/utils"

export interface SliderProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value: number[]
  onValueChange?: (value: number[]) => void
  min?: number
  max?: number
  step?: number
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, value, onValueChange, min = 0, max = 100, step = 1, ...props }, ref) => {
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value)
      onValueChange?.([newValue])
    }

    const safeValue = Array.isArray(value) ? value[0] : min
    const percentage = ((safeValue - min) / (max - min)) * 100

    return (
      <div className={cn("relative flex w-full touch-none select-none items-center", className)}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={safeValue}
          onChange={handleInputChange}
          ref={ref}
          className="absolute h-full w-full cursor-pointer opacity-0 z-10"
          {...props}
        />
        <div className="relative h-2 w-full grow overflow-hidden rounded-full bg-surface-3 border border-border-default">
          <div
            className="absolute h-full bg-phoenix transition-all"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div
          className="absolute h-5 w-5 rounded-full border-2 border-phoenix bg-surface-1 ring-offset-surface-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phoenix focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 shadow-lg"
          style={{ left: `calc(${percentage}% - 10px)` }}
        />
      </div>
    )
  }
)
Slider.displayName = "Slider"

export { Slider }
