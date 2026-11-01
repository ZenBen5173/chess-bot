/**
 * Static evaluation: how good is this position for the side to move, in
 * centipawns (100 = one pawn).
 *
 * Material plus piece-square tables (a bonus or penalty for each piece on each
 * square), with the king's table blended between middlegame and endgame by how
 * much material is left. On top: pawn structure, bishop pair, rooks on open
 * files, and a "mop-up" term that drives a lone king to the edge so won
 * endgames actually get finished.
 */
import { BISHOP, Board, KING, PAWN, ROOK, WHITE, colorOf, typeOf } from "./board.ts";

export const VALUE = [0, 100, 320, 330, 500, 900, 0];

// Tables are written as seen from White, rank 8 at the top.
// prettier-ignore
const PST: number[][] = [
  [],
  [ // pawn
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  [ // knight
   -50,-40,-30,-30,-30,-30,-40,-50,
   -40,-20,  0,  0,  0,  0,-20,-40,
   -30,  0, 10, 15, 15, 10,  0,-30,
   -30,  5, 15, 20, 20, 15,  5,-30,
   -30,  0, 15, 20, 20, 15,  0,-30,
   -30,  5, 10, 15, 15, 10,  5,-30,
   -40,-20,  0,  5,  5,  0,-20,-40,
   -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  [ // bishop
   -20,-10,-10,-10,-10,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5, 10, 10,  5,  0,-10,
   -10,  5,  5, 10, 10,  5,  5,-10,
   -10,  0, 10, 10, 10, 10,  0,-10,
   -10, 10, 10, 10, 10, 10, 10,-10,
   -10,  5,  0,  0,  0,  0,  5,-10,
   -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  [ // rook
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  [ // queen
   -20,-10,-10, -5, -5,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5,  5,  5,  5,  0,-10,
    -5,  0,  5,  5,  5,  5,  0, -5,
     0,  0,  5,  5,  5,  5,  0, -5,
   -10,  5,  5,  5,  5,  5,  0,-10,
   -10,  0,  5,  0,  0,  0,  0,-10,
   -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  [ // king, middlegame: stay tucked behind pawns
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -10,-20,-20,-20,-20,-20,-20,-10,
    20, 20,  0,  0,  0,  0, 20, 20,
    20, 30, 10,  0,  0, 10, 30, 20,
  ],
];

// prettier-ignore
const KING_END = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50,
];

/** Bonus for a passed pawn by how far it has advanced (index = ranks moved). */
const PASSED = [0, 5, 10, 20, 35, 60, 100, 0];

const PHASE = [0, 0, 1, 1, 2, 4, 0];
const MAX_PHASE = 24;

/** Table index for a 0x88 square, flipped for Black so both read "forward". */
const idx = (s: number, white: boolean) => (white ? (7 - (s >> 4)) * 8 + (s & 7) : (s >> 4) * 8 + (s & 7));

export function evaluate(b: Board): number {
  const sq = b.sq;
  // [white, black]
  const score: [number, number] = [0, 0];
  const pawnFiles: [Int8Array, Int8Array] = [new Int8Array(8), new Int8Array(8)];
  const bishops: [number, number] = [0, 0];
  const nonPawn: [number, number] = [0, 0];
  let phase = 0;

  for (let s = 0; s < 128; s++) {
    if (s & 0x88) {
      s += 7;
      continue;
    }
    const p = sq[s]!;
    if (!p) continue;
    const t = typeOf(p);
    const white = colorOf(p) === WHITE;
    const c = white ? 0 : 1;
    phase += PHASE[t]!;
    if (t === PAWN) pawnFiles[c]![s & 7]!++;
    else if (t !== KING) nonPawn[c] += VALUE[t]!;
    if (t === BISHOP) bishops[c]++;
    if (t !== KING) score[c] += VALUE[t]! + PST[t]![idx(s, white)]!;
  }
  phase = Math.min(phase, MAX_PHASE);

  // Second pass: things that need the pawn-file counts.
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) {
      s += 7;
      continue;
    }
    const p = sq[s]!;
    const t = typeOf(p);
    if (t !== PAWN && t !== ROOK) continue;
    const white = colorOf(p) === WHITE;
    const c = white ? 0 : 1;
    const file = s & 7;
    const own = pawnFiles[c]!;
    const opp = pawnFiles[c ? 0 : 1];

    if (t === ROOK) {
      if (!own[file]) score[c] += opp[file] ? 10 : 20;
      continue;
    }

    if (own[file]! > 1) score[c] -= 10; // doubled (counted per pawn)
    if (!(file > 0 && own[file - 1]) && !(file < 7 && own[file + 1])) score[c] -= 12; // isolated

    // Passed: no enemy pawn ahead on this file or either neighbour.
    const rank = s >> 4;
    const dir = white ? 16 : -16;
    let passed = true;
    for (let r = s + dir; !(r & 0x88) && passed; r += dir) {
      for (let df = -1; df <= 1; df++) {
        const f = file + df;
        if (f < 0 || f > 7) continue;
        const q = sq[(r & 0x70) + f]!;
        if (typeOf(q) === PAWN && colorOf(q) !== colorOf(p)) passed = false;
      }
    }
    if (passed) {
      const advanced = white ? rank : 7 - rank;
      // Passed pawns matter far more once pieces come off.
      score[c] += (PASSED[advanced]! * (2 * MAX_PHASE - phase)) / MAX_PHASE;
    }
  }

  if (bishops[0]! >= 2) score[0] += 30;
  if (bishops[1]! >= 2) score[1] += 30;

  // King: blend safety (middlegame) with activity (endgame).
  for (const c of [0, 1] as const) {
    const white = c === 0;
    const k = b.kings[c]!;
    const i = idx(k, white);
    score[c] += (PST[KING]![i]! * phase + KING_END[i]! * (MAX_PHASE - phase)) / MAX_PHASE;
  }

  let total = score[0]! - score[1]!;

  // Mop-up: when clearly winning with few pieces left, herd the enemy king
  // to the edge and walk ours toward it. Without this the bot shuffles
  // forever in K+Q vs K because every quiet move scores the same.
  const diff = nonPawn[0]! - nonPawn[1]!;
  if (phase <= 8 && Math.abs(diff) >= 400) {
    const winner = diff > 0 ? 0 : 1;
    const loser = winner ? 0 : 1;
    const wk = b.kings[winner]!;
    const lk = b.kings[loser]!;
    const centre = Math.max(3 - (lk >> 4), (lk >> 4) - 4) + Math.max(3 - (lk & 7), (lk & 7) - 4);
    const dist = Math.abs((wk >> 4) - (lk >> 4)) + Math.abs((wk & 7) - (lk & 7));
    const bonus = centre * 10 + (14 - dist) * 4;
    total += winner === 0 ? bonus : -bonus;
  }

  return Math.round(b.side === WHITE ? total : -total);
}
