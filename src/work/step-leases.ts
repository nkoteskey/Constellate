/**
 * Who is on a step right now, and when more help joins (docs/OPEN_PROBLEMS.md, "Stuck steps").
 *
 * An agent that asks work_step for something to do is handed one step and holds it. Nobody else is handed it
 * while it's fresh. If no answer has arrived after 5 minutes, a second agent joins; after 10, a third. Never more
 * than three: past that it is a hard step, not a slow one, and more copies of the same attempt don't help.
 * A hold nobody answered lapses after 30 minutes (laptops sleep), and the step starts over.
 *
 * Holds are advisory, like the board's claims: the first holder is also put on the board so lent computers and
 * other computers' agents see it; seats two and three open by time on every computer alike.
 */
export const JOIN_AFTER_MS = [0, 5 * 60_000, 10 * 60_000] as const;
export const MAX_ON_A_STEP = JOIN_AFTER_MS.length;
export const HOLD_LAPSES_MS = 30 * 60_000;

export interface Hold { by: string; at: number; answered?: boolean }
export interface Seat { seat: number; of: number; joined_because?: string }

const key = (problem: string, step: string) => `${problem}:${step}`;
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export class StepLeases {
  private holds = new Map<string, Hold[]>();
  constructor(private readonly clock: () => number = Date.now) {}

  private live(problem: string, step: string): Hold[] {
    const k = key(problem, step), now = this.clock();
    const hs = this.holds.get(k) ?? [];
    // The step starts over once its first hold lapsed with no answer.
    if (hs.length && !hs.some((h) => h.answered) && now - hs[0].at >= HOLD_LAPSES_MS) { this.holds.delete(k); return []; }
    return hs;
  }

  /** Everyone holding this step now, first first. */
  on(problem: string, step: string): Hold[] { return this.live(problem, step).map((h) => ({ ...h })); }

  /** How many may be on this step now: one at first, more the longer it goes without an answer. */
  seats(problem: string, step: string): number {
    const hs = this.live(problem, step);
    if (!hs.length) return 1;
    if (hs.some((h) => h.answered)) return hs.length; // answered: waiting for a check, nobody new needed
    const waited = this.clock() - hs[0].at;
    return JOIN_AFTER_MS.filter((t) => waited >= t).length;
  }

  holding(problem: string, step: string, by: string) { return this.live(problem, step).some((h) => h.by === by); }

  /** Whether `by` could be handed this step now (it already holds it, or a seat is free). */
  canTake(problem: string, step: string, by: string): boolean {
    return this.holding(problem, step, by) || this.live(problem, step).length < this.seats(problem, step);
  }

  /** Hand `by` this step. Returns its seat, or null when the step is full right now. `since`: a hold first seen elsewhere (the board). */
  take(problem: string, step: string, by: string, since?: number): Seat | null {
    const hs = this.live(problem, step);
    const mine = hs.findIndex((h) => h.by === by);
    if (mine >= 0) return { seat: mine + 1, of: this.seats(problem, step) };
    if (hs.length >= this.seats(problem, step)) return null;
    const now = this.clock();
    const next = [...hs, { by, at: since ?? now }];
    this.holds.set(key(problem, step), next);
    const seat = next.length;
    return seat === 1 ? { seat, of: this.seats(problem, step) } : { seat, of: this.seats(problem, step), joined_because: `no answer for ${minutes(now - hs[0].at)} minutes, so you’re joining as agent ${seat} of at most ${MAX_ON_A_STEP}` };
  }

  /** Someone else (another computer, on the board) holds it; the hold runs from when it was first seen here. */
  seen(problem: string, step: string, by: string) { if (!this.live(problem, step).length) this.take(problem, step, by); }

  /** `by` answered: it no longer holds the step for a new answer, and nobody new joins. */
  answered(problem: string, step: string, by: string) {
    const hs = this.live(problem, step);
    const h = hs.find((x) => x.by === by);
    if (h) h.answered = true; else this.holds.set(key(problem, step), [...hs, { by, at: this.clock(), answered: true }]);
  }

  /** The step that `by` holds and hasn't answered yet, if any. */
  heldBy(by: string): { problem: string; step: string } | null {
    for (const [k, hs] of this.holds) {
      const [problem, step] = k.split(':');
      if (this.live(problem, step).some((h) => h.by === by && !h.answered)) return { problem, step };
    }
    return null;
  }

  /** Verified or done: forget it. */
  clear(problem: string, step: string) { this.holds.delete(key(problem, step)); }
}
