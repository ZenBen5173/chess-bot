import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BLACK, WHITE } from "@/engine/board";
import { PieceGlyph } from "@/components/chess/ChessBoard";
import { LEVELS } from "@/engine/bot";
import { SPRING, tween } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Formats a white-POV score: "+0.45", "−1.20", "M3". */
export function formatScore(cp: number, mate: number | null) {
  if (mate !== null) return `${mate > 0 ? "" : "−"}M${Math.abs(mate)}`;
  const v = (cp / 100).toFixed(2);
  return cp > 0 ? `+${v}` : cp < 0 ? `−${v.slice(1)}` : "0.00";
}

/** Vertical bar showing who is better. White fills from the bottom (or top when flipped). */
export function EvalBar({ cp, mate, flipped }: { cp: number; mate: number | null; flipped: boolean }) {
  const white = mate !== null ? (mate > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
  const whiteAhead = mate !== null ? mate > 0 : cp >= 0;
  return (
    <div
      className="relative w-3 overflow-hidden rounded-full bg-[#1c2024] ring-1 ring-white/10 sm:w-4"
      style={{ height: "var(--board)" }}
      title={`Evaluation ${formatScore(cp, mate)}`}
    >
      <motion.div
        className={cn("absolute inset-x-0 bg-[#f0f0f3]", flipped ? "top-0" : "bottom-0")}
        animate={{ height: `${white}%` }}
        transition={SPRING.soft}
      />
      <div className="absolute inset-x-0 top-1/2 h-px bg-[#8b8d98]/60" />
      <span
        className={cn(
          "absolute inset-x-0 text-center text-[8px] font-bold sm:text-[9px]",
          whiteAhead !== flipped ? "bottom-1 text-[#1c2024]" : "top-1 text-[#f0f0f3]",
        )}
      >
        {formatScore(Math.abs(cp), mate === null ? null : Math.abs(mate)).replace("+", "")}
      </span>
    </div>
  );
}

/** Difficulty picker: one chess piece per level, with its name and blurb on hover. */
export function LevelPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="relative grid grid-cols-5 rounded-full bg-muted p-1" onMouseLeave={() => setHover(null)}>
      {LEVELS.map((l, i) => {
        const on = value === i;
        return (
          <button
            key={l.name}
            type="button"
            aria-label={`${l.name} — ${l.blurb}`}
            onClick={() => onChange(i)}
            onMouseEnter={() => setHover(i)}
            className="group relative z-10 grid h-9 place-items-center rounded-full"
          >
            {on && (
              <motion.span layoutId="level-pill" className="absolute inset-0 -z-10 rounded-full bg-foreground" transition={SPRING.default} />
            )}
            <motion.span
              animate={{ y: hover === i ? -2 : 0, scale: on ? 1.08 : 1 }}
              transition={SPRING.snappy}
              className={cn("transition-opacity", on ? "opacity-100" : "opacity-55 group-hover:opacity-100")}
            >
              <PieceGlyph piece={(on ? BLACK : WHITE) | (i + 1)} style={{ fontSize: 20 }} />
            </motion.span>
          </button>
        );
      })}
      <AnimatePresence>
        {hover !== null && (
          <motion.div
            key={hover}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={tween("fast")}
            className="pointer-events-none absolute top-full z-20 mt-1.5 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-lg"
            style={{ left: `${(hover + 0.5) * 20}%`, translateX: "-50%" }}
          >
            <span className="font-medium">{LEVELS[hover]!.name}</span>
            <span className="text-muted-foreground"> · {LEVELS[hover]!.blurb}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Play against the bot, or move both sides and let the bot suggest. */
export function ModePicker({ value, onChange }: { value: "play" | "analyze"; onChange: (v: "play" | "analyze") => void }) {
  const opts = [
    { v: "play" as const, label: "Play" },
    { v: "analyze" as const, label: "Analyse" },
  ];
  return (
    <div className="relative grid grid-cols-2 rounded-full bg-muted p-1">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "relative z-10 rounded-full py-2 text-xs font-medium transition-colors",
            value === o.v ? "text-background" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value === o.v && (
            <motion.span layoutId="mode-pill" className="absolute inset-0 -z-10 rounded-full bg-foreground" transition={SPRING.default} />
          )}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Small segmented control: White / Random / Black. */
export function SidePicker<T extends "w" | "r" | "b">({
  value,
  onChange,
  noRandom,
}: {
  value: T;
  onChange: (v: T) => void;
  noRandom?: boolean;
}) {
  const all = [
    { v: "w" as const, label: "White", dot: "bg-[#f0f0f3]" },
    { v: "r" as const, label: "Random", dot: "bg-gradient-to-r from-[#f0f0f3] from-50% to-[#1c2024] to-50%" },
    { v: "b" as const, label: "Black", dot: "bg-[#1c2024]" },
  ];
  const opts = (noRandom ? all.filter((o) => o.v !== "r") : all) as { v: T; label: string; dot: string }[];
  return (
    <div className={cn("relative grid rounded-full bg-muted p-1", noRandom ? "grid-cols-2" : "grid-cols-3")}>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "relative z-10 flex items-center justify-center gap-1.5 rounded-full py-2 text-xs font-medium transition-colors",
            value === o.v ? "text-background" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value === o.v && (
            <motion.span layoutId={noRandom ? "my-side-pill" : "side-pill"} className="absolute inset-0 -z-10 rounded-full bg-foreground" transition={SPRING.default} />
          )}
          <span className={cn("size-2.5 rounded-full ring-1 ring-[#8b8d98]", o.dot)} />
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Move list in pairs; new moves slide in and the list keeps the latest in view. */
export function MoveList({ sans }: { sans: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [sans.length]);

  const rows = [];
  for (let i = 0; i < sans.length; i += 2) rows.push(i);

  return (
    <div ref={ref} className="max-h-44 overflow-y-auto pr-1 font-mono text-sm">
      {!sans.length && <p className="pt-2 text-xs text-muted-foreground">No moves yet.</p>}
      <div className="grid grid-cols-[2.25rem_1fr_1fr] gap-y-1">
        {rows.map((i) => (
          <Row key={i} n={i / 2 + 1} white={sans[i]!} black={sans[i + 1]} lastIndex={sans.length - 1} i={i} />
        ))}
      </div>
    </div>
  );
}

function Row({ n, white, black, lastIndex, i }: { n: number; white: string; black?: string; lastIndex: number; i: number }) {
  const cell = (san: string, idx: number) => (
    <motion.span
      key={`${idx}-${san}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={tween("fast")}
      className={cn(
        "rounded px-1.5 py-0.5",
        idx === lastIndex ? "bg-primary/20 text-foreground" : "text-foreground/80",
      )}
    >
      {san}
    </motion.span>
  );
  return (
    <>
      <span className="py-0.5 text-muted-foreground/60">{n}.</span>
      {cell(white, i)}
      {black ? cell(black, i + 1) : <span />}
    </>
  );
}
