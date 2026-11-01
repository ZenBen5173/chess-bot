/**
 * The bot: opening book + search, tuned per difficulty level.
 */
import { Board, moveToUci } from "./board.ts";
import { Searcher, type SearchInfo } from "./search.ts";

export interface Level {
  name: string;
  blurb: string;
  /** Rough playing strength, for the label only. */
  elo: string;
  maxDepth?: number;
  timeMs?: number;
  noise: number;
  /** Chance of using the opening book while still in it. */
  book: number;
}

export const LEVELS: Level[] = [
  { name: "Pawn", blurb: "Sees one move. Misses a lot.", elo: "~400", maxDepth: 1, noise: 220, book: 0.3 },
  { name: "Knight", blurb: "Looks two moves ahead.", elo: "~900", maxDepth: 2, noise: 90, book: 0.6 },
  { name: "Bishop", blurb: "Solid. Punishes loose pieces.", elo: "~1300", maxDepth: 4, timeMs: 1500, noise: 25, book: 0.9 },
  { name: "Rook", blurb: "Thinks for about a second.", elo: "~1700", timeMs: 1200, noise: 0, book: 1 },
  { name: "Queen", blurb: "Full strength. Takes its time.", elo: "~2000", timeMs: 4000, noise: 0, book: 1 },
];

/** Analysis: full strength, no randomness. Book moves are instant. */
export const ANALYSIS: Level = { name: "Analysis", blurb: "", elo: "", timeMs: 2500, noise: 0, book: 1 };

/** Pondering: thinks with no time limit until told to stop. */
export const PONDER: Level = { name: "Ponder", blurb: "", elo: "", noise: 0, book: 0 };

/** A handful of main lines so the bot does not play the same game every time. */
const BOOK = [
  "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1",
  "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3",
  "e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6",
  "e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4",
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6",
  "e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3",
  "e2e4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7",
  "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5",
  "e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5",
  "e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6",
  "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7",
  "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4",
  "d2d4 g8f6 c2c4 e7e6 g1f3 d7d5 b1c3 f8e7",
  "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8",
  "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8",
  "c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3",
  "g1f3 d7d5 d2d4 g8f6 c2c4 e7e6",
].map((l) => l.split(" "));

function bookMove(history: string[]): string | null {
  const options = BOOK.filter(
    (line) => line.length > history.length && history.every((m, i) => line[i] === m),
  ).map((line) => line[history.length]!);
  if (!options.length) return null;
  return options[Math.floor(Math.random() * options.length)]!;
}

export interface BotResult {
  move: string;
  score: number;
  mate: number | null;
  fromBook: boolean;
  info: SearchInfo | null;
}

export class Bot {
  private searcher = new Searcher();

  stop() {
    this.searcher.stop();
  }

  newGame() {
    this.searcher.clear();
  }

  /** `history` is the game so far in UCI from the start position. */
  think(history: string[], level: Level, onInfo?: (i: SearchInfo) => void, shouldStop?: () => boolean): BotResult {
    const b = new Board();
    for (const uci of history) {
      const m = b.parseUci(uci);
      if (m === null) throw new Error(`illegal move in history: ${uci}`);
      b.make(m);
    }

    if (Math.random() < level.book) {
      const bm = bookMove(history);
      if (bm && b.parseUci(bm) !== null) {
        return { move: bm, score: 0, mate: null, fromBook: true, info: null };
      }
    }

    const r = this.searcher.search(b, {
      maxDepth: level.maxDepth,
      timeMs: level.timeMs,
      noise: level.noise,
      onInfo,
      shouldStop,
    });
    return {
      move: moveToUci(r.move),
      score: r.score,
      mate: r.info?.mate ?? null,
      fromBook: false,
      info: r.info,
    };
  }
}
