export type Bar = { time: number; close: number };

const TRADING_DAYS = 252;

export function returnsFromCloses(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Annualised Sharpe from daily returns; null when there is no volatility or too little data. */
export function sharpe(rets: number[], riskFree = 0.04): number | null {
  if (rets.length < 20) return null;
  const m = mean(rets);
  const sd = Math.sqrt(mean(rets.map((r) => (r - m) ** 2)));
  if (sd < 1e-9) return null; // flat series: float noise, not real volatility
  return ((m - riskFree / TRADING_DAYS) / sd) * Math.sqrt(TRADING_DAYS);
}

export type MaState = {
  ma200: number | null;
  pctVsMa: number | null;
  side: "above" | "below" | null;
  /** price moved through the MA on the latest bar */
  crossed: "up" | "down" | null;
};

export function ma200State(closes: number[]): MaState {
  const n = closes.length;
  if (n < 200) return { ma200: null, pctVsMa: null, side: null, crossed: null };
  const ma = mean(closes.slice(-200));
  const last = closes[n - 1];
  const side = last >= ma ? "above" : "below";
  let crossed: MaState["crossed"] = null;
  if (n >= 201) {
    const prevSide = closes[n - 2] >= mean(closes.slice(-201, -1)) ? "above" : "below";
    if (prevSide !== side) crossed = side === "above" ? "up" : "down";
  }
  return { ma200: ma, pctVsMa: (last / ma - 1) * 100, side, crossed };
}

/** Keep only days present in every series (crypto trades weekends, equities don't). */
export function alignCloses(series: Record<string, Bar[]>): Record<string, number[]> {
  const byDay = Object.entries(series).map(
    ([sym, bars]) => [sym, new Map(bars.map((b) => [Math.floor(b.time / 86400), b.close]))] as const
  );
  if (byDay.length === 0) return {};
  const days = [...byDay[0][1].keys()].filter((d) => byDay.every(([, m]) => m.has(d))).sort((a, b) => a - b);
  return Object.fromEntries(byDay.map(([sym, m]) => [sym, days.map((d) => m.get(d)!)]));
}

export function portfolioReturns(rets: number[][], weights: number[]): number[] {
  const len = rets[0]?.length ?? 0;
  return Array.from({ length: len }, (_, t) => rets.reduce((s, r, i) => s + r[t] * weights[i], 0));
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clip weights to `cap`, spreading the excess over the uncapped ones, until stable. */
function capWeights(w: number[], cap: number): number[] {
  let out = w.map((x) => x / w.reduce((a, b) => a + b, 0));
  for (let k = 0; k < out.length; k++) {
    const excess = out.reduce((s, x) => s + Math.max(0, x - cap), 0);
    if (excess < 1e-12) break;
    const free = out.filter((x) => x < cap).reduce((a, b) => a + b, 0);
    out = out.map((x) => (x >= cap ? cap : x + (excess * x) / free));
  }
  return out;
}

export type Optimised = { weights: number[]; sharpe: number };

/**
 * Long-only max-Sharpe weights, each capped at `cap`.
 * Means are shrunk halfway to the cross-asset average: raw sample means make
 * max-Sharpe pile into last year's winner, and the result is in-sample either way.
 */
export function maxSharpeWeights(rets: number[][], start: number[], riskFree = 0.04, cap = 0.4): Optimised {
  const n = rets.length;
  const c = Math.max(cap, 1 / n + 1e-9);
  const mu = rets.map((r) => mean(r));
  const grand = mean(mu);
  const mus = mu.map((m) => 0.5 * m + 0.5 * grand);
  const cov = rets.map((a, i) =>
    rets.map((b, j) => mean(a.map((x, t) => (x - mu[i]) * (b[t] - mu[j]))))
  );
  const rfd = riskFree / TRADING_DAYS;
  const score = (w: number[]) => {
    const ret = w.reduce((s, x, i) => s + x * mus[i], 0) - rfd;
    const v = w.reduce((s, x, i) => s + x * w.reduce((t, y, j) => t + y * cov[i][j], 0), 0);
    return v > 0 ? (ret / Math.sqrt(v)) * Math.sqrt(TRADING_DAYS) : -Infinity;
  };

  const rnd = mulberry32(42);
  let best = capWeights(start, c);
  let bestScore = score(best);
  for (let k = 0; k < 2000; k++) {
    const w = capWeights(Array.from({ length: n }, () => -Math.log(1 - rnd())), c);
    const s = score(w);
    if (s > bestScore) [best, bestScore] = [w, s];
  }
  // ponytail: pairwise hill-climb from the best random draw; fine for ~30 assets, use a QP solver beyond that
  for (let step = 0.05; step >= 0.002; step /= 2) {
    for (let improved = true; improved; ) {
      improved = false;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          if (i === j || best[i] < step || best[j] + step > c + 1e-12) continue;
          const w = [...best];
          w[i] -= step;
          w[j] += step;
          const s = score(w);
          if (s > bestScore + 1e-12) [best, bestScore, improved] = [w, s, true];
        }
    }
  }
  return { weights: best, sharpe: bestScore };
}
