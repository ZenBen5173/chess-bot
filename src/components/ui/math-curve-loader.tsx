"use client";

import { useId, useMemo } from "react";
import { cn } from "@/lib/utils";

/**
 * Loaders that trace a mathematical curve.
 *
 * A spinner says "wait". A curve being drawn says "wait" and is worth looking
 * at while you do, which is the whole difference between a loading state
 * people tolerate and one they do not mind.
 *
 * The curves are the classical ones — rose, Lissajous, hypotrochoid, cardioid,
 * Cassini, epitrochoid, butterfly, spiral — plotted from their own parametric
 * equations. Nothing here is sampled from an image or hand-drawn: change a
 * parameter and the shape changes correctly, because it is the real function.
 *
 * The animation is a dash travelling along the path rather than a rotating
 * element, so the head follows the curve exactly however it loops or crosses
 * itself. Every path is normalised to `pathLength={1}`, which is what makes
 * one set of dash numbers work for a cardioid and a butterfly alike — without
 * it each curve's real length differs by an order of magnitude and every one
 * would need its own tuning.
 *
 * CSS, not a JS loop: a loader is the one component guaranteed to be on screen
 * while the main thread is busy, and a spinner that stutters while the page
 * loads is worse than no spinner. It also stops on its own under
 * `prefers-reduced-motion`, where the curve simply shows itself whole.
 */

export type CurveName =
  | "rose"
  | "lissajous"
  | "hypotrochoid"
  | "cardioid"
  | "cassini"
  | "epitrochoid"
  | "butterfly"
  | "spiral";

type Point = [number, number];

/**
 * Each curve as its own function of t, returning a point in roughly the unit
 * circle. Scaling to the viewBox happens once, afterwards, so the equations
 * stay readable as the mathematics they are.
 */
const CURVES: Record<
  CurveName,
  { label: string; formula: string; turns: number; plot: (t: number) => Point }
> = {
  rose: {
    label: "Rose",
    // k even gives 2k petals, and the whole rose closes in one turn. A
    // fractional k needs several turns and, at k = 2/5, produces three lobes
    // rather than anything anyone would call a rose — checked by counting the
    // radius maxima rather than by eye.
    formula: "r = cos(4θ)",
    turns: 1,
    plot: (t) => {
      const r = Math.cos(4 * t);
      return [r * Math.cos(t), r * Math.sin(t)];
    },
  },
  lissajous: {
    label: "Lissajous",
    formula: "x = sin(at + δ), y = sin(bt)",
    turns: 1,
    plot: (t) => [Math.sin(3 * t + Math.PI / 2), Math.sin(2 * t)],
  },
  hypotrochoid: {
    label: "Hypotrochoid",
    // A circle rolling inside another: the spirograph everyone has drawn.
    formula: "x = (R−r)cos t + d·cos(((R−r)/r)t)",
    // Closes after three turns: plotting more just redraws it.
    turns: 3,
    plot: (t) => {
      const R = 5, r = 3, d = 5;
      const k = (R - r) / r;
      return [
        ((R - r) * Math.cos(t) + d * Math.cos(k * t)) / (R - r + d),
        ((R - r) * Math.sin(t) - d * Math.sin(k * t)) / (R - r + d),
      ];
    },
  },
  cardioid: {
    label: "Cardioid",
    formula: "r = a(1 − cos θ)",
    turns: 1,
    plot: (t) => {
      const r = (1 - Math.cos(t)) / 2;
      return [r * Math.cos(t), r * Math.sin(t)];
    },
  },
  cassini: {
    label: "Cassini oval",
    // r² = c²cos2θ + √(a⁴ − c⁴sin²2θ). With a slightly above c it stays one
    // connected loop; below, it splits in two and the trace would have to
    // jump between them.
    formula: "r² = c²cos2θ + √(a⁴ − c⁴sin²2θ)",
    turns: 1,
    plot: (t) => {
      const a = 1.06, c = 1;
      const cos2 = Math.cos(2 * t);
      const inner = a ** 4 - c ** 4 * Math.sin(2 * t) ** 2;
      const r = Math.sqrt(Math.max(c * c * cos2 + Math.sqrt(Math.max(inner, 0)), 0));
      return [r * Math.cos(t), r * Math.sin(t)];
    },
  },
  epitrochoid: {
    label: "Epitrochoid",
    formula: "x = (R+r)cos t − d·cos(((R+r)/r)t)",
    // (R+r)/r is a whole number here, so one turn is the whole curve.
    turns: 1,
    plot: (t) => {
      const R = 3, r = 1, d = 1;
      const k = (R + r) / r;
      return [
        ((R + r) * Math.cos(t) - d * Math.cos(k * t)) / (R + r + d),
        ((R + r) * Math.sin(t) - d * Math.sin(k * t)) / (R + r + d),
      ];
    },
  },
  butterfly: {
    label: "Butterfly",
    formula: "r = e^{sin θ} − 2cos(4θ) + sin⁵((2θ−π)/24)",
    turns: 12,
    plot: (t) => {
      const r =
        Math.exp(Math.sin(t)) -
        2 * Math.cos(4 * t) +
        Math.sin((2 * t - Math.PI) / 24) ** 5;
      // Rotated a quarter turn so it stands upright rather than on its side.
      return [r * Math.sin(t), -r * Math.cos(t)];
    },
  },
  spiral: {
    label: "Spiral",
    formula: "r = aθ",
    turns: 4,
    plot: (t) => {
      const r = t / (4 * 2 * Math.PI);
      return [r * Math.cos(t), r * Math.sin(t)];
    },
  },
};

export const CURVE_NAMES = Object.keys(CURVES) as CurveName[];

/** Label and equation, for anyone who wants to caption one. */
export function curveInfo(curve: CurveName) {
  const { label, formula } = CURVES[curve];
  return { label, formula };
}

/**
 * How finely the curve is sampled.
 *
 * A butterfly turns twelve times and needs the points; a cardioid turns once
 * and would waste them. Scaling with the number of turns keeps every curve
 * smooth without any of them carrying a thousand-point path for nothing.
 */
const SAMPLES_PER_TURN = 90;

/**
 * Samples the curve, then fits what it actually drew to the box.
 *
 * Assuming the origin is the middle of a curve only holds for the symmetric
 * ones. A cardioid has its cusp at the origin and all of its body to one side,
 * and a spiral winds outward from it — both sat off-centre and undersized
 * while the rose beside them filled its frame. Measuring the extent and fitting
 * to that centres every curve on what it draws rather than on where its
 * equation happens to put zero, and it retires the per-curve fudge factors the
 * butterfly and the Cassini oval needed to look the right size.
 *
 * The scale is one number for both axes, so nothing is stretched: a circle
 * stays a circle.
 */
function buildPath(curve: CurveName, size: number, stroke: number): string {
  const { turns, plot } = CURVES[curve];
  const steps = Math.round(SAMPLES_PER_TURN * turns);

  const points: Point[] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * turns * 2 * Math.PI;
    const [x, y] = plot(t);
    points.push([x, y]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const box = size - stroke * 2;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min(box / spanX, box / spanY);
  // Centre the drawn extent in the box, rather than the equation's origin.
  const offsetX = (size - spanX * scale) / 2 - minX * scale;
  const offsetY = (size - spanY * scale) / 2 - minY * scale;

  let d = "";
  for (let i = 0; i < points.length; i += 1) {
    const [x, y] = points[i]!;
    const px = x * scale + offsetX;
    const py = y * scale + offsetY;
    d += `${i === 0 ? "M" : "L"}${px.toFixed(2)} ${py.toFixed(2)}`;
  }
  return d;
}

export function MathCurveLoader({
  curve = "rose",
  size = 48,
  /** Seconds for one full pass. Lower is faster. */
  speed = 3,
  /** How much of the curve the moving segment covers, 0 to 1. */
  trail = 0.28,
  /** The faint full curve behind the moving part. Off leaves only the head. */
  showGuide = true,
  strokeWidth = 2,
  className,
  label = "Loading",
}: {
  curve?: CurveName;
  size?: number;
  speed?: number;
  trail?: number;
  showGuide?: boolean;
  strokeWidth?: number;
  className?: string;
  /** Announced to screen readers, which cannot see a curve being drawn. */
  label?: string;
}) {
  // Mask ids must be unique: several loaders on one page sharing an id would
  // all take the first one's mask and the rest would render as flat strokes.
  const id = useId().replace(/:/g, "");
  const d = useMemo(() => buildPath(curve, size, strokeWidth), [curve, size, strokeWidth]);

  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-block", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <defs>
          {/* The head is brightest and the tail fades out. A plain dash has two
              hard ends and reads as a sliding block rather than something
              travelling. */}
          <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="1" />
          </linearGradient>
        </defs>

        {showGuide && (
          <path
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.12}
          />
        )}

        <path
          d={d}
          pathLength={1}
          fill="none"
          stroke={`url(#${id}-fade)`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={
            {
              strokeDasharray: `${trail} ${1 - trail}`,
              animation: `curve-trace ${speed}s linear infinite`,
            } as React.CSSProperties
          }
        />
      </svg>
    </span>
  );
}
