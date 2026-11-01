/**
 * Estimates the bot's Elo by playing it against Stockfish set to known
 * strengths (UCI_LimitStrength / UCI_Elo), alternating colours.
 *
 *   npm run elo -- [msPerMove=1000] [gamesPerLevel=6] [elo,elo,...=1400,1700,2000]
 *
 * Stockfish's Elo setting is calibrated for long games, so treat the result
 * as a ballpark, not an official rating.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Board, moveToUci } from "./board.ts";
import { Bot, type Level } from "./bot.ts";

const msPerMove = Number(process.argv[2] ?? 1000);
const gamesPerLevel = Number(process.argv[3] ?? 6);
const levels = (process.argv[4] ?? "1400,1700,2000").split(",").map(Number);
const MAX_PLIES = 240;

const us: Level = { name: "Analysis", blurb: "", elo: "", timeMs: msPerMove, noise: 0, book: 1 };

/** A UCI engine running as a child process. */
class Uci {
  private proc;
  private buf = "";
  private waiters: { test: (l: string) => boolean; resolve: (l: string) => void }[] = [];

  constructor(cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.find((x) => x.test(line));
        if (w) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
    });
  }

  send(cmd: string) {
    this.proc.stdin.write(cmd + "\n");
  }

  wait(prefix: string): Promise<string> {
    return new Promise((resolve) => this.waiters.push({ test: (l) => l.startsWith(prefix), resolve }));
  }

  quit() {
    this.send("quit");
  }
}

function stockfish(): Uci {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("stockfish/package.json");
  const bin = require("stockfish/package.json").bin;
  const rel = typeof bin === "string" ? bin : Object.values(bin as Record<string, string>)[0]!;
  return new Uci(process.execPath, [join(dirname(pkg), rel)]);
}

/** Plays one game. Returns our score: 1 win, 0.5 draw, 0 loss. */
async function game(sf: Uci, sfElo: number, weAreWhite: boolean, bot: Bot): Promise<{ score: number; why: string; plies: number }> {
  const b = new Board();
  const history: string[] = [];
  sf.send("ucinewgame");
  sf.send(`setoption name UCI_LimitStrength value true`);
  sf.send(`setoption name UCI_Elo value ${sfElo}`);
  sf.send("isready");
  await sf.wait("readyok");
  bot.newGame();

  while (true) {
    if (!b.legalMoves().length) {
      if (!b.inCheck()) return { score: 0.5, why: "stalemate", plies: history.length };
      const whiteLost = b.side === 0;
      return { score: whiteLost === weAreWhite ? 0 : 1, why: "mate", plies: history.length };
    }
    if (b.halfmove >= 100) return { score: 0.5, why: "50-move", plies: history.length };
    if (b.insufficientMaterial()) return { score: 0.5, why: "material", plies: history.length };
    if (b.isRepetition(2)) return { score: 0.5, why: "repetition", plies: history.length };
    if (history.length >= MAX_PLIES) return { score: 0.5, why: "move limit", plies: history.length };

    const ourTurn = (b.side === 0) === weAreWhite;
    let uci: string;
    if (ourTurn) {
      uci = bot.think(history, us).move;
    } else {
      sf.send(`position startpos${history.length ? " moves " + history.join(" ") : ""}`);
      sf.send(`go movetime ${msPerMove}`);
      uci = (await sf.wait("bestmove")).split(" ")[1]!;
    }
    const m = b.parseUci(uci);
    if (m === null) throw new Error(`illegal move ${uci} after ${history.join(" ")}`);
    b.make(m);
    history.push(moveToUci(m));
  }
}

const eloDiff = (p: number) => -400 * Math.log10(1 / Math.min(Math.max(p, 0.01), 0.99) - 1);

const sf = stockfish();
sf.send("uci");
await sf.wait("uciok");
const bot = new Bot();

console.log(`${msPerMove}ms per move, ${gamesPerLevel} games per level, Stockfish at ${levels.join(", ")}`);
let total = 0;
let played = 0;
let oppSum = 0;
for (const elo of levels) {
  let score = 0;
  const marks: string[] = [];
  for (let g = 0; g < gamesPerLevel; g++) {
    const white = g % 2 === 0;
    const r = await game(sf, elo, white, bot);
    score += r.score;
    marks.push(r.score === 1 ? "W" : r.score === 0 ? "L" : "D");
    console.log(`  vs ${elo} game ${g + 1} as ${white ? "White" : "Black"}: ${r.score === 1 ? "win" : r.score === 0 ? "loss" : "draw"} (${r.why}, ${r.plies} plies)`);
  }
  total += score;
  played += gamesPerLevel;
  oppSum += elo * gamesPerLevel;
  const p = score / gamesPerLevel;
  console.log(`vs Stockfish ${elo}: ${score}/${gamesPerLevel} ${marks.join("")} → about ${Math.round(elo + eloDiff(p))}`);
}
const perf = oppSum / played + eloDiff(total / played);
console.log(`\nOverall: ${total}/${played}. Estimated Elo ≈ ${Math.round(perf)} (at ${msPerMove}ms per move)`);
sf.quit();
process.exit(0);
