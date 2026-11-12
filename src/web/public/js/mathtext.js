// Catalogue statements carry TeX between $…$ ("Let $\tau(n)$ count…"). This turns the common commands into plain
// Unicode so a card reads as maths, not markup. Display only: what gets proposed keeps the TeX, which agents read fine.
import { esc } from './ui.js';

const SYM = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼', equiv: '≡', ll: '≪', gg: '≫',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅',
  infty: '∞', to: '→', rightarrow: '→', mapsto: '↦', Rightarrow: '⇒', iff: '⇔', times: '×', cdot: '·', pm: '±',
  ldots: '…', cdots: '⋯', dots: '…', sum: 'Σ', prod: 'Π', sqrt: '√', partial: '∂', forall: '∀', exists: '∃',
  lvert: '|', rvert: '|', vert: '|', mid: '|', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', langle: '⟨', rangle: '⟩',
  log: 'log', ln: 'ln', exp: 'exp', max: 'max', min: 'min', sup: 'sup', inf: 'inf', lim: 'lim', gcd: 'gcd', deg: 'deg',
};
const BB = { N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ', P: 'ℙ', F: '𝔽' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ', i: 'ⁱ', k: 'ᵏ', '+': '⁺', '-': '⁻' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', n: 'ₙ', '+': '₊', '-': '₋' };
const script = (s, map, mark) => ([...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join('') : `${mark}${s.length > 1 ? `(${s})` : s}`);

/** One maths span, TeX → plain Unicode. Anything it does not know is left as written. */
export function texToText(t) {
  let s = t;
  for (let i = 0; i < 3; i++) { // nested braces: innermost first
    s = s.replace(/\\(?:mathbb|mathbf)\{([A-Z])\}/g, (m, c) => BB[c] ?? c)
      .replace(/\\(?:text|textrm|mathrm|operatorname|mathit|mathcal|mathbf|emph)\{([^{}]*)\}/g, '$1')
      .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (m, a, b) => `${/^\w+$/.test(a) ? a : `(${a})`}/${/^\w+$/.test(b) ? b : `(${b})`}`)
      .replace(/\\binom\{([^{}]*)\}\{([^{}]*)\}/g, 'C($1, $2)');
  }
  return s
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b\s*/g, '')
    .replace(/\\[,;:!]|~/g, ' ')
    .replace(/\\([{}|#%&_$])/g, '$1')
    .replace(/\\(lvert|langle|lfloor|lceil)\s*/g, (m, w) => SYM[w]) // an opening bracket takes no space after it
    .replace(/\\([A-Za-z]+)/g, (m, w) => SYM[w] ?? m)
    .replace(/\^\{([^{}]*)\}|\^(\w)/g, (m, a, b) => script(a ?? b, SUP, '^'))
    .replace(/_\{([^{}]*)\}|_(\w)/g, (m, a, b) => script(a ?? b, SUB, '_'))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escaped HTML for a statement: prose as is, each $…$ or $$…$$ span rendered as plain maths in italics. */
export function mathHtml(text) {
  return String(text).split(/(\$\$[^$]+\$\$|\$[^$]+\$)/).map((part) => {
    const m = part.match(/^\$\$?([^$]+)\$\$?$/);
    return m ? `<span class="math">${esc(texToText(m[1]))}</span>` : esc(part);
  }).join('');
}
