/**
 * Sanity checks for the search: it must find known tactics and mates.
 * Run with `npm run bench`.
 */
import { Board, moveToUci } from "./board.ts";
import { Searcher } from "./search.ts";

const PUZZLES: [string, string, string[]][] = [
  ["mate in 1 (back rank)", "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", ["d1d8"]],
  ["take the hanging queen", "r3k2r/ppp2ppp/2n5/3q4/8/2N5/PPP2PPP/R3KB1R w KQkq - 0 1", ["c3d5"]],
  ["take the free rook (Qh5+ first also wins it)", "4k3/8/8/8/8/8/3r4/3QK3 w - - 0 1", ["d1d2", "e1d2", "d1h5"]],
  ["K+Q vs K: find mate", "7k/8/5K2/8/8/8/8/6Q1 w - - 0 1", ["g1g7"]],
  ["don't take the poisoned pawn", "rnb1kbnr/pppp1ppp/8/4p3/4P1q1/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1", []],
];

const s = new Searcher();
let failed = 0;
for (const [name, fen, wanted] of PUZZLES) {
  const b = new Board(fen);
  s.clear();
  const r = s.search(b, { timeMs: 2000 });
  const got = moveToUci(r.move);
  const ok = !wanted.length || wanted.includes(got);
  if (!ok) failed++;
  const i = r.info!;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}: ${got} (want ${wanted.join("/") || "any"}) ` +
      `score ${i.mate ? `mate ${i.mate}` : i.score} depth ${i.depth} ` +
      `${i.nodes} nodes ${i.ms}ms (${Math.round(i.nodes / Math.max(i.ms, 1))}k nps) pv ${i.pv.join(" ")}`,
  );
}

// Speed: how deep it gets from the start in 3 seconds.
const b = new Board();
s.clear();
const r = s.search(b, { timeMs: 3000 });
console.log(`start position 3s: depth ${r.info!.depth}, ${r.info!.nodes} nodes, best ${moveToUci(r.move)}`);
process.exit(failed ? 1 : 0);
