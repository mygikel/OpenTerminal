import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { mapWithConcurrency } from "../concurrency.js";
import {
  alignCloses,
  expectedSharpe,
  maxSharpeWeights,
  portfolioReturns,
  returnsFromCloses,
  sharpe,
} from "../analytics.js";
import { riskFree, yearBars } from "./risk.js";

export const portfolioRouter = Router();

portfolioRouter.get("/", (_req, res) => {
  res.json(db.prepare("SELECT * FROM portfolios ORDER BY id").all());
});

portfolioRouter.post("/", (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    const info = db.prepare("INSERT INTO portfolios (name) VALUES (?)").run(parsed.data.name);
    res.status(201).json({ id: info.lastInsertRowid, name: parsed.data.name });
  } catch {
    res.status(409).json({ error: "portfolio name already exists" });
  }
});

portfolioRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM transactions WHERE portfolio_id = ?").run(req.params.id);
  db.prepare("DELETE FROM portfolios WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

const txSchema = z.object({
  symbol: z.string().min(1).max(12).transform((s) => s.toUpperCase()),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().positive(),
  price: z.number().nonnegative(),
  executed_at: z.string(),
});

portfolioRouter.get("/:id/transactions", (req, res) => {
  res.json(
    db
      .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at DESC, id DESC")
      .all(req.params.id)
  );
});

portfolioRouter.post("/:id/transactions", (req, res) => {
  const parsed = txSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const t = parsed.data;
  try {
    const info = db
      .prepare(
        "INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(req.params.id, t.symbol, t.side, t.quantity, t.price, t.executed_at);
    res.status(201).json({ id: info.lastInsertRowid, ...t });
  } catch {
    res.status(404).json({ error: "portfolio not found" });
  }
});

portfolioRouter.delete("/:id/transactions/:txId", (req, res) => {
  db.prepare("DELETE FROM transactions WHERE id = ? AND portfolio_id = ?").run(req.params.txId, req.params.id);
  res.status(204).end();
});

type Position = { symbol: string; quantity: number; avgCost: number; realizedPnl: number };

/** Aggregated positions with average cost and realized PnL (FIFO-free, average-cost method). */
function positionsFor(portfolioId: string): Position[] {
  const txs = db
    .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at, id")
    .all(portfolioId) as Array<{ symbol: string; side: string; quantity: number; price: number }>;

  const positions = new Map<string, { qty: number; avgCost: number; realizedPnl: number }>();
  for (const tx of txs) {
    let p = positions.get(tx.symbol);
    if (!p) {
      p = { qty: 0, avgCost: 0, realizedPnl: 0 };
      positions.set(tx.symbol, p);
    }
    if (tx.side === "BUY") {
      const totalCost = p.avgCost * p.qty + tx.price * tx.quantity;
      p.qty += tx.quantity;
      p.avgCost = p.qty > 0 ? totalCost / p.qty : 0;
    } else {
      const sold = Math.min(tx.quantity, p.qty);
      p.realizedPnl += (tx.price - p.avgCost) * sold;
      p.qty -= sold;
      if (p.qty === 0) p.avgCost = 0;
    }
  }
  return [...positions.entries()]
    .filter(([, p]) => p.qty > 0 || p.realizedPnl !== 0)
    .map(([symbol, p]) => ({ symbol, quantity: p.qty, avgCost: p.avgCost, realizedPnl: p.realizedPnl }));
}

portfolioRouter.get("/:id/positions", (req, res) => {
  res.json(positionsFor(req.params.id));
});

/**
 * Current portfolio Sharpe (weights = current market value) and a max-Sharpe
 * rebalance suggestion. In-sample on ~1y of history: a starting point, not a forecast.
 */
portfolioRouter.get("/:id/risk", async (req, res) => {
  const open = positionsFor(req.params.id).filter((p) => p.quantity > 0);
  if (open.length < 2) return res.json({ message: "Need at least 2 open positions to rebalance." });
  const cap = Math.min(1, Math.max(0.05, Number(req.query.cap ?? 0.4) || 0.4));
  const shrinkRaw = Number(req.query.shrink ?? 0.5);
  const shrink = Number.isFinite(shrinkRaw) ? Math.min(1, Math.max(0, shrinkRaw)) : 0.5;

  const rf = await riskFree();
  const fetched = await mapWithConcurrency(open, 4, async (p) => {
    try {
      return { p, bars: await yearBars(p.symbol) };
    } catch {
      return null;
    }
  });
  const ok = fetched.filter((x): x is NonNullable<typeof x> => x !== null);
  const skipped = open.filter((p) => !ok.some((x) => x.p.symbol === p.symbol)).map((p) => p.symbol);
  if (ok.length < 2) return res.json({ message: "Not enough price history to analyse.", skipped });

  const aligned = alignCloses(Object.fromEntries(ok.map((x) => [x.p.symbol, x.bars])));
  const rets = ok.map((x) => returnsFromCloses(aligned[x.p.symbol]));
  if (rets[0].length < 60) return res.json({ message: "Under 60 shared trading days of history.", skipped });

  const price = ok.map((x) => x.bars[x.bars.length - 1].close);
  const value = ok.map((x, i) => x.p.quantity * price[i]);
  const total = value.reduce((a, b) => a + b, 0);
  const current = value.map((v) => v / total);
  const target = maxSharpeWeights(rets, current, rf, cap, shrink).weights;

  res.json({
    riskFree: rf,
    cap,
    shrink,
    skipped,
    totalValue: total,
    // plain one-year history of the current weights
    historicalSharpe: sharpe(portfolioReturns(rets, current), rf),
    // same shrunk-return basis for both, so target >= current
    currentSharpe: expectedSharpe(rets, current, rf, shrink),
    targetSharpe: expectedSharpe(rets, target, rf, shrink),
    rows: ok.map((x, i) => ({
      symbol: x.p.symbol,
      price: price[i],
      currentWeight: current[i],
      targetWeight: target[i],
      // positive = buy
      tradeShares: Math.round(((target[i] * total - value[i]) / price[i]) * 100) / 100,
    })),
  });
});
