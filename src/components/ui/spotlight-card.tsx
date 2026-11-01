/**
 * Spotlight Card — from the App Template library (controls/spotlight-card).
 * Adapted into a wrapper: radial glow tracks the cursor, border lights on hover.
 */
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function SpotlightCard({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  function handleMove(event: React.MouseEvent<HTMLDivElement>) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-border bg-card transition-colors duration-300 hover:border-foreground/20",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: visible ? 1 : 0,
          background: `radial-gradient(320px circle at ${pos.x}px ${pos.y}px, rgba(99,102,241,0.14), transparent 70%)`,
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
