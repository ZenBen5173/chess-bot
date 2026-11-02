import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  BISHOP,
  Board,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  WHITE,
  colorOf,
  moveFrom,
  moveTo,
  typeOf,
} from "@/engine/board";
import { EASE, SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

const GLYPH = ["", "", "♞", "♝", "♜", "♛", "♚"];

/** Drawn, not typed: iPhones show the ♟ character as a black emoji whatever its colour is set to. */
function PawnIcon() {
  return (
    <svg className="piece-pawn" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="8.5" r="4.5" />
      <path d="M13 14.5C13 19 11.5 22 9.5 24.5H22.5C20.5 22 19 19 19 14.5Z" />
      <rect x="11" y="12.5" width="10" height="2.25" rx="1.1" />
      <rect x="7.5" y="24.5" width="17" height="3.5" rx="1.5" />
    </svg>
  );
}

export function PieceGlyph({ piece, className, style }: { piece: number; className?: string; style?: React.CSSProperties }) {
  return (
    <span
      className={cn("piece-glyph", colorOf(piece) === WHITE ? "piece-white" : "piece-black", className)}
      style={style}
    >
      {typeOf(piece) === PAWN ? (
        <PawnIcon />
      ) : (
        <>
          {GLYPH[typeOf(piece)]}
          {"︎"}
        </>
      )}
    </span>
  );
}

export interface LastMove {
  from: number;
  to: number;
  rookFrom?: number;
  rookTo?: number;
  captured: boolean;
}

interface Props {
  board: Board;
  orientation: "w" | "b";
  interactive: boolean;
  lastMove: LastMove | null;
  /** Number of plies played; keys the arrival animation. */
  ply: number;
  /** Changes on every new game; replays the entrance. */
  gameId: number;
  hint: { from: number; to: number } | null;
  promotion: { to: number; color: number } | null;
  onMove: (from: number, to: number) => void;
  onPromote: (type: number | null) => void;
}

const SQUARES = Array.from({ length: 64 }, (_, i) => i);

export function ChessBoard({
  board,
  orientation,
  interactive,
  lastMove,
  ply,
  gameId,
  hint,
  promotion,
  onMove,
  onPromote,
}: Props) {
  const flip = orientation === "b";
  const ref = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dragStart = useRef<{ from: number; x: number; y: number; active: boolean; wasSelected: boolean } | null>(null);

  const legal = useMemo(() => board.legalMoves(), [board]);
  const targets = useMemo(() => {
    const set = new Set<number>();
    const from = drag?.from ?? selected;
    if (from === null) return set;
    for (const m of legal) if (moveFrom(m) === from) set.add(moveTo(m));
    return set;
  }, [legal, selected, drag]);

  // Drop selection when the position changes underneath it.
  useEffect(() => setSelected(null), [board]);

  // Display grid position of a 0x88 square.
  const col = (s: number) => (flip ? 7 - (s & 7) : s & 7);
  const row = (s: number) => (flip ? s >> 4 : 7 - (s >> 4));
  const toSquare = (r: number, c: number) => (flip ? r * 16 + (7 - c) : (7 - r) * 16 + c);

  const squareAt = (clientX: number, clientY: number): number | null => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return null;
    const c = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const r = Math.floor(((clientY - rect.top) / rect.height) * 8);
    if (c < 0 || c > 7 || r < 0 || r > 7) return null;
    return toSquare(r, c);
  };

  // Latest values for the window listeners below.
  const live = useRef({ targets, onMove });
  live.current = { targets, onMove };

  useEffect(() => {
    function move(e: PointerEvent) {
      const d = dragStart.current;
      if (!d) return;
      if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.active = true;
      if (d.active) setDrag({ from: d.from, x: e.clientX, y: e.clientY });
      setHover(squareAt(e.clientX, e.clientY));
    }
    function up(e: PointerEvent) {
      const d = dragStart.current;
      dragStart.current = null;
      if (!d) return;
      if (d.active) {
        const to = squareAt(e.clientX, e.clientY);
        setDrag(null);
        if (to !== null && live.current.targets.has(to)) {
          live.current.onMove(d.from, to);
          setSelected(null);
        } else if (to !== d.from) {
          setSelected(null);
        }
      } else if (d.wasSelected) {
        setSelected(null); // second click on the same piece deselects
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // squareAt only depends on `flip`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flip]);

  function handleDown(e: React.PointerEvent, s: number) {
    if (!interactive || promotion) return;
    e.preventDefault();
    if (selected !== null && targets.has(s)) {
      onMove(selected, s);
      setSelected(null);
      return;
    }
    const p = board.sq[s]!;
    if (p && colorOf(p) === board.side) {
      dragStart.current = { from: s, x: e.clientX, y: e.clientY, active: false, wasSelected: selected === s };
      setSelected(s);
    } else {
      setSelected(null);
    }
  }

  const checkSq = board.inCheck() ? board.kings[board.side >> 3]! : -1;
  const fontSize = "calc(var(--board) * 0.098)";

  return (
    <div
      ref={ref}
      className="relative grid aspect-square touch-none select-none grid-cols-8 grid-rows-8 overflow-hidden rounded-xl shadow-2xl shadow-black/40 ring-1 ring-white/10"
      style={{ width: "var(--board)" }}
      onPointerLeave={() => !dragStart.current && setHover(null)}
    >
      {SQUARES.map((i) => {
        const r = Math.floor(i / 8);
        const c = i % 8;
        const s = toSquare(r, c);
        const light = ((s >> 4) + (s & 7)) % 2 === 1;
        const p = board.sq[s]!;
        const isTarget = targets.has(s);
        const isLast = lastMove && (lastMove.from === s || lastMove.to === s);
        const own = p && colorOf(p) === board.side && interactive;

        // Did this piece just arrive here? Then slide it in from where it came.
        let fromSq: number | null = null;
        if (lastMove?.to === s) fromSq = lastMove.from;
        else if (lastMove?.rookTo === s) fromSq = lastMove.rookFrom ?? null;
        const arriving = fromSq !== null;
        const dx = arriving ? (col(fromSq!) - c) * 100 : 0;
        const dy = arriving ? (row(fromSq!) - r) * 100 : 0;
        const entrance = ply === 0;

        return (
          <div
            key={s}
            onPointerDown={(e) => handleDown(e, s)}
            onPointerEnter={() => setHover(s)}
            className={cn("relative", own || isTarget ? "cursor-pointer" : "", arriving && "z-10")}
            style={{ background: light ? "var(--sq-light)" : "var(--sq-dark)" }}
          >
            {isLast && <div className="absolute inset-0" style={{ background: "var(--sq-last)" }} />}
            {selected === s && (
              <motion.div
                layoutId="select"
                className="absolute inset-0"
                style={{ background: "var(--sq-select)" }}
                transition={SPRING.snappy}
              />
            )}
            {checkSq === s && (
              <motion.div
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 1.4, repeat: Infinity }}
                style={{ background: "radial-gradient(circle, oklch(0.63 0.24 25 / 0.95) 0%, oklch(0.63 0.24 25 / 0.5) 45%, transparent 75%)" }}
              />
            )}
            {interactive && hover === s && !p && !isTarget && (
              <div className="pointer-events-none absolute inset-0 bg-white/10" />
            )}

            {/* Coordinates along the near edges */}
            {c === 0 && (
              <span
                className="pointer-events-none absolute left-1 top-0.5 text-[10px] font-semibold sm:text-xs"
                style={{ color: light ? "var(--sq-dark)" : "var(--sq-light)" }}
              >
                {(s >> 4) + 1}
              </span>
            )}
            {r === 7 && (
              <span
                className="pointer-events-none absolute bottom-0.5 right-1 text-[10px] font-semibold sm:text-xs"
                style={{ color: light ? "var(--sq-dark)" : "var(--sq-light)" }}
              >
                {"abcdefgh"[s & 7]}
              </span>
            )}

            {p !== 0 && (
              <motion.div
                key={`${gameId}-${p}-${arriving ? ply : "still"}`}
                className={cn(
                  "absolute inset-0 grid place-items-center",
                  own && "transition-transform duration-200 hover:-translate-y-0.5 hover:scale-[1.06]",
                  drag?.from === s && "opacity-25",
                )}
                initial={
                  entrance
                    ? { opacity: 0, y: r < 4 ? -14 : 14 }
                    : arriving
                      ? { x: `${dx}%`, y: `${dy}%` }
                      : false
                }
                animate={{ opacity: 1, x: 0, y: 0 }}
                transition={
                  entrance
                    ? { duration: 0.45, ease: EASE.expressive, delay: (r < 4 ? r * 8 + c : (7 - r) * 8 + c) * 0.012 }
                    : { duration: 0.28, ease: EASE.expressive }
                }
              >
                <PieceGlyph piece={p} style={{ fontSize }} />
              </motion.div>
            )}

            {/* Legal-move markers: dot on empty squares, ring on captures */}
            <AnimatePresence>
              {isTarget && (
                <motion.div
                  className="pointer-events-none absolute inset-0 grid place-items-center"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: hover === s ? 1.25 : 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={SPRING.snappy}
                >
                  {p ? (
                    <div className="size-[92%] rounded-full border-[5px] border-black/25" />
                  ) : (
                    <div className="size-[30%] rounded-full bg-black/25" />
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* A capture leaves a quick ring behind */}
            {lastMove?.captured && lastMove.to === s && (
              <motion.div
                key={`burst-${ply}`}
                className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/80"
                initial={{ scale: 0.3, opacity: 0.9 }}
                animate={{ scale: 1.4, opacity: 0 }}
                transition={{ duration: 0.5, ease: EASE.decelerate, delay: 0.18 }}
              />
            )}
          </div>
        );
      })}

      {/* Hint arrow */}
      <AnimatePresence>{hint && <HintArrow key={`${hint.from}-${hint.to}`} x1={col(hint.from) + 0.5} y1={row(hint.from) + 0.5} x2={col(hint.to) + 0.5} y2={row(hint.to) + 0.5} />}</AnimatePresence>

      {/* Promotion picker, dropping down from the promotion square */}
      <AnimatePresence>
        {promotion && (
          <motion.div
            className="absolute inset-0 z-30 bg-black/45 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onPointerDown={() => onPromote(null)}
          >
            <div
              className="absolute flex flex-col overflow-hidden rounded-lg bg-card shadow-2xl ring-1 ring-border"
              style={{
                left: `${col(promotion.to) * 12.5}%`,
                width: "12.5%",
                top: row(promotion.to) === 0 ? 0 : undefined,
                bottom: row(promotion.to) === 7 ? 0 : undefined,
                flexDirection: row(promotion.to) === 0 ? "column" : "column-reverse",
              }}
            >
              {[QUEEN, KNIGHT, ROOK, BISHOP].map((t, i) => (
                <motion.button
                  key={t}
                  type="button"
                  className="grid aspect-square place-items-center hover:bg-accent"
                  initial={{ opacity: 0, y: row(promotion.to) === 0 ? -10 : 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, ...SPRING.snappy }}
                  whileHover={{ scale: 1.08 }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onPromote(t);
                  }}
                >
                  <PieceGlyph piece={promotion.color | t} style={{ fontSize }} />
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dragged piece follows the pointer */}
      {drag &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 scale-110 drop-shadow-xl"
            style={{ left: drag.x, top: drag.y, ["--board" as string]: ref.current?.offsetWidth + "px" }}
          >
            <PieceGlyph piece={board.sq[drag.from]!} style={{ fontSize }} />
          </div>,
          document.body,
        )}
    </div>
  );
}


/** Arrow in board units (one square = 1), drawn as a shaft plus a head so it scales cleanly. */
function HintArrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const head = 0.42;
  const half = 0.24;
  const bx = x2 - ux * head;
  const by = y2 - uy * head;
  const color = "oklch(0.72 0.17 152 / 0.85)";
  return (
    <motion.svg
      className="pointer-events-none absolute inset-0 z-20 size-full"
      viewBox="0 0 8 8"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: EASE.expressive }}
    >
      <line x1={x1} y1={y1} x2={bx} y2={by} stroke={color} strokeWidth={0.17} strokeLinecap="round" />
      <polygon
        points={`${x2},${y2} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`}
        fill={color}
      />
    </motion.svg>
  );
}
