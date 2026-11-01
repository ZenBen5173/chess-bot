/**
 * Search: looks ahead to find the best move.
 *
 * Negamax alpha-beta (minimax where "my score = minus your score", skipping
 * lines that cannot change the result), run with iterative deepening — depth
 * 1, then 2, then 3… until time runs out, so there is always a finished answer.
 *
 * What makes it fast enough to be useful:
 * - Transposition table: remembers positions already searched.
 * - Move ordering: best-looking moves first (hash move, good captures,
 *   killer moves, history) so alpha-beta cuts more.
 * - Quiescence: at the leaves, keep resolving captures so the bot never
 *   stops counting in the middle of an exchange.
 * - Null-move pruning and late-move reductions: spend less time on moves
 *   that are very likely bad.
 */
import {
  Board,
  F_CAPTURE,
  KING,
  PAWN,
  type Move,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  moveToUci,
  typeOf,
} from "./board.ts";
import { VALUE, evaluate } from "./evaluate.ts";

export const MATE = 100000;
const INF = 1000000;
const MAX_PLY = 64;

const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const EXACT = 1;
const LOWER = 2;
const UPPER = 3;

export interface SearchInfo {
  depth: number;
  /** Centipawns from the side to move. */
  score: number;
  /** Moves to mate (positive = we mate), or null. */
  mate: number | null;
  nodes: number;
  ms: number;
  pv: string[];
}

export interface SearchOptions {
  /** Stop after this long. */
  timeMs?: number;
  maxDepth?: number;
  /**
   * Random centipawns added to each root move's score, to make lower levels
   * play like people who miss things rather than like a perfect bot that
   * suddenly hangs a queen.
   */
  noise?: number;
  onInfo?: (info: SearchInfo) => void;
  /** Polled during the search; returning true stops it with the best move so far. */
  shouldStop?: () => boolean;
}

class Abort extends Error {}

export class Searcher {
  private ttKey = new Uint32Array(TT_SIZE);
  private ttMove = new Int32Array(TT_SIZE);
  private ttScore = new Int32Array(TT_SIZE);
  private ttDepth = new Int8Array(TT_SIZE);
  private ttFlag = new Uint8Array(TT_SIZE);

  private killers = new Int32Array(MAX_PLY * 2);
  private historyScore = new Int32Array(16 * 128);

  private nodes = 0;
  private deadline = Infinity;
  private stopped = false;
  private shouldStop: (() => boolean) | undefined;

  stop() {
    this.stopped = true;
  }

  clear() {
    this.ttKey.fill(0);
    this.ttFlag.fill(0);
  }

  search(b: Board, opts: SearchOptions = {}): { move: Move; score: number; info: SearchInfo | null } {
    const start = performance.now();
    const maxDepth = Math.min(opts.maxDepth ?? MAX_PLY - 4, MAX_PLY - 4);
    this.deadline = opts.timeMs ? start + opts.timeMs : Infinity;
    this.stopped = false;
    this.shouldStop = opts.shouldStop;
    this.nodes = 0;
    this.killers.fill(0);
    this.historyScore.fill(0);

    const rootMoves = b.legalMoves();
    if (!rootMoves.length) return { move: 0, score: b.inCheck() ? -MATE : 0, info: null };

    let best = rootMoves[0]!;
    let bestScore = -INF;
    let lastInfo: SearchInfo | null = null;
    const noise = opts.noise ?? 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      try {
        let iterBest = best;
        let iterScore: number;

        if (noise > 0) {
          // Score every root move with a full window so the noise compares
          // honest numbers, then pick the best after adding the noise.
          let top = -INF;
          for (const m of this.ordered(b, rootMoves, best, 0)) {
            b.make(m);
            const s = -this.negamax(b, depth - 1, -INF, INF, 1, true);
            b.unmake();
            const noisy = s + (Math.random() * 2 - 1) * noise;
            if (noisy > top) {
              top = noisy;
              iterBest = m;
              iterScore = s;
            }
          }
          iterScore ??= top;
        } else {
          let alpha = -INF;
          const beta = INF;
          iterScore = -INF;
          let first = true;
          for (const m of this.ordered(b, rootMoves, best, 0)) {
            b.make(m);
            let s: number;
            if (first) {
              s = -this.negamax(b, depth - 1, -beta, -alpha, 1, true);
            } else {
              // Principal variation search: prove this move is worse with a
              // zero-width window; re-search only if it is not.
              s = -this.negamax(b, depth - 1, -alpha - 1, -alpha, 1, true);
              if (s > alpha) s = -this.negamax(b, depth - 1, -beta, -alpha, 1, true);
            }
            b.unmake();
            first = false;
            if (s > iterScore) {
              iterScore = s;
              iterBest = m;
            }
            if (s > alpha) alpha = s;
          }
        }

        best = iterBest;
        bestScore = iterScore!;
        this.store(b, depth, bestScore, EXACT, best, 0);

        const ms = Math.round(performance.now() - start);
        lastInfo = {
          depth,
          score: bestScore,
          mate: mateIn(bestScore),
          nodes: this.nodes,
          ms,
          pv: this.pv(b, best),
        };
        opts.onInfo?.(lastInfo);

        if (Math.abs(bestScore) > MATE - MAX_PLY) break; // found a forced mate
        if (rootMoves.length === 1) break;
        // Not worth starting a depth we are unlikely to finish.
        if (opts.timeMs && performance.now() - start > opts.timeMs * 0.5) break;
      } catch (e) {
        if (!(e instanceof Abort)) throw e;
        break;
      }
    }

    return { move: best, score: bestScore, info: lastInfo };
  }

  private checkTime() {
    if ((this.nodes & 2047) === 0 && (this.stopped || performance.now() > this.deadline || this.shouldStop?.())) {
      throw new Abort();
    }
  }

  private negamax(b: Board, depth: number, alpha: number, beta: number, ply: number, allowNull: boolean): number {
    this.nodes++;
    this.checkTime();

    if (b.halfmove >= 100 || b.isRepetition(1) || b.insufficientMaterial()) return 0;

    const inCheck = b.inCheck();
    if (inCheck) depth++; // check extension: never stop looking while in check
    if (depth <= 0) return this.quiesce(b, alpha, beta, ply);
    if (ply >= MAX_PLY - 1) return evaluate(b);

    // Mate distance pruning: no line from here can beat a mate already found nearer the root.
    alpha = Math.max(alpha, -MATE + ply);
    beta = Math.min(beta, MATE - ply - 1);
    if (alpha >= beta) return alpha;

    const pvNode = beta - alpha > 1;
    const i = b.hash1 & TT_MASK;
    let hashMove = 0;
    if (this.ttKey[i] === b.hash2 && this.ttFlag[i]) {
      hashMove = this.ttMove[i]!;
      if (!pvNode && this.ttDepth[i]! >= depth) {
        const s = fromTT(this.ttScore[i]!, ply);
        const f = this.ttFlag[i];
        if (f === EXACT || (f === LOWER && s >= beta) || (f === UPPER && s <= alpha)) return s;
      }
    }

    // Null move: if passing the turn still beats beta, a real move surely
    // would. Skipped in check and in pawn endings, where passing can be best
    // (zugzwang).
    if (allowNull && !inCheck && !pvNode && depth >= 3 && this.hasPieces(b)) {
      const r = depth > 6 ? 3 : 2;
      b.makeNull();
      const s = -this.negamax(b, depth - 1 - r, -beta, -beta + 1, ply + 1, false);
      b.unmakeNull();
      if (s >= beta && Math.abs(s) < MATE - MAX_PLY) return beta;
    }

    const moves = this.ordered(b, b.pseudoMoves(), hashMove, ply);
    const startAlpha = alpha;
    let best = -INF;
    let bestMove = 0;
    let legal = 0;

    for (const m of moves) {
      if (!b.make(m)) continue;
      legal++;
      const quiet = !(moveFlags(m) & F_CAPTURE) && !movePromo(m);
      const givesCheck = b.inCheck();
      let s: number;

      if (legal === 1) {
        s = -this.negamax(b, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        // Late move reduction: quiet moves sorted late are usually bad, so
        // look at them less deeply first and only re-search if they surprise.
        let reduction = 0;
        if (depth >= 3 && legal > 3 && quiet && !inCheck && !givesCheck) {
          reduction = legal > 10 ? 2 : 1;
        }
        s = -this.negamax(b, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && reduction) s = -this.negamax(b, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && s < beta) s = -this.negamax(b, depth - 1, -beta, -alpha, ply + 1, true);
      }
      b.unmake();

      if (s > best) {
        best = s;
        bestMove = m;
      }
      if (s > alpha) alpha = s;
      if (alpha >= beta) {
        if (quiet) {
          // Remember quiet moves that refute a line; they often refute siblings too.
          if (this.killers[ply * 2] !== m) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2]!;
            this.killers[ply * 2] = m;
          }
          this.historyScore[b.sq[moveFrom(m)]! * 128 + moveTo(m)]! += depth * depth;
        }
        break;
      }
    }

    if (!legal) return inCheck ? -MATE + ply : 0;

    const flag = best >= beta ? LOWER : best > startAlpha ? EXACT : UPPER;
    this.store(b, depth, best, flag, bestMove, ply);
    return best;
  }

  private quiesce(b: Board, alpha: number, beta: number, ply: number): number {
    this.nodes++;
    this.checkTime();

    const stand = evaluate(b);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (ply >= MAX_PLY - 1) return stand;

    for (const m of this.ordered(b, b.pseudoMoves(true), 0, -1)) {
      // Delta pruning: even winning this piece cannot lift us to alpha.
      const victim = typeOf(b.sq[moveTo(m)]!) || PAWN;
      if (!movePromo(m) && stand + VALUE[victim]! + 200 < alpha) continue;
      if (!b.make(m)) continue;
      const s = -this.quiesce(b, -beta, -alpha, ply + 1);
      b.unmake();
      if (s >= beta) return s;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  private hasPieces(b: Board): boolean {
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const p = b.sq[s]!;
      if (p && (p & 8) === b.side && typeOf(p) !== PAWN && typeOf(p) !== KING) return true;
    }
    return false;
  }

  /** Sorts moves best-guess first. ply < 0 means quiescence (no killers). */
  private ordered(b: Board, moves: Move[], hashMove: Move, ply: number): Move[] {
    const scores = new Map<Move, number>();
    for (const m of moves) {
      let s: number;
      if (m === hashMove) s = 10_000_000;
      else if (moveFlags(m) & F_CAPTURE) {
        // MVV-LVA: most valuable victim, least valuable attacker.
        const victim = typeOf(b.sq[moveTo(m)]!) || PAWN;
        const attacker = typeOf(b.sq[moveFrom(m)]!);
        s = 1_000_000 + victim * 100 - attacker;
      } else if (movePromo(m)) s = 900_000 + movePromo(m);
      else if (ply >= 0 && m === this.killers[ply * 2]) s = 800_000;
      else if (ply >= 0 && m === this.killers[ply * 2 + 1]) s = 700_000;
      else s = this.historyScore[b.sq[moveFrom(m)]! * 128 + moveTo(m)]!;
      scores.set(m, s);
    }
    return moves.slice().sort((x, y) => scores.get(y)! - scores.get(x)!);
  }

  private store(b: Board, depth: number, score: number, flag: number, move: Move, ply: number) {
    const i = b.hash1 & TT_MASK;
    // Replace shallower entries, or anything from a different position.
    if (this.ttKey[i] === b.hash2 && this.ttDepth[i]! > depth && flag !== EXACT) return;
    this.ttKey[i] = b.hash2;
    this.ttMove[i] = move;
    this.ttScore[i] = toTT(score, ply);
    this.ttDepth[i] = depth;
    this.ttFlag[i] = flag;
  }

  /** Walks the table from the root to recover the expected line of play. */
  private pv(b: Board, first: Move): string[] {
    const line: string[] = [];
    let m = first;
    let made = 0;
    const seen = new Set<string>();
    while (m && made < 12) {
      if (!b.legalMoves().includes(m)) break;
      line.push(moveToUci(m));
      b.make(m);
      made++;
      const key = `${b.hash1}:${b.hash2}`;
      if (seen.has(key)) break;
      seen.add(key);
      const i = b.hash1 & TT_MASK;
      m = this.ttKey[i] === b.hash2 && this.ttFlag[i] ? this.ttMove[i]! : 0;
    }
    while (made--) b.unmake();
    return line;
  }
}

// Mate scores are stored relative to the node, not the root, so a mate found
// via one path is still correct when reached by a shorter or longer one.
const toTT = (s: number, ply: number) => (s > MATE - MAX_PLY ? s + ply : s < -MATE + MAX_PLY ? s - ply : s);
const fromTT = (s: number, ply: number) => (s > MATE - MAX_PLY ? s - ply : s < -MATE + MAX_PLY ? s + ply : s);

function mateIn(score: number): number | null {
  if (score > MATE - MAX_PLY) return Math.ceil((MATE - score) / 2);
  if (score < -MATE + MAX_PLY) return -Math.ceil((MATE + score) / 2);
  return null;
}
