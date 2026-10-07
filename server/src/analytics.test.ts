import { describe, expect, it } from "vitest";
import {
  alignCloses,
  ma200State,
  maxSharpeWeights,
  portfolioReturns,
  returnsFromCloses,
  sharpe,
} from "./analytics.js";

// deterministic pseudo-noise so tests don't flake
const noise = (i: number) => Math.sin(i * 12.9898) * 0.01;

describe("sharpe", () => {
  it("matches a hand-computed value", () => {
    const rets = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.02 : 0.0));
    // mean 0.01, sd 0.01, rf 0 -> 1 * sqrt(252)
    expect(sharpe(rets, 0)).toBeCloseTo(Math.sqrt(252), 6);
  });
  it("is null for a flat series and for too little data", () => {
    expect(sharpe(new Array(50).fill(0.001), 0)).toBeNull();
    expect(sharpe([0.01, 0.02], 0)).toBeNull();
  });
});

describe("ma200State", () => {
  const flat = new Array(250).fill(100);
  it("returns nulls with under 200 bars", () => {
    expect(ma200State(flat.slice(0, 150)).ma200).toBeNull();
  });
  it("detects an up-cross on the latest bar", () => {
    const s = ma200State([...flat, 90, 120].slice(-251));
    expect(s.side).toBe("above");
    expect(s.crossed).toBe("up");
  });
  it("detects a drop through the MA on the latest bar", () => {
    const s = ma200State([...flat, 110, 80].slice(-251));
    expect(s.side).toBe("below");
    expect(s.crossed).toBe("down");
  });
  it("reports no cross when price stays on one side", () => {
    expect(ma200State([...flat, 110, 120]).crossed).toBeNull();
  });
});

describe("alignCloses", () => {
  it("keeps only shared days", () => {
    const day = 86400;
    const out = alignCloses({
      A: [{ time: 0, close: 1 }, { time: day, close: 2 }, { time: 2 * day, close: 3 }],
      B: [{ time: day, close: 5 }, { time: 2 * day, close: 6 }],
    });
    expect(out).toEqual({ A: [2, 3], B: [5, 6] });
  });
});

describe("maxSharpeWeights", () => {
  const mk = (drift: number, seed: number) =>
    Array.from({ length: 250 }, (_, t) => drift + noise(t * 7 + seed) * (1 + seed * 0.1));
  const rets = [mk(0.0012, 1), mk(0.0004, 2), mk(0.0008, 3)];

  it("returns long-only weights that sum to 1 and respect the cap", () => {
    const { weights } = maxSharpeWeights(rets, [1 / 3, 1 / 3, 1 / 3], 0.04, 0.5);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    for (const w of weights) {
      expect(w).toBeGreaterThanOrEqual(-1e-9);
      expect(w).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
  it("does not do worse than the starting weights", () => {
    const start = [0.1, 0.8, 0.1];
    const best = maxSharpeWeights(rets, start, 0.04, 1);
    const sStart = sharpe(portfolioReturns(rets, start), 0.04)!;
    const sBest = sharpe(portfolioReturns(rets, best.weights), 0.04)!;
    expect(sBest).toBeGreaterThanOrEqual(sStart - 0.05); // shrunk means: allow small slack
  });
  it("still works when the cap is infeasible for 2 assets", () => {
    const { weights } = maxSharpeWeights(rets.slice(0, 2), [0.5, 0.5], 0.04, 0.1);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe("returnsFromCloses", () => {
  it("computes simple returns", () => {
    expect(returnsFromCloses([100, 110, 99])).toEqual([0.10000000000000009, -0.09999999999999998]);
  });
});
