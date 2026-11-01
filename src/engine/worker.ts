/**
 * Runs the bot off the main thread so the board stays smooth while it thinks.
 */
import { ANALYSIS, Bot, LEVELS, PONDER } from "./bot.ts";

export type ToWorker =
  /**
   * Shared stop signal: slot 0 holds the id of the request allowed to run.
   * The page changes it to stop a search early without killing the worker,
   * so the bot keeps its memory of positions between moves.
   */
  | { type: "init"; ctrl: Int32Array }
  | { type: "go"; id: number; history: string[]; level: number | "analysis" | "ponder" }
  | { type: "newgame" };

export type FromWorker =
  | { type: "info"; id: number; depth: number; score: number; mate: number | null; nodes: number; ms: number; pv: string[] }
  | {
      type: "done";
      id: number;
      move: string;
      score: number;
      mate: number | null;
      fromBook: boolean;
      sideToMove: "w" | "b";
      pv: string[];
    };

const bot = new Bot();
let ctrl: Int32Array | null = null;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "init") {
    ctrl = msg.ctrl;
    return;
  }
  if (msg.type === "newgame") {
    bot.newGame();
    return;
  }
  const level =
    msg.level === "analysis" ? ANALYSIS : msg.level === "ponder" ? PONDER : (LEVELS[msg.level] ?? LEVELS[0]!);
  const c = ctrl;
  const shouldStop = c ? () => Atomics.load(c, 0) !== msg.id : undefined;
  const r = bot.think(
    msg.history,
    level,
    (info) => self.postMessage({ type: "info", id: msg.id, ...info } satisfies FromWorker),
    shouldStop,
  );
  self.postMessage({
    type: "done",
    id: msg.id,
    move: r.move,
    score: r.score,
    mate: r.mate,
    fromBook: r.fromBook,
    sideToMove: msg.history.length % 2 === 0 ? "w" : "b",
    pv: r.info?.pv ?? [],
  } satisfies FromWorker);
};
