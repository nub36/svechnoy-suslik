/**
 * Strategy Runtime — testovyj CLI.
 *
 * Rezhimy:
 *   (po umolchaniyu)  DB-progon Top-N x timeframe, TOLKO chtenie.
 *                     Signal NIKOGDA ne sozdayutsya.
 *   --self-test       proverki bez bazy: validator, scoring,
 *                     agregaciya, filtry, chuvstvitelnost k config.
 *   --check-validation tolko batareya validacii config (bez bazy).
 *   --prove-db-link   dokazatelstvo svyazki DB -> runtime:
 *                     vremenno menyaet odin parametr config v BD,
 *                     sravnivaet rezultat, VOSSTANAVLIVAET nazad.
 *
 * Primery:
 *   npx tsx scripts/test-strategy-runtime.ts --top=10 --timeframe=1h
 *   npx tsx scripts/test-strategy-runtime.ts --self-test
 *   npx tsx scripts/test-strategy-runtime.ts --prove-db-link
 */

import type { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MarketAnalysis
} from "../lib/analysis/analyze";
import {
  validateStrategyRuntime,
  validateTrendSuslikConfig,
  type TrendSuslikConfig
} from "../lib/strategies/config";
import {
  aggregateAssetGroup,
  applyStrategyFilters,
  evaluateSnapshot,
  type AssetAggregation,
  type EvaluatedMarket,
  type MarketStrategyResult,
  type SnapshotInput
} from "../lib/strategies/runtime";
import { runTrendSuslik } from "../lib/strategies/trend-suslik";

type Db = PrismaClient;

let db: Db | null = null;

/**
 * Prisma podklyuchaetsya LENIVO i tolko v DB-rezhimah.
 * --self-test / --check-validation rabotayut vovse bez
 * @prisma/client (v pesochnice net sgenerirovannogo klienta).
 */
async function getDb(): Promise<Db> {
  if (!db) {
    const mod = await import("@prisma/client");
    db = new mod.PrismaClient();
  }

  return db;
}

async function closeDb(): Promise<void> {
  if (db) {
    await db.$disconnect();
    db = null;
  }
}

const SCRIPT_DIR = dirname(
  fileURLToPath(import.meta.url)
);
const ROOT_DIR = join(SCRIPT_DIR, "..");

/* ================================================================
 * Argumenty
 * ================================================================ */

type Args = {
  top: number;
  timeframe: string;
  strategy: string | null;
  selfTest: boolean;
  checkValidation: boolean;
  proveDbLink: boolean;
  help: boolean;
};

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((v) => v.startsWith(prefix))
    ?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv
    .slice(2)
    .includes(`--${name}`);
}

function parseArgs(): Args {
  return {
    top: Number(getArg("top") ?? 10),
    timeframe: getArg("timeframe") ?? "1h",
    strategy: getArg("strategy") ?? null,
    selfTest: hasFlag("self-test"),
    checkValidation: hasFlag("check-validation"),
    proveDbLink: hasFlag("prove-db-link"),
    help: hasFlag("help")
  };
}

function printHelp(): void {
  console.log(`
Strategy Runtime — testovyj CLI (tolko chtenie, bez Signal INSERT).

Ispolzovanie:
  npx tsx scripts/test-strategy-runtime.ts [opcii]

Opcii:
  --top=10            skolko aktivov Top-N proveryat (1..500)
  --timeframe=1h      tajmfrejm (5m, 15m, 1h, 4h, 1d)
  --strategy=slug     tolko odna strategiya (po umolchaniyu vse PUBLISHED)
  --self-test         proverki bez bazy (validator + scoring + agregaciya)
  --check-validation  tolko batareya validacii config (bez bazy)
  --prove-db-link     dokazat svyazku DB -> runtime s vosstanovleniem config
  --help              eta spravka
`);
}

/* ================================================================
 * Obshchie tipy DB-zagruzchika
 * ================================================================ */

type AssetBatch = {
  symbol: string;
  top500: boolean;
  rank: number | null;
  markets: MarketBatch[];
};

type MarketBatch = {
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  quoteVolume24h: number | null;
  input: SnapshotInput | null;
};

/**
 * Chistyj zagruzchik: Asset/Market + poslednij IndicatorSnapshot.
 * Tolko SELECT. Nichego ne pishet.
 */
async function loadBatches(
  db: Db,
  top: number,
  timeframe: string
): Promise<AssetBatch[]> {
  const assets = await db.asset.findMany({
    where: {
      enabled: true,
      rank: { lte: top, not: null }
    },
    orderBy: { rank: "asc" },
    take: top,
    include: {
      markets: {
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT"
        },
        orderBy: { exchange: "asc" }
      }
    }
  });

  const batches: AssetBatch[] = [];

  for (const asset of assets) {
    const markets: MarketBatch[] = [];

    for (const market of asset.markets) {
      const snap =
        await db.indicatorSnapshot.findFirst({
          where: {
            marketId: market.id,
            timeframe
          },
          orderBy: { candleTime: "desc" }
        });

      markets.push({
        marketId: market.id,
        exchange: market.exchange,
        exchangeSymbol: market.exchangeSymbol,
        quoteVolume24h: market.quoteVolume24h,
        input: snap
          ? {
              marketId: market.id,
              exchange: market.exchange,
              exchangeSymbol:
                market.exchangeSymbol,
              assetSymbol: asset.symbol,
              assetTop500: asset.top500,
              quoteVolume24h:
                market.quoteVolume24h,
              timeframe,
              candleTime: snap.candleTime,
              price: snap.price,
              rsi14: snap.rsi14,
              ema20: snap.ema20,
              ema50: snap.ema50,
              ema200: snap.ema200,
              macd: snap.macd,
              macdSignal: snap.macdSignal,
              macdHist: snap.macdHist,
              atr14: snap.atr14,
              volume: snap.volume,
              avgVolume20: snap.avgVolume20,
              volumeRatio: snap.volumeRatio
            }
          : null
      });
    }

    batches.push({
      symbol: asset.symbol,
      top500: asset.top500,
      rank: asset.rank,
      markets
    });
  }

  return batches;
}

function batchToResults(
  batch: AssetBatch,
  config: TrendSuslikConfig
): MarketStrategyResult[] {
  return batch.markets.map((m) => {
    if (!m.input) {
      return {
        status: "no-snapshot",
        exchange: m.exchange,
        market: m.exchangeSymbol,
        marketId: m.marketId,
        reason: "net IndicatorSnapshot"
      } as const;
    }

    return evaluateSnapshot(m.input, config);
  });
}

/* ================================================================
 * Vyvod rezultatov
 * ================================================================ */

function printAggregation(
  agg: AssetAggregation
): void {
  const dirMark =
    agg.direction === "LONG"
      ? "▲ LONG"
      : agg.direction === "SHORT"
        ? "▼ SHORT"
        : agg.conflict
          ? "⚠ KONFLIKT"
          : "= NEUTRAL";

  console.log(
    `\n── ${agg.asset} · ${agg.timeframe} · ` +
      `${agg.strategySlug} v${agg.strategyVersion} ──`
  );

  for (const m of agg.markets) {
    if (m.status !== "evaluated") {
      console.log(
        `  ${m.exchange.padEnd(8)} ` +
          `${m.market.padEnd(16)} ` +
          `PROPUSHCHEN: ${m.reason}`
      );
      continue;
    }

    console.log(
      `  ${m.exchange.padEnd(8)} ` +
        `${m.market.padEnd(16)} ` +
        `${m.direction.padEnd(7)} ` +
        `LONG=${String(m.longScore).padEnd(3)} ` +
        `SHORT=${String(m.shortScore).padEnd(3)} ` +
        `cena=${m.price} ` +
        `svecha=${m.candleTime.toISOString()}`
    );

    for (const r of m.reasons) {
      const state = r.long
        ? "LONG ✓"
        : r.short
          ? "SHORT ✓"
          : "—";

      console.log(
        `      ${state.padEnd(8)} ${r.label} ` +
          `[${r.weight}] ${r.value ?? ""}`
      );
    }

    for (const w of m.warnings) {
      console.log(`      ⚠ ${w}`);
    }
  }

  console.log(
    `  ITOG: ${dirMark} ` +
      `podtverzhdenie ${agg.confirmation} ` +
      `(porog ${agg.minExchanges})`
  );
  console.log(`  Poyasnenie: ${agg.explanation}`);
}

/* ================================================================
 * Rezhim 1: DB-progon (tolko chtenie)
 * ================================================================ */

async function runDbMode(args: Args): Promise<number> {
  if (
    !Number.isInteger(args.top) ||
    args.top < 1 ||
    args.top > 500
  ) {
    console.error("top dolzhen byt ot 1 do 500");
    return 1;
  }

  console.log("");
  console.log("🐿️ Strategy Runtime — DB-progon (tolko chtenie)");
  console.log(
    `top=${args.top} timeframe=${args.timeframe} ` +
      `strategy=${args.strategy ?? "vse PUBLISHED"}`
  );

  const db = await getDb();

  const signalsBefore = await db.signal.count();
  console.log(
    `Signal v BD do progona: ${signalsBefore}`
  );

  const strategies =
    await db.strategy.findMany({
      where: {
        enabled: true,
        status: "PUBLISHED",
        ...(args.strategy
          ? { slug: args.strategy }
          : {})
      },
      orderBy: [{ slug: "asc" }, { version: "asc" }]
    });

  if (strategies.length === 0) {
    console.error(
      "Net vklyuchyonnyh PUBLISHED strategij " +
        "(enabled=true, status=PUBLISHED)."
    );
    return 1;
  }

  console.log(
    `Strategij k proverke: ${strategies.length}`
  );

  const batches = await loadBatches(
    db,
    args.top,
    args.timeframe
  );

  const marketTotal = batches.reduce(
    (s, b) => s + b.markets.length,
    0
  );
  const snapshotsFound = batches.reduce(
    (s, b) =>
      s +
      b.markets.filter((m) => m.input).length,
    0
  );

  console.log(
    `Aktivov: ${batches.length}, ` +
      `rynkov: ${marketTotal}, ` +
      `snapshotov najdeno: ${snapshotsFound}`
  );

  if (snapshotsFound === 0) {
    console.error(
      "Net IndicatorSnapshot dlya testovogo kontura. " +
        "Snachala zapustite snapshot-worker."
    );
    return 1;
  }

  let failed = false;

  let aggLong = 0;
  let aggShort = 0;
  let aggNeutral = 0;
  let aggConflict = 0;

  for (const strategy of strategies) {
    console.log(
      `\n===== ${strategy.slug} v${strategy.version} ` +
        `(id=${strategy.id}) =====`
    );

    const validation = validateStrategyRuntime({
      config: strategy.config,
      timeframes: strategy.timeframes,
      minExchanges: strategy.minExchanges
    });

    if (!validation.ok) {
      failed = true;
      console.error("❌ Config NEVALIDEN:");
      for (const e of validation.errors) {
        console.error(`   - ${e}`);
      }
      continue;
    }

    console.log(
      `✓ config validen, ` +
        `minScore=${validation.config.minimumSignalScore}, ` +
        `minExchanges=${validation.minExchanges}, ` +
        `TF=[${validation.timeframes.join(",")}]`
    );

    if (
      !validation.timeframes.includes(args.timeframe)
    ) {
      failed = true;
      console.error(
        `❌ Tajmfrejm ${args.timeframe} ne vhodit ` +
          `v strategii timeframes, propusk.`
      );
      continue;
    }

    for (const batch of batches) {
      const results = batchToResults(
        batch,
        validation.config
      );

      const agg = aggregateAssetGroup(
        batch.symbol,
        args.timeframe,
        strategy.slug,
        strategy.version,
        results,
        validation.minExchanges
      );

      printAggregation(agg);

      if (agg.conflict) {
        aggConflict += 1;
      } else if (agg.direction === "LONG") {
        aggLong += 1;
      } else if (agg.direction === "SHORT") {
        aggShort += 1;
      } else {
        aggNeutral += 1;
      }
    }
  }

  const signalsAfter = await db.signal.count();

  console.log("\n---------- svodka ----------");
  console.log(`aktivov: ${batches.length}`);
  console.log(
    `agregacij: LONG=${aggLong} SHORT=${aggShort} ` +
      `NEUTRAL=${aggNeutral} KONFLIKT=${aggConflict}`
  );
  console.log(
    `Signal: bylo ${signalsBefore}, stalo ${signalsAfter}`
  );

  if (signalsAfter !== signalsBefore) {
    console.error(
      "❌ KATASTROFA: kolichestvo Signal izmenilos! " +
        "Skript dolzhen byt read-only."
    );
    return 1;
  }

  console.log(
    "✓ Signal zapisej ne sozdano (read-only podtverzhdyon)"
  );

  return failed ? 1 : 0;
}

/* ================================================================
 * Rezhim 2: dokazatelstvo svyazki DB -> runtime
 * ================================================================ */

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return (
      "[" +
      value.map((v) => stableStringify(v)).join(",") +
      "]"
    );
  }

  if (
    typeof value === "object" &&
    value !== null
  ) {
    const rec = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(rec)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            stableStringify(rec[k])
        )
        .join(",") +
      "}"
    );
  }

  return JSON.stringify(value) ?? "null";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value)
  ) as T;
}

function configToJson(
  config: TrendSuslikConfig
): Record<string, unknown> {
  return cloneJson<
    Record<string, unknown>
  >(config as unknown as Record<string, unknown>);
}

async function runProveDbLink(
  args: Args
): Promise<number> {
  const slug = args.strategy ?? "trend-suslik";

  console.log("");
  console.log("🐿️ Dokazatelstvo svyazki DB -> runtime");
  console.log(
    `strategy=${slug} top=${args.top} ` +
      `timeframe=${args.timeframe}`
  );

  const db = await getDb();

  const strategy =
    await db.strategy.findFirst({
      where: {
        slug,
        enabled: true,
        status: "PUBLISHED"
      },
      orderBy: { version: "desc" }
    });

  if (!strategy) {
    console.error(
      `Strategiya ${slug} (enabled+PUBLISHED) ne najdena.`
    );
    return 1;
  }

  const baselineCheck = validateStrategyRuntime({
    config: strategy.config,
    timeframes: strategy.timeframes,
    minExchanges: strategy.minExchanges
  });

  if (!baselineCheck.ok) {
    console.error("Bazovyj config nevaliden:");
    for (const e of baselineCheck.errors) {
      console.error(`   - ${e}`);
    }
    return 1;
  }

  const batches = await loadBatches(
    db,
    args.top,
    args.timeframe
  );

  const inputs: SnapshotInput[] = [];

  for (const b of batches) {
    for (const m of b.markets) {
      if (m.input) {
        inputs.push(m.input);
      }
    }
  }

  if (inputs.length === 0) {
    console.error(
      "Net snapshotov dlya dokazatelstva."
    );
    return 1;
  }

  console.log(
    `Snapshotov v probe: ${inputs.length}`
  );

  const signature = (
    config: TrendSuslikConfig
  ): string[] =>
    inputs.map((input) => {
      const r = evaluateSnapshot(input, config);

      if (r.status !== "evaluated") {
        return `${r.exchange}:${r.market}:SKIP`;
      }

      return (
        `${r.exchange}:${r.market}:` +
        `${r.longScore}/${r.shortScore}/${r.direction}`
      );
    });

  const originalConfig = cloneJson(
    strategy.config
  );
  const originalHash = stableStringify(
    originalConfig
  );

  const baselineSig = signature(
    baselineCheck.config
  );

  console.log(
    `Bazovyj config: minScore=${baselineCheck.config.minimumSignalScore}`
  );

  // Zond 1: minimalnyj porog — pochti vse stanut LONG/SHORT.
  // Zond 2 (zapasnoj): maksimalnye vesa — menyayutsya bally.
  const probes: {
    name: string;
    config: TrendSuslikConfig;
  }[] = [
    {
      name: "minimumSignalScore=0",
      config: {
        ...cloneJson(baselineCheck.config),
        minimumSignalScore: 0
      }
    },
    {
      name: "weights=100 vse",
      config: {
        ...cloneJson(baselineCheck.config),
        weights: {
          trend: 100,
          mediumTrend: 100,
          rsi: 100,
          macd: 100,
          volume: 100
        }
      }
    }
  ];

  let restoredOk = false;

  try {
    for (const probe of probes) {
      const probeCheck =
        validateTrendSuslikConfig(
          configToJson(probe.config)
        );

      if (!probeCheck.ok) {
        console.error(
          `Zond ${probe.name} ne proshel validaciyu?!`
        );
        return 1;
      }

      await db.strategy.update({
        where: { id: strategy.id },
        data: { config: configToJson(probe.config) }
      });

      // Chitaem zanovo IZ BD, kak delaet runtime.
      const reloaded =
        await db.strategy.findUnique({
          where: { id: strategy.id }
        });

      if (!reloaded) {
        throw new Error(
          "strategiya propala iz BD vo vremya proby"
        );
      }

      const reloadedCheck =
        validateStrategyRuntime({
          config: reloaded.config,
          timeframes: reloaded.timeframes,
          minExchanges: reloaded.minExchanges
        });

      if (!reloadedCheck.ok) {
        throw new Error(
          "perezagruzhennyj config nevaliden"
        );
      }

      const probeSig = signature(
        reloadedCheck.config
      );

      let diffs = 0;
      const diffLines: string[] = [];

      for (let i = 0; i < inputs.length; i++) {
        if (baselineSig[i] !== probeSig[i]) {
          diffs += 1;

          if (diffLines.length < 10) {
            diffLines.push(
              `   ${inputs[i].exchange} ` +
                `${inputs[i].exchangeSymbol}: ` +
                `${baselineSig[i].split(":").slice(2).join(":")} ` +
                `→ ${probeSig[i].split(":").slice(2).join(":")}`
            );
          }
        }
      }

      console.log(
        `\nZond "${probe.name}": ` +
          `otlichaetsya rynkov ${diffs}/${inputs.length}`
      );

      for (const line of diffLines) {
        console.log(line);
      }

      if (diffs > 0) {
        console.log(
          "✓ DOKAZANO: izmenenie Strategy.config v BD " +
            "menyaet runtime bez izmeneniya TypeScript."
        );
        break;
      }

      if (probe === probes[probes.length - 1]) {
        console.error(
          "❌ Oba zonda ne dali otlichij — " +
            "svyazku schitat nepodtverzhdyonnoj."
        );
        return 1;
      }

      console.log(
        "Zond ne dal otlichij, probuem sleduyushchij..."
      );
    }
  } finally {
    await db.strategy.update({
      where: { id: strategy.id },
      data: {
        config: originalConfig as Record<
          string,
          never
        >
      }
    });

    const after =
      await db.strategy.findUnique({
        where: { id: strategy.id }
      });

    restoredOk =
      !!after &&
      stableStringify(after.config) ===
        originalHash;
  }

  console.log(
    restoredOk
      ? "✓ Originalnyj config vosstanovlen (provereno povtornym chteniem)"
      : "❌ Config NE vosstanovlen! Trebuetsya ruchnaya proverka!"
  );

  return restoredOk ? 0 : 1;
}

/* ================================================================
 * Rezhim 3: self-test bez bazy
 * ================================================================ */

type Check = {
  name: string;
  pass: boolean;
  detail: string;
};

function seedLikeConfig(): TrendSuslikConfig {
  return {
    minimumSignalScore: 70,
    weights: {
      trend: 30,
      mediumTrend: 15,
      rsi: 20,
      macd: 20,
      volume: 15
    },
    ema: { fast: 20, medium: 50, slow: 200 },
    rsi: {
      period: 14,
      longMin: 52,
      longMax: 72,
      shortMin: 28,
      shortMax: 48
    },
    macd: { fast: 12, slow: 26, signal: 9 },
    atr: {
      period: 14,
      stopMultiplier: 1.5,
      takeProfit1Multiplier: 1.5,
      takeProfit2Multiplier: 2.5,
      takeProfit3Multiplier: 4
    },
    volume: { period: 20, minimumRatio: 1 },
    execution: {
      closedCandleOnly: true,
      cooldownCandles: 3
    },
    filters: {
      minimumQuoteVolume24h: 1000000,
      top500Only: true
    }
  };
}

function makeAnalysis(
  overrides: Partial<MarketAnalysis> = {}
): MarketAnalysis {
  return {
    candleTime: new Date(
      "2026-09-09T10:00:00.000Z"
    ),
    price: 80000,
    rsi14: 60,
    ema20: 80100,
    ema50: 79900,
    ema200: 79000,
    macd: 10,
    macdSignal: 5,
    macdHist: 5,
    atr14: 300,
    volume: 100,
    avgVolume20: 80,
    volumeRatio: 1.25,
    ...overrides
  };
}

/** Etalonnyj LONG: vse 5 uslovij, 100 ballov. */
function longFixture(): MarketAnalysis {
  return makeAnalysis({
    price: 81000,
    ema20: 80500,
    ema50: 80000,
    ema200: 79000,
    rsi14: 60,
    macdHist: 5,
    volumeRatio: 1.5
  });
}

/** Etalonnyj SHORT: vse 5 uslovij, 100 ballov. */
function shortFixture(): MarketAnalysis {
  return makeAnalysis({
    price: 77000,
    ema20: 77500,
    ema50: 78000,
    ema200: 79000,
    rsi14: 35,
    macdHist: -5,
    volumeRatio: 1.5
  });
}

/**
 * Neytral kak realnyj BTC 1H: RSI+MACD za LONG (40/0),
 * no trenda i obyoma net -> NEUTRAL pri poroge 70.
 */
function neutralFixture(): MarketAnalysis {
  return makeAnalysis({
    price: 79950,
    ema20: 79950,
    ema50: 79900,
    ema200: 80000,
    rsi14: 60,
    macd: 5,
    macdSignal: 4,
    macdHist: 2,
    volumeRatio: 0.8
  });
}

function mutateConfig(
  mutate: (
    c: Record<string, unknown>
  ) => void
): unknown {
  const raw = cloneJson<
    Record<string, unknown>
  >(
    seedLikeConfig() as unknown as Record<
      string,
      unknown
    >
  );
  mutate(raw);
  return raw;
}

function runValidationBattery(): Check[] {
  const checks: Check[] = [];

  const expectOk = (
    name: string,
    raw: unknown,
    expected: boolean
  ): void => {
    const res = validateTrendSuslikConfig(raw);
    checks.push({
      name: `validaciya config: ${name}`,
      pass: res.ok === expected,
      detail: res.ok
        ? "ok:true"
        : `ok:false [${res.errors.slice(0, 2).join("; ")}]`
    });
  };

  expectOk(
    "etalonnyj config (kak seed) validen",
    cloneJson(seedLikeConfig()),
    true
  );
  expectOk("null", null, false);
  expectOk("massiv", [], false);
  expectOk("stroka", "{}", false);

  expectOk(
    "net sekcii weights",
    mutateConfig((c) => {
      delete c.weights;
    }),
    false
  );
  expectOk(
    "minimumSignalScore=101",
    mutateConfig((c) => {
      c.minimumSignalScore = 101;
    }),
    false
  );
  expectOk(
    "minimumSignalScore=-1",
    mutateConfig((c) => {
      c.minimumSignalScore = -1;
    }),
    false
  );
  expectOk(
    "ves trend=-5",
    mutateConfig((c) => {
      (c.weights as Record<string, unknown>).trend =
        -5;
    }),
    false
  );
  expectOk(
    "vse vesa 0",
    mutateConfig((c) => {
      c.weights = {
        trend: 0,
        mediumTrend: 0,
        rsi: 0,
        macd: 0,
        volume: 0
      };
    }),
    false
  );
  expectOk(
    "ema fast==medium",
    mutateConfig((c) => {
      c.ema = { fast: 50, medium: 50, slow: 200 };
    }),
    false
  );
  expectOk(
    "ema slow=0",
    mutateConfig((c) => {
      (c.ema as Record<string, unknown>).slow = 0;
    }),
    false
  );
  expectOk(
    "ema fast ne celoe",
    mutateConfig((c) => {
      (c.ema as Record<string, unknown>).fast =
        2.5;
    }),
    false
  );
  expectOk(
    "rsi longMin>longMax",
    mutateConfig((c) => {
      (c.rsi as Record<string, unknown>).longMin =
        80;
      (c.rsi as Record<string, unknown>).longMax =
        70;
    }),
    false
  );
  expectOk(
    "rsi shortMax=150",
    mutateConfig((c) => {
      (c.rsi as Record<string, unknown>).shortMax =
        150;
    }),
    false
  );
  expectOk(
    "rsi period=0",
    mutateConfig((c) => {
      (c.rsi as Record<string, unknown>).period =
        0;
    }),
    false
  );
  expectOk(
    "macd signal=-1",
    mutateConfig((c) => {
      (c.macd as Record<string, unknown>).signal =
        -1;
    }),
    false
  );
  expectOk(
    "atr stopMultiplier=0",
    mutateConfig((c) => {
      (
        c.atr as Record<string, unknown>
      ).stopMultiplier = 0;
    }),
    false
  );
  expectOk(
    "volume minimumRatio=-0.5",
    mutateConfig((c) => {
      (
        c.volume as Record<string, unknown>
      ).minimumRatio = -0.5;
    }),
    false
  );
  expectOk(
    "volume period=0",
    mutateConfig((c) => {
      (
        c.volume as Record<string, unknown>
      ).period = 0;
    }),
    false
  );
  expectOk(
    "cooldownCandles=-1",
    mutateConfig((c) => {
      (
        c.execution as Record<string, unknown>
      ).cooldownCandles = -1;
    }),
    false
  );
  expectOk(
    "closedCandleOnly ne boolean",
    mutateConfig((c) => {
      (
        c.execution as Record<string, unknown>
      ).closedCandleOnly = "yes";
    }),
    false
  );
  expectOk(
    "minimumQuoteVolume24h=-1",
    mutateConfig((c) => {
      (
        c.filters as Record<string, unknown>
      ).minimumQuoteVolume24h = -1;
    }),
    false
  );
  expectOk(
    "top500Only ne boolean",
    mutateConfig((c) => {
      (
        c.filters as Record<string, unknown>
      ).top500Only = 1;
    }),
    false
  );
  expectOk(
    "lishnie klyuchi razresheny",
    mutateConfig((c) => {
      c.futureField = { hello: "world" };
    }),
    true
  );

  // Uroven strategii: timeframes + minExchanges.
  const expectStrategy = (
    name: string,
    input: {
      config: unknown;
      timeframes: unknown;
      minExchanges: unknown;
    },
    expected: boolean
  ): void => {
    const res = validateStrategyRuntime(input);
    checks.push({
      name: `validaciya strategii: ${name}`,
      pass: res.ok === expected,
      detail: res.ok
        ? "ok:true"
        : `ok:false [${res.errors.slice(0, 2).join("; ")}]`
    });
  };

  const good = {
    config: cloneJson(seedLikeConfig()),
    timeframes: ["15m", "1h", "4h", "1d"],
    minExchanges: 3
  };

  expectStrategy("etalon validen", good, true);
  expectStrategy(
    "timeframes pust",
    { ...good, timeframes: [] },
    false
  );
  expectStrategy(
    "timeframes musor",
    { ...good, timeframes: ["2h"] },
    false
  );
  expectStrategy(
    "timeframes ne massiv",
    { ...good, timeframes: "1h" },
    false
  );
  expectStrategy(
    "minExchanges=0",
    { ...good, minExchanges: 0 },
    false
  );
  expectStrategy(
    "minExchanges=6",
    { ...good, minExchanges: 6 },
    false
  );
  expectStrategy(
    "minExchanges=2.5",
    { ...good, minExchanges: 2.5 },
    false
  );
  expectStrategy(
    "bityj config + horoshie polya",
    { ...good, config: { broken: true } },
    false
  );

  return checks;
}

function mkEval(
  exchange: string,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  id: number
): EvaluatedMarket {
  return {
    status: "evaluated",
    exchange,
    market: `BTC-${exchange}`,
    marketId: id,
    candleTime: new Date(
      "2026-09-09T10:00:00.000Z"
    ),
    price: 80000,
    longScore: direction === "LONG" ? 80 : 10,
    shortScore: direction === "SHORT" ? 80 : 10,
    direction,
    reasons: [],
    warnings: []
  };
}

function mkInput(
  overrides: Partial<SnapshotInput> = {}
): SnapshotInput {
  return {
    marketId: 1,
    exchange: "BINANCE",
    exchangeSymbol: "BTCUSDT",
    assetSymbol: "BTC",
    assetTop500: true,
    quoteVolume24h: 50_000_000,
    timeframe: "1h",
    candleTime: new Date(
      "2026-09-09T10:00:00.000Z"
    ),
    price: 81000,
    rsi14: 60,
    ema20: 80500,
    ema50: 80000,
    ema200: 79000,
    macd: 10,
    macdSignal: 5,
    macdHist: 5,
    atr14: 300,
    volume: 100,
    avgVolume20: 80,
    volumeRatio: 1.5,
    ...overrides
  };
}

function runRuntimeChecks(): Check[] {
  const checks: Check[] = [];
  const config = seedLikeConfig();

  // --- scoring ---
  const long = runTrendSuslik(
    longFixture(),
    config
  );
  checks.push({
    name: "scoring: etalon LONG",
    pass:
      long.direction === "LONG" &&
      long.longScore === 100 &&
      long.shortScore === 0,
    detail:
      `${long.direction} ` +
      `LONG=${long.longScore} SHORT=${long.shortScore}`
  });

  const short = runTrendSuslik(
    shortFixture(),
    config
  );
  checks.push({
    name: "scoring: etalon SHORT",
    pass:
      short.direction === "SHORT" &&
      short.shortScore === 100 &&
      short.longScore === 0,
    detail:
      `${short.direction} ` +
      `LONG=${short.longScore} SHORT=${short.shortScore}`
  });

  const neutral = runTrendSuslik(
    neutralFixture(),
    config
  );
  checks.push({
    name: "scoring: BTC-podobnyj NEUTRAL 40/0",
    pass:
      neutral.direction === "NEUTRAL" &&
      neutral.longScore === 40 &&
      neutral.shortScore === 0,
    detail:
      `${neutral.direction} ` +
      `LONG=${neutral.longScore} SHORT=${neutral.shortScore}`
  });

  // --- strogost lidershipa: nichya -> NEUTRAL ---
  const allNull = runTrendSuslik(
    makeAnalysis({
      rsi14: null,
      ema20: null,
      ema50: null,
      ema200: null,
      macdHist: null,
      volumeRatio: null
    }),
    { ...config, minimumSignalScore: 0 }
  );
  checks.push({
    name: "scoring: nichya 0/0 pri poroge 0 -> NEUTRAL",
    pass:
      allNull.direction === "NEUTRAL" &&
      allNull.longScore === 0 &&
      allNull.shortScore === 0,
    detail: `${allNull.direction}`
  });

  // --- chuvstvitelnost k config (bez izmeneniya koda) ---
  const lowThreshold = runTrendSuslik(
    neutralFixture(),
    { ...config, minimumSignalScore: 30 }
  );
  checks.push({
    name: "config: porog 70->30 perevorachivaet NEUTRAL->LONG",
    pass:
      neutral.direction === "NEUTRAL" &&
      lowThreshold.direction === "LONG",
    detail:
      `70:${neutral.direction} -> 30:${lowThreshold.direction}`
  });

  const noRsiWeight = runTrendSuslik(
    neutralFixture(),
    {
      ...config,
      weights: { ...config.weights, rsi: 0 }
    }
  );
  checks.push({
    name: "config: ves RSI 20->0 menyaet Bally 40->20",
    pass:
      noRsiWeight.longScore === 20 &&
      neutral.longScore === 40,
    detail:
      `LONG ${neutral.longScore} -> ${noRsiWeight.longScore}`
  });

  // --- warnings o periodah ---
  const warnCfg: TrendSuslikConfig = {
    ...cloneJson(config),
    ema: { fast: 10, medium: 50, slow: 200 }
  };
  const warned = runTrendSuslik(
    longFixture(),
    warnCfg
  );
  checks.push({
    name: "warning: chuzhie periody EMA dayut warnings",
    pass:
      warned.warnings.length > 0 &&
      warned.direction === "LONG",
    detail: `warnings=${warned.warnings.length}`
  });

  checks.push({
    name: "warning: etalonnyj config bez warnings",
    pass: long.warnings.length === 0,
    detail: `warnings=${long.warnings.length}`
  });

  // --- filtry ---
  const passFilter = applyStrategyFilters(
    {
      assetTop500: true,
      quoteVolume24h: 50_000_000
    },
    config
  );
  checks.push({
    name: "filtr: horoshij rynok prohodit",
    pass: passFilter === null,
    detail: passFilter ?? "proshyol"
  });

  const topFilter = applyStrategyFilters(
    {
      assetTop500: false,
      quoteVolume24h: 50_000_000
    },
    config
  );
  checks.push({
    name: "filtr: vne Top-500 otseivaetsya",
    pass:
      topFilter !== null &&
      topFilter.includes("Top-500"),
    detail: topFilter ?? "NE otseyan?!"
  });

  const volFilter = applyStrategyFilters(
    {
      assetTop500: true,
      quoteVolume24h: 100
    },
    config
  );
  checks.push({
    name: "filtr: nizkij obyom otseivaetsya",
    pass: volFilter !== null,
    detail: volFilter ?? "NE otseyan?!"
  });

  const nullVolFilter = applyStrategyFilters(
    {
      assetTop500: true,
      quoteVolume24h: null
    },
    config
  );
  checks.push({
    name: "filtr: null-obyom schitaetsya 0 i otseivaetsya",
    pass: nullVolFilter !== null,
    detail: nullVolFilter ?? "NE otseyan?!"
  });

  const evalFiltered = evaluateSnapshot(
    mkInput({ assetTop500: false }),
    config
  );
  checks.push({
    name: "evaluate: filtr vozvrashchaet status=filtered",
    pass:
      evalFiltered.status === "filtered",
    detail: `status=${evalFiltered.status}`
  });

  // --- agregaciya ---
  const agg1 = aggregateAssetGroup(
    "BTC",
    "1h",
    "trend-suslik",
    1,
    [
      mkEval("BINANCE", "LONG", 1),
      mkEval("BYBIT", "LONG", 2),
      mkEval("GATE", "LONG", 3),
      mkEval("KUCOIN", "NEUTRAL", 4),
      mkEval("BINGX", "LONG", 5)
    ],
    3
  );
  checks.push({
    name: "agregaciya: 4 LONG + 1 NEUTRAL -> LONG 4/5",
    pass:
      agg1.direction === "LONG" &&
      !agg1.conflict &&
      agg1.confirmation === "4/5",
    detail:
      `${agg1.direction} ${agg1.confirmation}`
  });

  const agg2 = aggregateAssetGroup(
    "BTC",
    "1h",
    "trend-suslik",
    1,
    [
      mkEval("BINANCE", "LONG", 1),
      mkEval("BYBIT", "LONG", 2),
      mkEval("GATE", "NEUTRAL", 3)
    ],
    3
  );
  checks.push({
    name: "agregaciya: 2/3 golosov -> NEUTRAL",
    pass:
      agg2.direction === "NEUTRAL" &&
      !agg2.conflict,
    detail: `${agg2.direction} ${agg2.confirmation}`
  });

  const agg3 = aggregateAssetGroup(
    "BTC",
    "1h",
    "trend-suslik",
    1,
    [
      mkEval("BINANCE", "LONG", 1),
      mkEval("BYBIT", "LONG", 2),
      mkEval("GATE", "LONG", 3),
      mkEval("KUCOIN", "SHORT", 4),
      mkEval("BINGX", "SHORT", 5),
      mkEval("EXTRA", "SHORT", 6)
    ],
    3
  );
  checks.push({
    name: "agregaciya: 3 LONG + 3 SHORT -> KONFLIKT",
    pass:
      agg3.direction === "NEUTRAL" &&
      agg3.conflict &&
      agg3.explanation.includes("KONFLIKT"),
    detail: agg3.confirmation
  });

  const agg4 = aggregateAssetGroup(
    "BTC",
    "1h",
    "trend-suslik",
    1,
    [
      {
        status: "filtered",
        exchange: "BINANCE",
        market: "BTCUSDT",
        marketId: 1,
        reason: "test"
      }
    ],
    3
  );
  checks.push({
    name: "agregaciya: vse propushcheny -> NEUTRAL bez golosov",
    pass:
      agg4.direction === "NEUTRAL" &&
      agg4.evaluated === 0 &&
      agg4.skipped === 1,
    detail: agg4.explanation
  });

  const agg5 = aggregateAssetGroup(
    "ETH",
    "1h",
    "trend-suslik",
    1,
    [
      mkEval("BINANCE", "SHORT", 1),
      mkEval("BYBIT", "SHORT", 2),
      mkEval("GATE", "SHORT", 3),
      mkEval("KUCOIN", "SHORT", 4),
      mkEval("BINGX", "SHORT", 5)
    ],
    5
  );
  checks.push({
    name: "agregaciya: 5/5 SHORT pri poroge 5 -> SHORT",
    pass:
      agg5.direction === "SHORT" &&
      agg5.confirmation === "5/5",
    detail: `${agg5.direction} ${agg5.confirmation}`
  });

  return checks;
}

function runStaticAudit(): Check[] {
  const checks: Check[] = [];

  // Yadro scoring ne imeet dostupa k BD v principe.
  const coreFiles = [
    "lib/strategies/config.ts",
    "lib/strategies/trend-suslik.ts",
    "lib/strategies/runtime.ts"
  ];

  for (const rel of coreFiles) {
    const src = readFileSync(
      join(ROOT_DIR, rel),
      "utf8"
    );
    const hasDb =
      src.includes("@prisma/client") ||
      src.includes("prisma.");
    checks.push({
      name: `audit: ${rel} bez dostupa k BD`,
      pass: !hasDb,
      detail: hasDb
        ? "NAJDEN dostup k BD!"
        : "chistye funkcii"
    });
  }

  // Etot skript mozhet tolko chitat Signal, nikogda pisat.
  const self = readFileSync(
    join(SCRIPT_DIR, "test-strategy-runtime.ts"),
    "utf8"
  );
  // Iglomay stroim cherez konkatenaciyu, chtoby sam audit
  // ne soderzhal iskomye podstroki bukvalno.
  const sig = "signal" + ".";
  const dollar = "$";
  const writes = [
    sig + "create",
    sig + "update",
    sig + "upsert",
    sig + "delete",
    dollar + "executeRaw",
    dollar + "queryRaw"
  ].filter((needle) => self.includes(needle));

  checks.push({
    name: "audit: skript ne soderzhit zapisej Signal",
    pass: writes.length === 0,
    detail:
      writes.length === 0
        ? "tolko find/count"
        : `NAJDENO: ${writes.join(", ")}`
  });

  return checks;
}

async function runSelfTest(): Promise<number> {
  console.log("");
  console.log(
    "🐿️ Strategy Runtime — self-test (bez bazy)"
  );

  const all: Check[] = [
    ...runValidationBattery(),
    ...runRuntimeChecks(),
    ...runStaticAudit()
  ];

  let failed = 0;

  for (const c of all) {
    const mark = c.pass ? "✓" : "❌";
    console.log(
      `${mark} ${c.name} — ${c.detail}`
    );

    if (!c.pass) {
      failed += 1;
    }
  }

  console.log(
    `\nItog: ${all.length - failed}/${all.length} proshli`
  );

  return failed === 0 ? 0 : 1;
}

async function runCheckValidation(): Promise<number> {
  console.log("");
  console.log(
    "🐿️ Validaciya Strategy.config — batareya"
  );

  const checks = runValidationBattery();
  let failed = 0;

  for (const c of checks) {
    console.log(
      `${c.pass ? "✓" : "❌"} ${c.name} — ${c.detail}`
    );

    if (!c.pass) {
      failed += 1;
    }
  }

  console.log(
    `\nItog: ${checks.length - failed}/${checks.length} proshli`
  );

  return failed === 0 ? 0 : 1;
}

/* ================================================================
 * main
 * ================================================================ */

async function main(): Promise<number> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.selfTest) {
    return runSelfTest();
  }

  if (args.checkValidation) {
    return runCheckValidation();
  }

  if (args.proveDbLink) {
    return runProveDbLink(args);
  }

  return runDbMode(args);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (
      error instanceof Error &&
      /database|connect|DATABASE_URL|P1001|P1000|did not initialize|prisma generate/i.test(
        error.message
      )
    ) {
      console.error(
        "❌ PostgreSQL nedostupna. " +
          "DB-rezhimy trebuyut DATABASE_URL " +
          "(na VPS), a v pesochнице dostupny " +
          "--self-test i --check-validation."
      );
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
