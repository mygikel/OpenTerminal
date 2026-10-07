import { Router } from "express";
import { cached } from "../cache.js";
import { mapWithConcurrency } from "../concurrency.js";
import * as fred from "../providers/fred.js";
import { ma200State, returnsFromCloses, sharpe, type Bar } from "../analytics.js";
import { getHistory } from "./market.js";

export const riskRouter = Router();

const SYMBOL_RE = /^[A-Z0-9.^-]{1,12}$/;
const MAX_SYMBOLS = 30;

/** 3-month T-bill from FRED as a decimal; 4% if FRED is unreachable. */
export function riskFree(): Promise<number> {
  return cached("risk:rf", 3_600_000, async () => {
    try {
      const p = await fred.latest("DGS3MO");
      return p ? p.value / 100 : 0.04;
    } catch {
      return 0.04;
    }
  });
}

/** ~1 trading year of daily bars (stooq returns its whole history, so trim). */
export async function yearBars(symbol: string): Promise<Bar[]> {
  const bars = await getHistory(symbol, "1Y");
  return bars.slice(-253).map((b) => ({ time: b.time, close: b.close }));
}

riskRouter.get("/risk", async (req, res) => {
  const symbols = [...new Set(String(req.query.symbols ?? "").toUpperCase().split(",").filter(Boolean))];
  if (symbols.length === 0 || symbols.length > MAX_SYMBOLS || !symbols.every((s) => SYMBOL_RE.test(s))) {
    return res.status(400).json({ error: `symbols: 1-${MAX_SYMBOLS} comma-separated tickers` });
  }
  const rf = await riskFree();
  const rows = await mapWithConcurrency(symbols, 4, async (symbol) => {
    try {
      const closes = (await yearBars(symbol)).map((b) => b.close);
      return {
        symbol,
        price: closes[closes.length - 1],
        sharpe: sharpe(returnsFromCloses(closes), rf),
        ...ma200State(closes),
      };
    } catch (err) {
      console.error("[risk]", symbol, err instanceof Error ? err.message : err);
      return { symbol, error: "no data" };
    }
  });
  res.json({ riskFree: rf, rows });
});
