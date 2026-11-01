/**
 * Magnetic Button — from the App Template library (controls/magnetic-button).
 * Adapted: takes onClick/disabled/className and a quieter outline variant.
 */
import { useRef } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

const { stiffness, damping, mass } = SPRING.follow;
const FOLLOW = { stiffness, damping, mass };

export function MagneticButton({
  children,
  onClick,
  disabled,
  variant = "solid",
  strength = 0.35,
  className,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "solid" | "outline";
  /** 0 = inert, 1 = the button sticks to the cursor. */
  strength?: number;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const sx = useSpring(x, FOLLOW);
  const sy = useSpring(y, FOLLOW);

  // The label travels a little further than the button itself — that offset is
  // what reads as "magnetic" rather than "the whole thing moved".
  const labelX = useTransform(sx, (v) => v * 0.4);
  const labelY = useTransform(sy, (v) => v * 0.4);

  function handleMove(event: React.MouseEvent<HTMLButtonElement>) {
    if (disabled) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    x.set((event.clientX - (rect.left + rect.width / 2)) * strength);
    y.set((event.clientY - (rect.top + rect.height / 2)) * strength);
  }

  function reset() {
    x.set(0);
    y.set(0);
  }

  return (
    <motion.button
      ref={ref}
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      onMouseMove={handleMove}
      onMouseLeave={reset}
      style={{ x: sx, y: sy }}
      whileTap={disabled ? undefined : { scale: 0.95 }}
      className={cn(
        "relative rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        variant === "solid"
          ? "bg-foreground text-background hover:bg-foreground/90"
          : "border border-border bg-card text-foreground hover:border-foreground/25",
        className,
      )}
    >
      <motion.span style={{ x: labelX, y: labelY }} className="pointer-events-none flex items-center gap-2">
        {children}
      </motion.span>
    </motion.button>
  );
}
