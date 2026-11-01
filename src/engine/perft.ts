/**
 * Perft: counts every legal move sequence to a fixed depth and compares with
 * published totals. If move generation has any bug (castling, en passant,
 * promotion, pins), these numbers come out wrong. Run with `npm run perft`.
 */
import { Board, START_FEN } from "./board.ts";

const CASES: [string, string, number[]][] = [
  ["start", START_FEN, [20, 400, 8902, 197281, 4865609]],
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862, 4085603]],
  ["pos3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238, 674624]],
  ["pos4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467, 422333]],
  ["pos5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379, 2103487]],
];

let hashErrors = 0;

function perft(b: Board, depth: number, checkHash: boolean): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of b.pseudoMoves()) {
    if (!b.make(m)) continue;
    if (checkHash) {
      const h1 = b.hash1;
      const h2 = b.hash2;
      b.computeHash();
      if (h1 !== b.hash1 || h2 !== b.hash2) hashErrors++;
    }
    n += perft(b, depth - 1, checkHash);
    b.unmake();
  }
  return n;
}

let failed = 0;
for (const [name, fen, expected] of CASES) {
  const b = new Board(fen);
  expected.forEach((want, i) => {
    const depth = i + 1;
    const t = performance.now();
    const got = perft(b, depth, depth <= 3);
    const ms = Math.round(performance.now() - t);
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} d${depth}: ${got} (want ${want}) ${ms}ms`);
  });
  if (b.fen() !== fen) {
    failed++;
    console.log(`FAIL ${name}: board not restored, got ${b.fen()}`);
  }
}
console.log(hashErrors ? `FAIL hash mismatches: ${hashErrors}` : "ok   incremental hash matches");
process.exit(failed || hashErrors ? 1 : 0);
