import type { WitnessVerifier } from './witness.js';
import { answerText, parseDimacs, MAX_CNF_CHARS } from './combinatorics.js';

/**
 * Proofs that nothing exists (#31, docs/OPEN_PROBLEMS.md): a formula has no satisfying assignment, shown by a DRAT
 * proof, the format SAT solvers emit (cadical, kissat: `--proof`). Each line adds a clause (literals ending in 0) or
 * deletes one ("d …"); every added clause must follow from the clauses so far by unit propagation (RUP), or be a
 * resolution asymmetric tautology on its first literal (RAT). The proof is done when the empty clause is added.
 *
 * Checked forward, line by line, with a fixed step budget so every computer gives the same verdict. This checker is
 * for small proofs (up to MAX_PROOF_CHARS). Large ones need a formally verified checker such as cake_lpr on computers
 * that opted in, with the work shared out (docs/DISTRIBUTED_LEAN.md describes the same pattern for Lean).
 */
export const MAX_PROOF_CHARS = 400_000;
export const DRAT_BUDGET = 20_000_000;

export interface DratLine { del: boolean; lits: number[] }

export function parseDrat(text: string): DratLine[] | { error: string } {
  const out: DratLine[] = [];
  let cur: number[] = [], del = false, started = false;
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (tok === 'd') { if (started) return { error: '"d" must start a line' }; del = true; continue; }
    if (!/^-?\d+$/.test(tok)) return { error: `"${tok.slice(0, 12)}" is not a literal` };
    const l = Number(tok);
    if (l === 0) { out.push({ del, lits: cur }); cur = []; del = false; started = false; continue; }
    cur.push(l); started = true;
  }
  if (cur.length || del) return { error: 'the last proof line does not end in 0' };
  return out;
}

const key = (c: number[]) => [...c].sort((a, b) => a - b).join(' ');

/**
 * Forward DRAT check. Unit propagation over occurrence lists; `budget` counts clause visits.
 * Returns null when the proof derives the empty clause, or why it doesn't.
 */
export function checkDrat(clauses: number[][], proof: DratLine[], budget = DRAT_BUDGET): string | null {
  let steps = 0;
  const db: (number[] | null)[] = [];
  const byKey = new Map<string, number[]>();
  const occ = new Map<number, Set<number>>();
  const add = (c: number[]) => { const id = db.length; db.push(c); (byKey.get(key(c)) ?? byKey.set(key(c), []).get(key(c))!).push(id); for (const l of c) (occ.get(l) ?? occ.set(l, new Set()).get(l)!).add(id); };
  const remove = (c: number[]) => { const ids = byKey.get(key(c)); const id = ids?.pop(); if (id === undefined) return false; for (const l of db[id]!) occ.get(l)!.delete(id); db[id] = null; return true; };
  for (const c of clauses) add(c);

  /** Does assuming every literal in `assume` lead to a conflict by unit propagation? */
  const conflicts = (assume: number[]): boolean | null => {
    const val = new Map<number, boolean>();
    const queue: number[] = [];
    const set = (l: number) => { const v = Math.abs(l), want = l > 0; if (val.has(v)) return val.get(v) === want; val.set(v, want); queue.push(l); return true; };
    for (const l of assume) if (!set(l)) return true;
    // Units already in the database start the propagation too.
    for (const c of db) if (c && c.length === 1 && !set(c[0])) return true;
    for (let q = 0; q < queue.length; q++) {
      for (const id of occ.get(-queue[q]) ?? []) { // clauses this assignment made false somewhere
        if (++steps > budget) return null;
        const c = db[id]!;
        let unassigned = 0, last = 0, sat = false;
        for (const l of c) { const v = val.get(Math.abs(l)); if (v === undefined) { unassigned++; last = l; } else if (v === l > 0) { sat = true; break; } }
        if (sat) continue;
        if (!unassigned) return true;
        if (unassigned === 1 && !set(last)) return true;
      }
    }
    return false;
  };

  for (const [i, line] of proof.entries()) {
    if (line.del) { remove(line.lits); continue; } // deleting a clause that isn't there is ignored, as drat-trim does
    const rup = conflicts(line.lits.map((l) => -l));
    if (rup === null) return 'too large to check within the fixed budget';
    if (!rup) {
      // RAT on the first literal: every clause with its negation must give a RUP resolvent.
      const p = line.lits[0];
      if (p === undefined) return `line ${i + 1}: the empty clause doesn't follow yet`;
      for (const id of [...(occ.get(-p) ?? [])]) {
        const r = [...new Set([...line.lits, ...db[id]!.filter((l) => l !== -p)])];
        if (r.some((l) => r.includes(-l))) continue; // a tautology is fine
        const ok = conflicts(r.map((l) => -l));
        if (ok === null) return 'too large to check within the fixed budget';
        if (!ok) return `line ${i + 1} (${line.lits.join(' ')} 0) is neither RUP nor RAT`;
      }
    }
    if (!line.lits.length) return null; // the empty clause: proven
    add(line.lits);
  }
  return 'the proof never derives the empty clause';
}

/** A formula with no satisfying assignment: the DIMACS CNF in the step's check, and a DRAT proof as the answer. */
export const unsatDratVerifier: WitnessVerifier = {
  name: 'unsat_drat', machineOnly: true, witness: true,
  shape: `check {"cnf": DIMACS text up to ${MAX_CNF_CHARS} characters}; answer: a DRAT proof (lines of literals ending in 0, deletions as "d … 0", up to ${MAX_PROOF_CHARS} characters) deriving the empty clause`,
  async check(spec, output) {
    const cnf = typeof spec.cnf === 'string' ? parseDimacs(spec.cnf) : { error: 'the check needs "cnf": DIMACS text' };
    if ('error' in cnf) return { ok: false, detail: cnf.error };
    const text = answerText(output, MAX_PROOF_CHARS);
    if (text === null) return { ok: false, detail: `proofs up to ${MAX_PROOF_CHARS} characters are checked here; larger ones need a verified checker` };
    const proof = parseDrat(text);
    if ('error' in proof) return { ok: false, detail: proof.error };
    if (proof.some((l) => l.lits.some((x) => Math.abs(x) > cnf.vars))) return { ok: false, detail: `a literal is outside 1..${cnf.vars}` };
    const why = checkDrat(cnf.clauses, proof);
    return why ? { ok: false, detail: why } : { ok: true, detail: `${proof.length} proof lines derive the empty clause: no assignment satisfies all ${cnf.clauses.length} clauses, recomputed` };
  },
};
