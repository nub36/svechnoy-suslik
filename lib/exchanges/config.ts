/**
 * ExchangeConfig — управление публичными биржами
 * BINANCE default true priority 100, fallback по priority
 */

export type ExchangeName = "BINANCE" | "BYBIT" | "GATE" | "KUCOIN" | "BINGX";

export const EXCHANGE_LIST: ExchangeName[] = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];

export const EXCHANGE_PRIORITY: Record<ExchangeName, number> = {
  BINANCE: 100,
  BYBIT: 90,
  GATE: 80,
  KUCOIN: 70,
  BINGX: 60,
};

export type ExchangeConfigRow = {
  id: number;
  exchange: string;
  publicEnabled: boolean;
  ohlcvEnabled: boolean;
  liveEnabled: boolean;
  isDefault: boolean;
  priority: number;
};

export const DEFAULT_EXCHANGE_CONFIGS: ExchangeConfigRow[] = EXCHANGE_LIST.map((ex, idx) => ({
  id: idx + 1,
  exchange: ex,
  publicEnabled: true,
  // PUBLIC Top-50 ingestion scans ONLY BINANCE by default (ohlcvEnabled=true)
  // BTC dedicated worker does NOT use ExchangeConfig filtering, keeps 5 markets
  ohlcvEnabled: ex === "BINANCE",
  liveEnabled: true,
  isDefault: ex === "BINANCE",
  priority: EXCHANGE_PRIORITY[ex],
}));

export function getDefaultExchange(configs: ExchangeConfigRow[]): ExchangeName {
  const def = configs.find((c) => c.isDefault && c.publicEnabled);
  if (def) return def.exchange as ExchangeName;
  // Fallback to BINANCE if exists and enabled, else highest priority enabled
  const binance = configs.find((c) => c.exchange === "BINANCE" && c.publicEnabled);
  if (binance) return "BINANCE";
  const sorted = [...configs].filter(c => c.publicEnabled).sort((a,b) => b.priority - a.priority);
  if (sorted.length > 0) return sorted[0].exchange as ExchangeName;
  return "BINANCE";
}

export function getPublicExchanges(configs: ExchangeConfigRow[]): ExchangeName[] {
  return configs.filter(c => c.publicEnabled).sort((a,b) => b.priority - a.priority).map(c => c.exchange as ExchangeName);
}

export function getOhlcvExchanges(configs: ExchangeConfigRow[]): ExchangeName[] {
  return configs.filter(c => c.ohlcvEnabled).sort((a,b) => b.priority - a.priority).map(c => c.exchange as ExchangeName);
}

export function getLiveExchanges(configs: ExchangeConfigRow[]): ExchangeName[] {
  return configs.filter(c => c.liveEnabled).sort((a,b) => b.priority - a.priority).map(c => c.exchange as ExchangeName);
}

export function selectExchangeWithFallback(
  available: string[],
  preferred: string | null,
  configs: ExchangeConfigRow[]
): { actual: string; requested: string | null; isFallback: boolean } {
  const publicEnabled = new Set(getPublicExchanges(configs));
  const filteredAvailable = available.filter(ex => publicEnabled.has(ex as ExchangeName));
  const candidates = filteredAvailable.length > 0 ? filteredAvailable : available;

  if (preferred && candidates.includes(preferred)) {
    return { actual: preferred, requested: preferred, isFallback: false };
  }

  // Use priority order
  const sortedConfigs = [...configs].filter(c => c.publicEnabled).sort((a,b) => b.priority - a.priority);
  for (const cfg of sortedConfigs) {
    if (candidates.includes(cfg.exchange)) {
      return { actual: cfg.exchange, requested: preferred, isFallback: preferred !== null && preferred !== cfg.exchange };
    }
  }

  // Fallback to BINANCE if exists
  if (candidates.includes("BINANCE")) {
    return { actual: "BINANCE", requested: preferred, isFallback: preferred !== null && preferred !== "BINANCE" };
  }

  // Ultimate fallback first available
  if (candidates.length > 0) {
    return { actual: candidates[0], requested: preferred, isFallback: preferred !== null && preferred !== candidates[0] };
  }

  return { actual: available[0] || "BINANCE", requested: preferred, isFallback: true };
}
