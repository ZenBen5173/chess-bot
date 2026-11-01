/**
 * Chess rules: board, legal move generation, make/unmake, FEN and SAN.
 *
 * Uses a 0x88 board: 128 slots where square = rank * 16 + file. A square is
 * on the board when (sq & 0x88) === 0, so stepping off an edge is one cheap
 * bit test instead of bounds checks. Rank 0 is White's back rank.
 */

export const WHITE = 0;
export const BLACK = 8;

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const EMPTY = 0;

export const typeOf = (p: number) => p & 7;
export const colorOf = (p: number) => p & 8;

// Move flags
export const F_CAPTURE = 1;
export const F_EP = 2;
export const F_CASTLE = 4;
export const F_DOUBLE = 8;

/** A move packed into one int: from | to << 7 | promo << 14 | flags << 17. */
export type Move = number;

export const moveFrom = (m: Move) => m & 0x7f;
export const moveTo = (m: Move) => (m >> 7) & 0x7f;
export const movePromo = (m: Move) => (m >> 14) & 7;
export const moveFlags = (m: Move) => (m >> 17) & 0xf;
const makeMove = (from: number, to: number, promo = 0, flags = 0): Move =>
  from | (to << 7) | (promo << 14) | (flags << 17);

const CASTLE_WK = 1;
const CASTLE_WQ = 2;
const CASTLE_BK = 4;
const CASTLE_BQ = 8;

const KNIGHT_STEPS = [33, 31, 18, 14, -33, -31, -18, -14];
const KING_STEPS = [1, -1, 16, -16, 15, 17, -15, -17];
const BISHOP_STEPS = [15, 17, -15, -17];
const ROOK_STEPS = [1, -1, 16, -16];

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const sqName = (sq: number) => "abcdefgh"[sq & 7] + String((sq >> 4) + 1);
export const sqFromName = (n: string) => (n.charCodeAt(1) - 49) * 16 + (n.charCodeAt(0) - 97);

/**
 * Castling rights left after a move touches a square. Moving a king or rook,
 * or capturing a rook on its home square, clears the matching right.
 */
const CASTLE_MASK = new Uint8Array(128).fill(15);
CASTLE_MASK[0x04] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[0x00] = 15 & ~CASTLE_WQ;
CASTLE_MASK[0x07] = 15 & ~CASTLE_WK;
CASTLE_MASK[0x74] = 15 & ~(CASTLE_BK | CASTLE_BQ);
CASTLE_MASK[0x70] = 15 & ~CASTLE_BQ;
CASTLE_MASK[0x77] = 15 & ~CASTLE_BK;

/*
 * Zobrist hashing: every (piece, square) pair, side and castling/ep state gets
 * a random number; the position hash is their XOR. Two independent 32-bit
 * tables give a 64-bit key without BigInt — one indexes the table, the other
 * confirms the hit.
 */
let seed = 0x9e3779b9;
function rand32() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}
const zPiece1 = new Uint32Array(16 * 128).map(rand32);
const zPiece2 = new Uint32Array(16 * 128).map(rand32);
const zCastle1 = new Uint32Array(16).map(rand32);
const zCastle2 = new Uint32Array(16).map(rand32);
const zEp1 = new Uint32Array(8).map(rand32);
const zEp2 = new Uint32Array(8).map(rand32);
const zSide1 = rand32();
const zSide2 = rand32();

interface Undo {
  move: Move;
  captured: number;
  castling: number;
  ep: number;
  halfmove: number;
  hash1: number;
  hash2: number;
}

export class Board {
  sq = new Int8Array(128);
  side = WHITE;
  castling = 0;
  /** En passant target square, or -1. */
  ep = -1;
  halfmove = 0;
  fullmove = 1;
  kings = [0, 0]; // indexed by side >> 3
  hash1 = 0;
  hash2 = 0;
  history: Undo[] = [];

  constructor(fen = START_FEN) {
    this.load(fen);
  }

  load(fen: string) {
    const [placement, side, castling, ep, half, full] = fen.trim().split(/\s+/);
    this.sq.fill(EMPTY);
    let rank = 7;
    let file = 0;
    for (const ch of placement!) {
      if (ch === "/") {
        rank--;
        file = 0;
      } else if (ch >= "1" && ch <= "8") {
        file += Number(ch);
      } else {
        const color = ch === ch.toUpperCase() ? WHITE : BLACK;
        const type = " pnbrqk".indexOf(ch.toLowerCase());
        const s = rank * 16 + file;
        this.sq[s] = color | type;
        if (type === KING) this.kings[color >> 3] = s;
        file++;
      }
    }
    this.side = side === "b" ? BLACK : WHITE;
    this.castling = 0;
    if (castling?.includes("K")) this.castling |= CASTLE_WK;
    if (castling?.includes("Q")) this.castling |= CASTLE_WQ;
    if (castling?.includes("k")) this.castling |= CASTLE_BK;
    if (castling?.includes("q")) this.castling |= CASTLE_BQ;
    this.ep = ep && ep !== "-" ? sqFromName(ep) : -1;
    this.halfmove = Number(half ?? 0);
    this.fullmove = Number(full ?? 1);
    this.history = [];
    this.computeHash();
  }

  computeHash() {
    let h1 = 0;
    let h2 = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const p = this.sq[s]!;
      if (p) {
        h1 ^= zPiece1[p * 128 + s]!;
        h2 ^= zPiece2[p * 128 + s]!;
      }
    }
    h1 ^= zCastle1[this.castling]!;
    h2 ^= zCastle2[this.castling]!;
    if (this.ep >= 0) {
      h1 ^= zEp1[this.ep & 7]!;
      h2 ^= zEp2[this.ep & 7]!;
    }
    if (this.side === BLACK) {
      h1 ^= zSide1;
      h2 ^= zSide2;
    }
    this.hash1 = h1 >>> 0;
    this.hash2 = h2 >>> 0;
  }

  fen(): string {
    let out = "";
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.sq[rank * 16 + file]!;
        if (!p) {
          empty++;
          continue;
        }
        if (empty) out += empty;
        empty = 0;
        const ch = " pnbrqk"[typeOf(p)]!;
        out += colorOf(p) === WHITE ? ch.toUpperCase() : ch;
      }
      if (empty) out += empty;
      if (rank) out += "/";
    }
    let c = "";
    if (this.castling & CASTLE_WK) c += "K";
    if (this.castling & CASTLE_WQ) c += "Q";
    if (this.castling & CASTLE_BK) c += "k";
    if (this.castling & CASTLE_BQ) c += "q";
    return `${out} ${this.side === WHITE ? "w" : "b"} ${c || "-"} ${
      this.ep >= 0 ? sqName(this.ep) : "-"
    } ${this.halfmove} ${this.fullmove}`;
  }

  /** Is `s` attacked by any piece of color `by`? */
  attacked(s: number, by: number): boolean {
    const sq = this.sq;
    // Pawns: a white pawn on t attacks t+15 and t+17, so look back from s.
    if (by === WHITE) {
      if (!((s - 15) & 0x88) && sq[s - 15] === (WHITE | PAWN)) return true;
      if (!((s - 17) & 0x88) && sq[s - 17] === (WHITE | PAWN)) return true;
    } else {
      if (!((s + 15) & 0x88) && sq[s + 15] === (BLACK | PAWN)) return true;
      if (!((s + 17) & 0x88) && sq[s + 17] === (BLACK | PAWN)) return true;
    }
    for (const d of KNIGHT_STEPS) {
      const t = s + d;
      if (!(t & 0x88) && sq[t] === (by | KNIGHT)) return true;
    }
    for (const d of KING_STEPS) {
      const t = s + d;
      if (!(t & 0x88) && sq[t] === (by | KING)) return true;
    }
    for (const d of BISHOP_STEPS) {
      for (let t = s + d; !(t & 0x88); t += d) {
        const p = sq[t]!;
        if (!p) continue;
        if (p === (by | BISHOP) || p === (by | QUEEN)) return true;
        break;
      }
    }
    for (const d of ROOK_STEPS) {
      for (let t = s + d; !(t & 0x88); t += d) {
        const p = sq[t]!;
        if (!p) continue;
        if (p === (by | ROOK) || p === (by | QUEEN)) return true;
        break;
      }
    }
    return false;
  }

  inCheck(side = this.side): boolean {
    return this.attacked(this.kings[side >> 3]!, side ^ 8);
  }

  /** Pseudo-legal moves: may leave own king in check. `capturesOnly` for quiescence. */
  pseudoMoves(capturesOnly = false): Move[] {
    const moves: Move[] = [];
    const sq = this.sq;
    const us = this.side;
    const them = us ^ 8;

    for (let from = 0; from < 128; from++) {
      if (from & 0x88) {
        from += 7;
        continue;
      }
      const p = sq[from]!;
      if (!p || colorOf(p) !== us) continue;
      const type = typeOf(p);

      if (type === PAWN) {
        const fwd = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 6 : 1;
        const rank = from >> 4;
        const one = from + fwd;
        if (!capturesOnly || rank === promoRank) {
          if (!(one & 0x88) && !sq[one]) {
            if (rank === promoRank) {
              for (const pr of [QUEEN, ROOK, BISHOP, KNIGHT]) moves.push(makeMove(from, one, pr));
            } else if (!capturesOnly) {
              moves.push(makeMove(from, one));
              const two = one + fwd;
              if (rank === startRank && !sq[two]) moves.push(makeMove(from, two, 0, F_DOUBLE));
            }
          }
        }
        for (const side of [fwd - 1, fwd + 1]) {
          const t = from + side;
          if (t & 0x88) continue;
          const target = sq[t]!;
          if (target && colorOf(target) === them) {
            if (rank === promoRank) {
              for (const pr of [QUEEN, ROOK, BISHOP, KNIGHT])
                moves.push(makeMove(from, t, pr, F_CAPTURE));
            } else {
              moves.push(makeMove(from, t, 0, F_CAPTURE));
            }
          } else if (t === this.ep) {
            moves.push(makeMove(from, t, 0, F_CAPTURE | F_EP));
          }
        }
        continue;
      }

      const steps =
        type === KNIGHT
          ? KNIGHT_STEPS
          : type === BISHOP
            ? BISHOP_STEPS
            : type === ROOK
              ? ROOK_STEPS
              : KING_STEPS; // queen and king share all eight directions
      const slides = type === BISHOP || type === ROOK || type === QUEEN;

      for (const d of steps) {
        for (let t = from + d; !(t & 0x88); t += d) {
          const target = sq[t]!;
          if (target) {
            if (colorOf(target) === them) moves.push(makeMove(from, t, 0, F_CAPTURE));
            break;
          }
          if (!capturesOnly) moves.push(makeMove(from, t));
          if (!slides) break;
        }
      }

      if (type === KING && !capturesOnly) {
        // Castling: rights held, squares between empty, king not passing through check.
        if (us === WHITE && from === 0x04) {
          if (this.castling & CASTLE_WK && !sq[0x05] && !sq[0x06] &&
              !this.attacked(0x04, them) && !this.attacked(0x05, them) && !this.attacked(0x06, them))
            moves.push(makeMove(0x04, 0x06, 0, F_CASTLE));
          if (this.castling & CASTLE_WQ && !sq[0x03] && !sq[0x02] && !sq[0x01] &&
              !this.attacked(0x04, them) && !this.attacked(0x03, them) && !this.attacked(0x02, them))
            moves.push(makeMove(0x04, 0x02, 0, F_CASTLE));
        } else if (us === BLACK && from === 0x74) {
          if (this.castling & CASTLE_BK && !sq[0x75] && !sq[0x76] &&
              !this.attacked(0x74, them) && !this.attacked(0x75, them) && !this.attacked(0x76, them))
            moves.push(makeMove(0x74, 0x76, 0, F_CASTLE));
          if (this.castling & CASTLE_BQ && !sq[0x73] && !sq[0x72] && !sq[0x71] &&
              !this.attacked(0x74, them) && !this.attacked(0x73, them) && !this.attacked(0x72, them))
            moves.push(makeMove(0x74, 0x72, 0, F_CASTLE));
        }
      }
    }
    return moves;
  }

  /** Fully legal moves. */
  legalMoves(): Move[] {
    const out: Move[] = [];
    for (const m of this.pseudoMoves()) {
      if (this.make(m)) {
        out.push(m);
        this.unmake();
      }
    }
    return out;
  }

  private put(s: number, p: number) {
    this.sq[s] = p;
    this.hash1 ^= zPiece1[p * 128 + s]!;
    this.hash2 ^= zPiece2[p * 128 + s]!;
  }

  private remove(s: number) {
    const p = this.sq[s]!;
    this.sq[s] = EMPTY;
    this.hash1 ^= zPiece1[p * 128 + s]!;
    this.hash2 ^= zPiece2[p * 128 + s]!;
  }

  /** Plays a pseudo-legal move. Returns false (and undoes it) if it leaves the king in check. */
  make(m: Move): boolean {
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    const promo = movePromo(m);
    const us = this.side;
    const piece = this.sq[from]!;

    const capSq = flags & F_EP ? to + (us === WHITE ? -16 : 16) : to;
    const captured = flags & F_CAPTURE ? this.sq[capSq]! : EMPTY;

    this.history.push({
      move: m,
      captured,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      hash1: this.hash1,
      hash2: this.hash2,
    });

    // Strip old castling/ep state from the hash before changing it.
    this.hash1 ^= zCastle1[this.castling]!;
    this.hash2 ^= zCastle2[this.castling]!;
    if (this.ep >= 0) {
      this.hash1 ^= zEp1[this.ep & 7]!;
      this.hash2 ^= zEp2[this.ep & 7]!;
    }

    if (captured) this.remove(capSq);
    this.remove(from);
    this.put(to, promo ? us | promo : piece);

    if (flags & F_CASTLE) {
      // King moved two squares; bring the rook across.
      if (to === from + 2) {
        const r = this.sq[from + 3]!;
        this.remove(from + 3);
        this.put(from + 1, r);
      } else {
        const r = this.sq[from - 4]!;
        this.remove(from - 4);
        this.put(from - 1, r);
      }
    }

    if (typeOf(piece) === KING) this.kings[us >> 3] = to;

    this.castling &= CASTLE_MASK[from]! & CASTLE_MASK[to]!;
    this.ep = flags & F_DOUBLE ? (from + to) >> 1 : -1;
    this.halfmove = typeOf(piece) === PAWN || captured ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;

    this.hash1 ^= zCastle1[this.castling]!;
    this.hash2 ^= zCastle2[this.castling]!;
    if (this.ep >= 0) {
      this.hash1 ^= zEp1[this.ep & 7]!;
      this.hash2 ^= zEp2[this.ep & 7]!;
    }
    this.hash1 ^= zSide1;
    this.hash2 ^= zSide2;
    this.hash1 >>>= 0;
    this.hash2 >>>= 0;
    this.side = us ^ 8;

    if (this.attacked(this.kings[us >> 3]!, this.side)) {
      this.unmake();
      return false;
    }
    return true;
  }

  unmake() {
    const u = this.history.pop()!;
    const m = u.move;
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    this.side ^= 8;
    const us = this.side;

    const moved = this.sq[to]!;
    const piece = movePromo(m) ? us | PAWN : moved;
    this.sq[to] = EMPTY;
    this.sq[from] = piece;

    if (u.captured) {
      const capSq = flags & F_EP ? to + (us === WHITE ? -16 : 16) : to;
      this.sq[capSq] = u.captured;
    }

    if (flags & F_CASTLE) {
      if (to === from + 2) {
        this.sq[from + 3] = this.sq[from + 1]!;
        this.sq[from + 1] = EMPTY;
      } else {
        this.sq[from - 4] = this.sq[from - 1]!;
        this.sq[from - 1] = EMPTY;
      }
    }

    if (typeOf(piece) === KING) this.kings[us >> 3] = from;
    if (us === BLACK) this.fullmove--;
    this.castling = u.castling;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.hash1 = u.hash1;
    this.hash2 = u.hash2;
  }

  /** Null move for null-move pruning: pass the turn without moving. */
  makeNull() {
    this.history.push({
      move: 0,
      captured: 0,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      hash1: this.hash1,
      hash2: this.hash2,
    });
    if (this.ep >= 0) {
      this.hash1 ^= zEp1[this.ep & 7]!;
      this.hash2 ^= zEp2[this.ep & 7]!;
    }
    this.ep = -1;
    this.hash1 = (this.hash1 ^ zSide1) >>> 0;
    this.hash2 = (this.hash2 ^ zSide2) >>> 0;
    this.side ^= 8;
    this.halfmove++;
  }

  unmakeNull() {
    const u = this.history.pop()!;
    this.side ^= 8;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.hash1 = u.hash1;
    this.hash2 = u.hash2;
  }

  /** Has this position occurred before since the last pawn move or capture? */
  isRepetition(times = 1): boolean {
    let seen = 0;
    const h = this.history;
    // Only same-side-to-move positions can match, so step back two plies at a time.
    for (let i = h.length - 2; i >= 0 && i >= h.length - this.halfmove - 1; i -= 2) {
      if (h[i]!.hash1 === this.hash1 && h[i]!.hash2 === this.hash2) {
        if (++seen >= times) return true;
      }
    }
    return false;
  }

  insufficientMaterial(): boolean {
    let minors = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const t = typeOf(this.sq[s]!);
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      if (t === KNIGHT || t === BISHOP) minors++;
    }
    return minors <= 1;
  }

  /** Parses a UCI string like "e2e4" or "e7e8q" against the legal moves. */
  parseUci(uci: string): Move | null {
    const from = sqFromName(uci.slice(0, 2));
    const to = sqFromName(uci.slice(2, 4));
    const promo = uci[4] ? " pnbrqk".indexOf(uci[4]) : 0;
    for (const m of this.legalMoves()) {
      if (moveFrom(m) === from && moveTo(m) === to && movePromo(m) === promo) return m;
    }
    return null;
  }

  /** Standard algebraic notation, e.g. "Nxf3+", "O-O", "e8=Q#". Call before making the move. */
  san(m: Move): string {
    const from = moveFrom(m);
    const to = moveTo(m);
    const flags = moveFlags(m);
    const type = typeOf(this.sq[from]!);
    let s: string;

    if (flags & F_CASTLE) {
      s = to > from ? "O-O" : "O-O-O";
    } else if (type === PAWN) {
      s = flags & F_CAPTURE ? sqName(from)[0] + "x" + sqName(to) : sqName(to);
      if (movePromo(m)) s += "=" + " PNBRQK"[movePromo(m)];
    } else {
      s = " PNBRQK"[type]!;
      // Disambiguate when another piece of the same type can reach `to`.
      const rivals = this.legalMoves().filter(
        (o) => o !== m && moveTo(o) === to && typeOf(this.sq[moveFrom(o)]!) === type,
      );
      if (rivals.length) {
        const sameFile = rivals.some((o) => (moveFrom(o) & 7) === (from & 7));
        const sameRank = rivals.some((o) => moveFrom(o) >> 4 === from >> 4);
        if (!sameFile) s += sqName(from)[0];
        else if (!sameRank) s += sqName(from)[1];
        else s += sqName(from);
      }
      if (flags & F_CAPTURE) s += "x";
      s += sqName(to);
    }

    this.make(m);
    if (this.inCheck()) s += this.legalMoves().length ? "+" : "#";
    this.unmake();
    return s;
  }
}

export const moveToUci = (m: Move) =>
  sqName(moveFrom(m)) + sqName(moveTo(m)) + (movePromo(m) ? " pnbrqk"[movePromo(m)] : "");
