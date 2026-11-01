import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  BLACK,
  Board,
  F_CAPTURE,
  F_CASTLE,
  WHITE,
  colorOf,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  moveToUci,
  typeOf,
} from "@/engine/board";
import { ANALYSIS, LEVELS } from "@/engine/bot";
import type { FromWorker, ToWorker } from "@/engine/worker";
import { ChessBoard, PieceGlyph, type LastMove } from "@/components/chess/ChessBoard";
import { EvalBar, LevelPicker, ModePicker, MoveList, SidePicker } from "@/components/chess/Panels";
import { MagneticButton } from "@/components/ui/magnetic-button";
import { MathCurveLoader } from "@/components/ui/math-curve-loader";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { EASE, SPRING, tween } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface Thinking {
  depth: number;
  nodes: number;
  ms: number;
  pv: string[];
}

/** Replays the game and returns the position plus details of the last move for the board. */
function replay(history: string[]) {
  const b = new Board();
  let last: LastMove | null = null;
  for (const uci of history) {
    const m = b.parseUci(uci)!;
    const from = moveFrom(m);
    const to = moveTo(m);
    last = { from, to, captured: !!(moveFlags(m) & F_CAPTURE) };
    if (moveFlags(m) & F_CASTLE) {
      const kingSide = to > from;
      last.rookFrom = kingSide ? from + 3 : from - 4;
      last.rookTo = kingSide ? from + 1 : from - 1;
    }
    b.make(m);
  }
  return { board: b, last };
}

function gameResult(b: Board): string | null {
  if (!b.legalMoves().length) {
    if (!b.inCheck()) return "Draw by stalemate";
    return b.side === WHITE ? "Black wins by checkmate" : "White wins by checkmate";
  }
  if (b.halfmove >= 100) return "Draw by the 50-move rule";
  if (b.insufficientMaterial()) return "Draw — not enough material";
  if (b.isRepetition(2)) return "Draw by threefold repetition";
  return null;
}

const START_COUNT = [0, 8, 2, 2, 2, 1, 1];

/** Pieces each side has lost, and the material balance. */
function captured(b: Board) {
  const count = [new Array(7).fill(0), new Array(7).fill(0)];
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) continue;
    const p = b.sq[s]!;
    if (p) count[colorOf(p) >> 3]![typeOf(p)]++;
  }
  const lost = [[], []] as number[][];
  const worth = [0, 1, 3, 3, 5, 9, 0];
  let balance = 0;
  for (let c = 0; c < 2; c++) {
    for (let t = 5; t >= 1; t--) {
      // Promotions can leave more than the starting count; clamp at zero.
      const n = Math.max(0, START_COUNT[t]! - count[c]![t]!);
      for (let k = 0; k < n; k++) lost[c]!.push(((c ? BLACK : WHITE) | t) as number);
    }
    for (let t = 1; t <= 5; t++) balance += (c ? -1 : 1) * count[c]![t]! * worth[t]!;
  }
  return { lostWhite: lost[0]!, lostBlack: lost[1]!, balance };
}

const sameLine = (a: string[], b: string[]) => a.length === b.length && a.every((m, i) => m === b[i]);

export default function App() {
  const [history, setHistory] = useState<string[]>([]);
  const [sans, setSans] = useState<string[]>([]);
  const [player, setPlayer] = useState<"w" | "b">("w");
  const [sideChoice, setSideChoice] = useState<"w" | "r" | "b">("w");
  const [level, setLevel] = useState(2);
  const [mode, setMode] = useState<"play" | "analyze">("play");
  const [analysisBusy, setAnalysisBusy] = useState(false);
  /** Analyse mode: the side the bot plays for you. You enter the opponent's moves. */
  const [mySide, setMySide] = useState<"w" | "b">("w");
  /** After "Replace my move": wait for you to enter the move you played instead of auto-playing. */
  const [paused, setPaused] = useState(false);
  const [gameId, setGameId] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [thinking, setThinking] = useState<Thinking | null>(null);
  const [botBusy, setBotBusy] = useState(false);
  const [hintBusy, setHintBusy] = useState(false);
  const [hint, setHint] = useState<{ from: number; to: number; san: string; uci: string } | null>(null);
  const [evalCp, setEvalCp] = useState(0);
  const [evalMate, setEvalMate] = useState<number | null>(null);
  const [fromBook, setFromBook] = useState(false);
  const [promotion, setPromotion] = useState<{ from: number; to: number } | null>(null);

  const { board, last } = useMemo(() => replay(history), [history]);
  const result = useMemo(() => gameResult(board), [board]);
  const material = useMemo(() => captured(board), [board]);
  const playerSide = player === "w" ? WHITE : BLACK;
  const analyzing = mode === "analyze";
  const botToMove = !analyzing && !result && board.side !== playerSide;
  const myTurn = analyzing && (board.side === WHITE ? "w" : "b") === mySide;
  const orientation = ((analyzing ? mySide : player) === "w") !== flipped ? "w" : "b";

  // ---- Worker plumbing ----------------------------------------------------
  const worker = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const purpose = useRef<"move" | "hint" | "analysis" | "ponder">("move");
  /** Shared stop signal for the worker (see ToWorker "init"). Null if the browser can't share memory. */
  const ctrl = useRef<Int32Array | null>(null);
  /** The position the current request is searching. */
  const searched = useRef<string[]>([]);
  /** After the bot plays your move: the reply it expects from your opponent. */
  const predict = useRef<{ after: string[]; reply: string } | null>(null);
  /** Thinking on the opponent's time, assuming they play the predicted reply. */
  const ponder = useRef<{
    history: string[];
    start: number;
    result: { move: string; pv: string[] } | null;
    info: Extract<FromWorker, { type: "info" }> | null;
  } | null>(null);
  const finishTimer = useRef<number | undefined>(undefined);
  /** The current analysis search started life as a ponder. */
  const ponderHit = useRef(false);
  /** Tells the search to stop now and answer with its best move so far. */
  const finishNow = () => {
    if (ctrl.current) Atomics.store(ctrl.current, 0, 0);
  };
  const reqSide = useRef<"w" | "b">("w");
  const reqStart = useRef(0);
  const applyTimer = useRef<number | undefined>(undefined);
  const historyRef = useRef(history);
  historyRef.current = history;

  const play = useCallback((uci: string) => {
    const h = historyRef.current;
    const { board: b } = replay(h);
    const m = b.parseUci(uci);
    if (m === null) return;
    const san = b.san(m);
    setHistory([...h, uci]);
    setSans((s) => [...s.slice(0, h.length), san]);
    setHint(null);
  }, []);

  const showBest = useCallback((uci: string) => {
    const { board: b } = replay(historyRef.current);
    const m = b.parseUci(uci);
    if (m !== null) setHint({ from: moveFrom(m), to: moveTo(m), san: b.san(m), uci });
  }, []);

  const onMessage = useCallback(
    (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.id !== reqId.current) return; // stale answer from before an undo or new game
      const toWhite = (s: number) => (reqSide.current === "w" ? s : -s);
      if (msg.type === "info") {
        if (purpose.current === "ponder") {
          if (ponder.current) ponder.current.info = msg;
          return;
        }
        if (purpose.current !== "hint") {
          setThinking({ depth: msg.depth, nodes: msg.nodes, ms: msg.ms, pv: msg.pv });
          setEvalCp(toWhite(msg.score));
          setEvalMate(msg.mate === null ? null : toWhite(msg.mate));
        }
        // Analysis: keep the arrow on the current best guess as it searches deeper.
        if (purpose.current === "analysis" && msg.pv[0]) showBest(msg.pv[0]);
        // A ponder that became our real search has no clock of its own: like a
        // normal search, stop once a depth finishes past half the thinking time.
        if (ponderHit.current && performance.now() - reqStart.current > ANALYSIS.timeMs! / 2) finishNow();
        return;
      }
      if (purpose.current === "ponder") {
        // Finished early (e.g. found a mate). Keep it for when the opponent moves.
        if (ponder.current) ponder.current.result = { move: msg.move, pv: msg.pv };
        return;
      }
      if (purpose.current === "analysis") {
        // Your side: play the best move for you straight away.
        window.clearTimeout(finishTimer.current);
        ponderHit.current = false;
        setAnalysisBusy(false);
        playMine(msg.move, msg.pv);
        return;
      }
      if (purpose.current === "hint") {
        setHintBusy(false);
        showBest(msg.move);
        return;
      }
      setFromBook(msg.fromBook);
      // Quick levels answer instantly; a short pause reads as "it thought about it".
      const wait = Math.max(0, 450 - (performance.now() - reqStart.current));
      applyTimer.current = window.setTimeout(() => {
        setBotBusy(false);
        play(msg.move);
      }, wait);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [play, showBest],
  );

  /** Plays the bot's move for your side and remembers the reply it expects next. */
  function playMine(move: string, pv: string[]) {
    predict.current = pv[0] === move && pv[1] ? { after: [...searched.current, move], reply: pv[1] } : null;
    play(move);
  }

  const spawn = useCallback(() => {
    worker.current?.terminate();
    const w = new Worker(new URL("./engine/worker.ts", import.meta.url), { type: "module" });
    w.onmessage = onMessage;
    if (typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated) {
      ctrl.current ??= new Int32Array(new SharedArrayBuffer(4));
      w.postMessage({ type: "init", ctrl: ctrl.current } satisfies ToWorker);
    }
    worker.current = w;
  }, [onMessage]);

  useEffect(() => {
    spawn();
    return () => worker.current?.terminate();
  }, [spawn]);

  /**
   * Cancels anything in flight. With shared memory the search is told to stop
   * and the worker keeps its memory; otherwise the worker is replaced.
   */
  const cancel = useCallback(() => {
    reqId.current++;
    window.clearTimeout(applyTimer.current);
    window.clearTimeout(finishTimer.current);
    ponderHit.current = false;
    const busy =botBusy || hintBusy || analysisBusy || !!ponder.current;
    ponder.current = null;
    if (ctrl.current) Atomics.store(ctrl.current, 0, reqId.current);
    else if (busy) spawn();
    setBotBusy(false);
    setHintBusy(false);
    setAnalysisBusy(false);
  }, [botBusy, hintBusy, analysisBusy, spawn]);

  const ask = useCallback((kind: "move" | "hint" | "analysis", lvl: number | "analysis") => {
    const id = ++reqId.current;
    purpose.current = kind;
    reqSide.current = historyRef.current.length % 2 === 0 ? "w" : "b";
    reqStart.current = performance.now();
    searched.current = historyRef.current;
    if (ctrl.current) Atomics.store(ctrl.current, 0, id);
    worker.current?.postMessage({ type: "go", id, history: historyRef.current, level: lvl } satisfies ToWorker);
  }, []);

  /** Opponent's turn: start on our answer to the reply we expect, before they make it. */
  function startPonder() {
    const pr = predict.current;
    predict.current = null;
    if (!ctrl.current || !pr || !sameLine(pr.after, history)) return;
    const line = [...history, pr.reply];
    if (board.parseUci(pr.reply) === null || gameResult(replay(line).board)) return;
    const id = ++reqId.current;
    purpose.current = "ponder";
    reqSide.current = mySide;
    reqStart.current = performance.now();
    searched.current = line;
    ponder.current = { history: line, start: reqStart.current, result: null, info: null };
    Atomics.store(ctrl.current, 0, id);
    worker.current?.postMessage({ type: "go", id, history: line, level: "ponder" } satisfies ToWorker);
  }

  /** The opponent played the move we expected: use the thinking already done. */
  function usePonder(p: NonNullable<typeof ponder.current>) {
    ponder.current = null;
    purpose.current = "analysis";
    if (p.info) {
      const toWhite = (s: number) => (mySide === "w" ? s : -s);
      setThinking({ depth: p.info.depth, nodes: p.info.nodes, ms: p.info.ms, pv: p.info.pv });
      setEvalCp(toWhite(p.info.score));
      setEvalMate(p.info.mate === null ? null : toWhite(p.info.mate));
    }
    if (p.result) {
      setAnalysisBusy(false);
      playMine(p.result.move, p.result.pv);
      return;
    }
    // Still searching: it has already thought as long as a normal search would, or
    // it gets the rest of the normal thinking time (capped by finishTimer).
    const elapsed = performance.now() - p.start;
    if (elapsed > ANALYSIS.timeMs! / 2) {
      finishNow();
      return;
    }
    ponderHit.current = true;
    finishTimer.current = window.setTimeout(finishNow, ANALYSIS.timeMs! - elapsed);
  }

  // Bot plays whenever it is its turn.
  useEffect(() => {
    if (!botToMove || promotion) return;
    if (hintBusy) cancel();
    setBotBusy(true);
    setThinking(null);
    ask("move", level);
    // Only re-run when the position or game changes, not when the level does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, gameId, player, mode]);

  // Analysis: on your side's turn the bot finds the best move and plays it for you.
  // On the opponent's turn it waits for you to enter their move.
  // While waiting, it thinks ahead on the reply it expects (pondering).
  useEffect(() => {
    if (!analyzing || promotion) return;
    const p = ponder.current;
    const hit = !!p && myTurn && !paused && !result && sameLine(p.history, history);
    if (!hit) cancel();
    setHint(null);
    if (result || paused) return;
    if (!myTurn) {
      startPonder();
      return;
    }
    setAnalysisBusy(true);
    if (hit) {
      usePonder(p!);
      return;
    }
    setThinking(null);
    ask("analysis", "analysis");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, gameId, mode, mySide, paused]);

  function switchMode(m: "play" | "analyze") {
    if (m === mode) return;
    cancel();
    setPaused(false);
    setHint(null);
    setThinking(null);
    // Back to playing from an analysed position: you take whichever side is to move.
    if (m === "play") setPlayer(board.side === WHITE ? "w" : "b");
    else setMySide(player);
    setMode(m);
  }

  // ---- Actions -------------------------------------------------------------
  function handleMove(from: number, to: number) {
    const moves = board.legalMoves().filter((m) => moveFrom(m) === from && moveTo(m) === to);
    if (!moves.length) return;
    if (moves.some((m) => movePromo(m))) {
      setPromotion({ from, to });
      return;
    }
    if (hintBusy || analysisBusy) cancel();
    setPaused(false);
    play(moveToUci(moves[0]!));
  }

  function handlePromote(type: number | null) {
    const p = promotion;
    setPromotion(null);
    if (!p || type === null) return;
    const m = board.legalMoves().find((x) => moveFrom(x) === p.from && moveTo(x) === p.to && movePromo(x) === type);
    if (m !== undefined) {
      if (hintBusy || analysisBusy) cancel();
      setPaused(false);
      play(moveToUci(m));
    }
  }

  function newGame() {
    cancel();
    worker.current?.postMessage({ type: "newgame" } satisfies ToWorker);
    const side = sideChoice === "r" ? (Math.random() < 0.5 ? "w" : "b") : sideChoice;
    setPlayer(side);
    setFlipped(false);
    setHistory([]);
    setSans([]);
    setHint(null);
    setThinking(null);
    setEvalCp(0);
    setEvalMate(null);
    setFromBook(false);
    setPromotion(null);
    setPaused(false);
    setGameId((g) => g + 1);
  }

  function undo() {
    cancel();
    setPaused(false);
    let h = history.slice();
    if (analyzing) {
      // Back to before the opponent's last move, so you can enter it again.
      const sideAt = (n: number) => (n % 2 === 0 ? "w" : "b");
      do h.pop();
      while (h.length && sideAt(h.length) === mySide);
      if (sideAt(h.length) === mySide) return;
      setHistory(h);
      setSans((s) => s.slice(0, h.length));
      setPromotion(null);
      return;
    }
    // Step back to the player's previous turn.
    do h.pop();
    while (h.length && (h.length % 2 === 0 ? "w" : "b") !== player);
    if ((h.length % 2 === 0 ? "w" : "b") !== player) h = [];
    setHistory(h);
    setSans((s) => s.slice(0, h.length));
    setHint(null);
    setPromotion(null);
    setThinking(null);
  }

  /** Takes back the bot's move for your side so you can enter the one you really played. */
  function replaceMyMove() {
    if (!canReplace) return;
    cancel();
    const h = history.slice(0, -1);
    setHistory(h);
    setSans((s) => s.slice(0, h.length));
    setPromotion(null);
    setPaused(true);
  }

  function askHint() {
    if (analyzing || botToMove || result || hintBusy) return;
    setHint(null);
    setHintBusy(true);
    ask("hint", 3);
  }

  // Keyboard: ←/Backspace undo, H hint, F flip, N new game.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === "f") setFlipped((f) => !f);
      else if (k === "h") askHint();
      else if (k === "r") replaceMyMove();
      else if (k === "n") newGame();
      else if (k === "arrowleft" || k === "backspace") undo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const canUndo = analyzing ? history.length >= (mySide === "w" ? 2 : 1) : history.length > (player === "b" ? 1 : 0);
  // Your side made the last move, so it can be swapped for the one you played.
  const canReplace = analyzing && history.length > 0 && ((history.length - 1) % 2 === 0 ? "w" : "b") === mySide;
  const topLost = orientation === "w" ? material.lostWhite : material.lostBlack;
  const bottomLost = orientation === "w" ? material.lostBlack : material.lostWhite;
  const bottomColor = orientation;
  const adv = (c: "w" | "b") => {
    const v = c === "w" ? material.balance : -material.balance;
    return v > 0 ? `+${v}` : "";
  };
  const playerLabel = (c: "w" | "b") =>
    analyzing ? (c === mySide ? "You" : "Opponent") : c === player ? "You" : "Bot";
  const turnText = result
    ? result
    : analyzing
      ? myTurn
        ? paused
          ? "Enter your move"
          : "Thinking…"
        : "Opponent's move"
      : promotion
      ? "Choose a piece"
      : botToMove
        ? "Thinking…"
        : board.inCheck()
          ? "You're in check!"
          : "Your move";

  return (
    <div
      className="min-h-full px-4 py-6 sm:py-10"
      style={{ ["--board" as string]: "min(calc(100vw - 4rem), calc(100vh - 13rem), 620px)" }}
    >
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 lg:flex-row lg:items-start lg:justify-center">
        {/* ---- Board column ---- */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE.expressive }}
          className="flex flex-col gap-3"
        >
          <PlayerStrip
            label={playerLabel(orientation === "w" ? "b" : "w")}
            color={orientation === "w" ? "b" : "w"}
            lost={topLost}
            advantage={adv(orientation === "w" ? "b" : "w")}
            active={!result && (board.side === WHITE ? "w" : "b") !== orientation}
          />
          <div className="flex items-stretch gap-3">
            <EvalBar cp={evalCp} mate={evalMate} flipped={orientation === "b"} />
            <div className="relative">
              <ChessBoard
                board={board}
                orientation={orientation}
                interactive={!result && (analyzing || !botToMove)}
                lastMove={last}
                ply={history.length}
                gameId={gameId}
                hint={hint}
                promotion={promotion ? { to: promotion.to, color: board.side } : null}
                onMove={handleMove}
                onPromote={handlePromote}
              />
              <AnimatePresence>
                {result && (
                  <motion.div
                    className="absolute inset-0 z-40 grid place-items-center rounded-xl bg-black/40 backdrop-blur-[3px]"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ delay: 0.5, duration: 0.3 }}
                  >
                    <motion.div
                      initial={{ scale: 0.9, y: 10, opacity: 0 }}
                      animate={{ scale: 1, y: 0, opacity: 1 }}
                      transition={{ delay: 0.6, ...SPRING.default }}
                      className="rounded-2xl border border-border bg-card px-8 py-6 text-center shadow-2xl"
                    >
                      <p className="text-xs uppercase tracking-widest text-muted-foreground">Game over</p>
                      <p className="mt-2 text-xl font-semibold">{analyzing ? "Game over" : resultTitle(result, player)}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{result}</p>
                      <div className="mt-5 flex justify-center gap-2">
                        <MagneticButton onClick={newGame}>Play again</MagneticButton>
                        <MagneticButton variant="outline" onClick={undo} disabled={!canUndo}>
                          Take back
                        </MagneticButton>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
          <PlayerStrip
            label={playerLabel(bottomColor)}
            color={bottomColor}
            lost={bottomLost}
            advantage={adv(bottomColor)}
            active={!result && (board.side === WHITE ? "w" : "b") === orientation}
          />
        </motion.div>

        {/* ---- Side panel ---- */}
        <Stagger i={1}>
          <SpotlightCard className="flex w-full max-w-sm flex-col gap-4 p-5 lg:w-80">
            <ModePicker value={mode} onChange={switchMode} />
            {analyzing ? (
              <SidePicker
                value={mySide}
                onChange={(v) => {
                  setPaused(false);
                  setMySide(v);
                }}
                noRandom
              />
            ) : (
              <>
                <LevelPicker value={level} onChange={setLevel} />
                <SidePicker value={sideChoice} onChange={setSideChoice} />
              </>
            )}

            <div className="flex items-center gap-2.5 border-t border-border pt-4">
              <span className="grid size-6 place-items-center text-primary">
                {botBusy || hintBusy || analysisBusy ? (
                  <MathCurveLoader curve="hypotrochoid" size={22} speed={2.4} label="Bot thinking" />
                ) : (
                  <span className="text-lg leading-none">{result ? "⚑" : "♞"}</span>
                )}
              </span>
              <motion.p
                key={hintBusy ? "hint" : hint && !analyzing ? `hint-${hint.uci}` : turnText}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={tween("fast")}
                className="truncate text-sm font-medium"
              >
                {hintBusy ? (
                  "Finding a hint…"
                ) : hint && !analyzing ? (
                  <>
                    Try <span className="text-[oklch(0.72_0.17_152)]">{hint.san}</span>
                  </>
                ) : (
                  turnText
                )}
              </motion.p>
            </div>

            <div className="flex flex-wrap gap-2">
              <MagneticButton onClick={newGame} title="New game (N)" className={btn}>
                New
              </MagneticButton>
              <MagneticButton variant="outline" onClick={undo} disabled={!canUndo} title="Undo (←)" className={btn}>
                Undo
              </MagneticButton>
              {analyzing ? (
                <MagneticButton
                  variant="outline"
                  onClick={replaceMyMove}
                  disabled={!canReplace}
                  title="Take back the bot's move and enter yours (R)"
                  className={btn}
                >
                  Replace
                </MagneticButton>
              ) : (
                <MagneticButton
                  variant="outline"
                  onClick={askHint}
                  disabled={botToMove || !!result || hintBusy}
                  title="Hint (H)"
                  className={btn}
                >
                  Hint
                </MagneticButton>
              )}
              <MagneticButton variant="outline" onClick={() => setFlipped((f) => !f)} title="Flip board (F)" className={btn}>
                Flip
              </MagneticButton>
            </div>

            <MovesDisclosure sans={sans} />
          </SpotlightCard>
        </Stagger>
      </div>
    </div>
  );
}

const btn = "px-4 py-2 text-xs";

/** Move list folded away behind a one-line toggle that shows the latest move. */
function MovesDisclosure({ sans }: { sans: string[] }) {
  const [open, setOpen] = useState(false);
  const lastSan = sans.at(-1);
  const lastNo = Math.ceil(sans.length / 2);
  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span>Moves</span>
        <AnimatePresence mode="popLayout" initial={false}>
          {lastSan && !open && (
            <motion.span
              key={sans.length}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={tween("fast")}
              className="font-mono text-foreground/80"
            >
              {lastNo}.{sans.length % 2 === 0 ? ".." : ""} {lastSan}
            </motion.span>
          )}
        </AnimatePresence>
        <span
          className={cn(
            "ml-auto block size-1.5 border-r-[1.5px] border-t-[1.5px] border-current transition-transform duration-200 group-hover:translate-y-px",
            open ? "-rotate-45" : "rotate-[135deg]",
          )}
        />
      </button>
      <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <div className="pt-1">
            <MoveList sans={sans} />
          </div>
        </div>
      </div>
    </div>
  );
}

function resultTitle(result: string, player: "w" | "b") {
  if (result.startsWith("Draw")) return "Draw";
  const whiteWon = result.startsWith("White");
  return whiteWon === (player === "w") ? "You win! 🎉" : "The bot wins";
}

function Stagger({ i, children }: { i: number; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE.expressive, delay: 0.1 + i * 0.07 }}
    >
      {children}
    </motion.div>
  );
}

function PlayerStrip({
  label,
  color,
  lost,
  advantage,
  active,
}: {
  label: string;
  color: "w" | "b";
  lost: number[];
  advantage: string;
  active: boolean;
}) {
  // A player's strip shows the pieces they have captured: the opponent's losses.
  return (
    <div className="flex h-7 items-center gap-2 pl-6 sm:pl-7">
      <span className="relative grid size-3 place-items-center">
        <span className={`size-3 rounded-full ring-1 ring-[#8b8d98] ${color === "w" ? "bg-[#f0f0f3]" : "bg-[#1c2024]"}`} />
        {active && (
          <motion.span
            className="absolute inset-0 rounded-full ring-2 ring-primary"
            animate={{ scale: [1, 1.8], opacity: [0.8, 0] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </span>
      <span className="text-sm font-medium">{label}</span>
      <span className="ml-1 flex items-center">
        <AnimatePresence initial={false}>
          {lost.map((p, i) => (
            <motion.span
              key={`${p}-${i}`}
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.4 }}
              transition={SPRING.snappy}
              className="-ml-1 first:ml-0"
            >
              <PieceGlyph piece={p} style={{ fontSize: 18 }} />
            </motion.span>
          ))}
        </AnimatePresence>
      </span>
      {advantage && <span className="font-mono text-xs text-muted-foreground">{advantage}</span>}
    </div>
  );
}

