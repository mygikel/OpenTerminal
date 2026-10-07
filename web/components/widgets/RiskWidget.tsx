"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, fmt, pctClass } from "../../lib/api";
import { useTerminal } from "../../store/terminal";

type RiskRow = {
  symbol: string;
  price?: number;
  sharpe?: number | null;
  ma200?: number | null;
  pctVsMa?: number | null;
  side?: "above" | "below" | null;
  crossed?: "up" | "down" | null;
  error?: string;
};
type TickerRisk = { riskFree: number; rows: RiskRow[] };
type Portfolio = { id: number; name: string };
type PortfolioRisk =
  | { message: string; skipped?: string[] }
  | {
      riskFree: number;
      cap: number;
      skipped: string[];
      totalValue: number;
      currentSharpe: number | null;
      targetSharpe: number | null;
      rows: Array<{ symbol: string; price: number; currentWeight: number; targetWeight: number; tradeShares: number }>;
    };
type Alert = { id: string; symbol: string; dir: "up" | "down"; at: string };

const SIDES_KEY = "openterminal:risk-sides";

function readSides(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SIDES_KEY) ?? "{}");
  } catch {
    return {};
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function RiskWidget() {
  const watchlist = useTerminal((s) => s.watchlist);
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [portfolioId, setPortfolioId] = useState<number | null>(null);
  const [cap, setCap] = useState(40);

  const { data: tickers, isFetching } = useQuery({
    queryKey: ["risk", watchlist.join(",")],
    queryFn: () => apiGet<TickerRisk>(`/api/risk?symbols=${watchlist.join(",")}`),
    enabled: watchlist.length > 0,
    refetchInterval: 60_000,
  });

  const { data: portfolios = [] } = useQuery({
    queryKey: ["portfolios"],
    queryFn: () => apiGet<Portfolio[]>("/api/portfolios"),
  });
  const pid = portfolioId ?? portfolios[0]?.id;
  const { data: pf, isFetching: pfLoading } = useQuery({
    queryKey: ["portfolio-risk", pid, cap],
    queryFn: () => apiGet<PortfolioRisk>(`/api/portfolios/${pid}/risk?cap=${cap / 100}`),
    enabled: !!pid,
    refetchInterval: 300_000,
  });

  // Alert when a ticker's side of its 200MA differs from the last side we saw.
  // First sighting only alerts if the server says it crossed on the latest bar.
  useEffect(() => {
    if (!tickers) return;
    const sides = readSides();
    const fresh: Alert[] = [];
    for (const r of tickers.rows) {
      if (!r.side) continue;
      const prev = sides[r.symbol];
      const dir = prev ? (prev !== r.side ? (r.side === "above" ? "up" : "down") : null) : r.crossed ?? null;
      if (dir) fresh.push({ id: `${r.symbol}:${Date.now()}`, symbol: r.symbol, dir, at: new Date().toLocaleTimeString() });
      sides[r.symbol] = r.side;
    }
    try {
      localStorage.setItem(SIDES_KEY, JSON.stringify(sides));
    } catch {}
    if (fresh.length === 0) return;
    setAlerts((a) => [...fresh, ...a].slice(0, 8));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      for (const f of fresh) new Notification(`${f.symbol} ${f.dir === "up" ? "crossed above" : "dropped below"} its 200-day MA`);
    }
  }, [tickers]);

  const askNotify = typeof Notification !== "undefined" && Notification.permission === "default";

  return (
    <div className="text-xs">
      {(alerts.length > 0 || askNotify) && (
        <div className="p-1 border-b border-[var(--border)]">
          {askNotify && (
            <button className="term-btn" onClick={() => Notification.requestPermission().then(() => setAlerts((a) => [...a]))}>
              ENABLE DESKTOP ALERTS
            </button>
          )}
          {alerts.map((a) => (
            <div key={a.id} className={a.dir === "up" ? "up" : "down"}>
              ▲▼ {a.at} {a.symbol} {a.dir === "up" ? "crossed above" : "dropped below"} 200MA
              <button className="dim ml-2" onClick={() => setAlerts((x) => x.filter((y) => y.id !== a.id))}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="dim px-1 pt-1 uppercase text-[10px]">
        Watchlist · 1Y Sharpe (rf {tickers ? pct(tickers.riskFree) : "…"}) {isFetching && "· updating"}
      </div>
      <table className="data-table">
        <thead>
          <tr><th>Sym</th><th>Sharpe</th><th>Last</th><th>200MA</th><th>vs MA</th><th></th></tr>
        </thead>
        <tbody>
          {(tickers?.rows ?? []).map((r) => (
            <tr key={r.symbol} onClick={() => setActiveSymbol(r.symbol)} className={r.crossed ? "amber" : ""}>
              <td className="font-bold">{r.symbol}</td>
              {r.error ? (
                <td colSpan={5} className="dim">{r.error}</td>
              ) : (
                <>
                  <td className={pctClass(r.sharpe)}>{r.sharpe == null ? "—" : fmt(r.sharpe)}</td>
                  <td>{fmt(r.price)}</td>
                  <td>{r.ma200 == null ? "—" : fmt(r.ma200)}</td>
                  <td className={pctClass(r.pctVsMa)}>{r.pctVsMa == null ? "—" : `${fmt(r.pctVsMa)}%`}</td>
                  <td>{r.crossed === "up" ? "▲ CROSS" : r.crossed === "down" ? "▼ DROP" : ""}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex gap-2 items-center p-1 border-t border-[var(--border)] mt-1 flex-wrap">
        <span className="dim uppercase text-[10px]">Portfolio</span>
        <select value={pid ?? ""} onChange={(e) => setPortfolioId(Number(e.target.value))}>
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="dim">
          Max/position{" "}
          <input className="w-16" type="number" min={5} max={100} value={cap} onChange={(e) => setCap(Math.min(100, Math.max(5, Number(e.target.value) || 40)))} />%
        </label>
        {pfLoading && <span className="dim">updating</span>}
      </div>

      {pf && "message" in pf && <div className="dim p-1">{pf.message}</div>}
      {pf && "rows" in pf && (
        <>
          <div className="p-1">
            Sharpe <span className="amber">{fmt(pf.currentSharpe)}</span> → target{" "}
            <span className="up">{fmt(pf.targetSharpe)}</span>
            {pf.skipped.length > 0 && <span className="dim"> · skipped {pf.skipped.join(", ")}</span>}
          </div>
          <table className="data-table">
            <thead>
              <tr><th>Sym</th><th>Now</th><th>Target</th><th>Trade (sh)</th></tr>
            </thead>
            <tbody>
              {pf.rows.map((r) => (
                <tr key={r.symbol}>
                  <td className="font-bold">{r.symbol}</td>
                  <td>{pct(r.currentWeight)}</td>
                  <td>{pct(r.targetWeight)}</td>
                  <td className={pctClass(r.tradeShares)}>
                    {r.tradeShares > 0 ? "BUY " : r.tradeShares < 0 ? "SELL " : ""}
                    {fmt(Math.abs(r.tradeShares))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dim p-1 text-[10px]">
            In-sample on ~1y of daily history, long-only, expected returns shrunk 50% toward the average. A
            starting point, not a forecast or advice.
          </div>
        </>
      )}
    </div>
  );
}
