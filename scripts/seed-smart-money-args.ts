/**
 * Pure parser for seed-smart-money.ts — no DB, no side effects.
 * Exported for tests and for seed script reuse.
 * Dry-run is default, --apply requires explicit operator params.
 */

export const SMART_MONEY_SLUG = "smart-money-suslik";
export const SMART_MONEY_NAME = "Смарт Мани Суслик";
export const SMART_MONEY_VERSION = 1;
export const SMART_MONEY_TIMEFRAMES = ["1h"] as const;
export const SMART_MONEY_ENABLED = false;
export const SMART_MONEY_STATUS = "DRAFT";

export const CANONICAL_SMC_CONFIG = {
  minimumSignalScore: 72,
  swingLeft: 20,
  swingRight: 20,
  internalLeft: 3,
  internalRight: 3,
  atrPeriod: 14,
  structureEventFreshBars: 10,
  sweepFreshBars: 5,
  orderBlockFreshBars: 20,
  fvgFreshBars: 20,
  eqBand: 0.02,
  weights: {
    swingStructureBias: 20,
    recentSwingBos: 15,
    internalStructure: 10,
    liquiditySweep: 10,
    swingOrderBlock: 15,
    internalOrderBlock: 5,
    fvg: 10,
    rangePosition: 10,
    confluence: 5,
  },
} as const;

export const CANONICAL_DESCRIPTION =
  "Smart Money Strategy на основе SMC: Market Structure, BOS, Liquidity Sweep, Order Blocks, FVG, Dealing Range. Phase 3C engineered defaults, staged 1h. Signal Engine не развёрнут.";

export type ParsedSeedArgs = {
  apply: boolean;
  dryRunExplicit: boolean;
  help: boolean;
  minExchanges: number | null;
  minExchangesProvided: boolean;
  minimumQuoteVolume24h: number | null;
  minimumQuoteVolumeProvided: boolean;
  top100Only: boolean | null;
  top100OnlyProvided: boolean;
  errors: string[];
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function parseSeedSmartMoneyArgs(argv: string[]): ParsedSeedArgs {
  let apply = false;
  let dryRunExplicit = false;
  let help = false;
  let minExchanges: number | null = null;
  let minExchangesProvided = false;
  let minimumQuoteVolume24h: number | null = null;
  let minimumQuoteVolumeProvided = false;
  let top100Only: boolean | null = null;
  let top100OnlyProvided = false;
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRunExplicit = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    // --min-exchanges (canonical) + aliases
    if (arg === "--min-exchanges" || arg === "--minExchanges" || arg === "--min_exchanges") {
      minExchangesProvided = true;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push("--min-exchanges требует значение 1..5 (например --min-exchanges 2)");
      } else {
        const raw = next;
        if (!/^\d+$/.test(raw.trim())) {
          errors.push(`--min-exchanges значение "${raw}" должно быть целым числом 1..5`);
        } else {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1 || n > 5) {
            errors.push(`--min-exchanges значение "${raw}" должно быть целым числом 1..5`);
          } else {
            minExchanges = n;
          }
        }
        i++;
      }
      continue;
    }
    if (
      arg.startsWith("--min-exchanges=") ||
      arg.startsWith("--minExchanges=") ||
      arg.startsWith("--min_exchanges=")
    ) {
      minExchangesProvided = true;
      const eqIdx = arg.indexOf("=");
      const raw = arg.slice(eqIdx + 1);
      if (raw === "" || raw.startsWith("--")) {
        errors.push("--min-exchanges требует значение 1..5 (например --min-exchanges=2)");
      } else if (!/^\d+$/.test(raw.trim())) {
        errors.push(`--min-exchanges значение "${raw}" должно быть целым числом 1..5`);
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          errors.push(`--min-exchanges значение "${raw}" должно быть целым числом 1..5`);
        } else {
          minExchanges = n;
        }
      }
      continue;
    }

    // --minimum-quote-volume-24h + aliases
    const volumeFlags = [
      "--minimum-quote-volume-24h",
      "--minimum-quote-volume24h",
      "--minimum-quote-volume",
      "--minimumQuoteVolume24h",
    ];
    const volumeEqFlags = [
      "--minimum-quote-volume-24h=",
      "--minimum-quote-volume24h=",
      "--minimum-quote-volume=",
      "--minimumQuoteVolume24h=",
    ];
    let handledVolume = false;
    for (const flag of volumeFlags) {
      if (arg === flag) {
        minimumQuoteVolumeProvided = true;
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          errors.push(
            "--minimum-quote-volume-24h требует числовое значение >=0 (например --minimum-quote-volume-24h 1000000)"
          );
        } else {
          const raw = next.trim();
          const n = Number(raw);
          if (raw === "" || !isFiniteNumber(n)) {
            errors.push(
              `--minimum-quote-volume-24h значение "${raw}" должно быть числом >=0`
            );
          } else if (n < 0) {
            errors.push(
              `--minimum-quote-volume-24h значение "${raw}" должно быть >=0 (отрицательное запрещено)`
            );
          } else {
            minimumQuoteVolume24h = n;
          }
        }
        i++;
        handledVolume = true;
        break;
      }
    }
    if (handledVolume) continue;

    for (const flagEq of volumeEqFlags) {
      if (arg.startsWith(flagEq)) {
        minimumQuoteVolumeProvided = true;
        const raw = arg.slice(flagEq.length).trim();
        if (raw === "" || raw.startsWith("--")) {
          errors.push(
            "--minimum-quote-volume-24h требует числовое значение >=0 (например --minimum-quote-volume-24h=1000000)"
          );
        } else {
          const n = Number(raw);
          if (!isFiniteNumber(n)) {
            errors.push(
              `--minimum-quote-volume-24h значение "${raw}" должно быть числом >=0`
            );
          } else if (n < 0) {
            errors.push(
              `--minimum-quote-volume-24h значение "${raw}" должно быть >=0 (отрицательное запрещено)`
            );
          } else {
            minimumQuoteVolume24h = n;
          }
        }
        handledVolume = true;
        break;
      }
    }
    if (handledVolume) continue;

    // --top100-only (canonical) + aliases: --top-100-only, --top500-only, --top500Only, --top100Only
    const topFlags = [
      "--top100-only",
      "--top-100-only",
      "--top500-only",
      "--top500Only",
      "--top100Only",
    ];
    const topEqFlags = [
      "--top100-only=",
      "--top-100-only=",
      "--top500-only=",
      "--top500Only=",
      "--top100Only=",
    ];

    let handledTop = false;
    for (const flag of topFlags) {
      if (arg === flag) {
        top100OnlyProvided = true;
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          errors.push(
            "--top100-only требует значение true|false (например --top100-only true)"
          );
        } else {
          const raw = next.trim().toLowerCase();
          if (raw === "true") top100Only = true;
          else if (raw === "false") top100Only = false;
          else
            errors.push(
              `--top100-only значение "${next}" должно быть true или false`
            );
        }
        i++;
        handledTop = true;
        break;
      }
    }
    if (handledTop) continue;
    for (const flagEq of topEqFlags) {
      if (arg.startsWith(flagEq)) {
        top100OnlyProvided = true;
        const raw = arg.slice(flagEq.length).trim().toLowerCase();
        if (raw === "" || raw.startsWith("--")) {
          errors.push(
            "--top100-only требует значение true|false (например --top100-only=true)"
          );
        } else if (raw === "true") top100Only = true;
        else if (raw === "false") top100Only = false;
        else
          errors.push(
            `--top100-only значение "${arg.slice(flagEq.length)}" должно быть true или false`
          );
        handledTop = true;
        break;
      }
    }
    if (handledTop) continue;

    if (arg.startsWith("--")) {
      errors.push(`неизвестный флаг ${arg}`);
      continue;
    }

    errors.push(`неожиданный аргумент ${arg}`);
  }

  // Conflict: --apply + --dry-run together
  if (apply && dryRunExplicit) {
    errors.push("нельзя одновременно использовать --apply и --dry-run — выберите один режим");
  }

  return {
    apply,
    dryRunExplicit,
    help,
    minExchanges,
    minExchangesProvided,
    minimumQuoteVolume24h,
    minimumQuoteVolumeProvided,
    top100Only,
    top100OnlyProvided,
    errors,
  };
}

export function isDryRunMode(parsed: ParsedSeedArgs): boolean {
  if (parsed.help) return true;
  // dry-run is default when --apply not present
  return !parsed.apply;
}

export function validateForApply(parsed: ParsedSeedArgs): string | null {
  if (parsed.errors.length > 0) return parsed.errors[0];
  if (!parsed.apply) return null;
  // All three operator params must be explicitly provided
  if (!parsed.minExchangesProvided) {
    return "--apply требует явный --min-exchanges 1..5 (оператор должен выбрать консенсус; dry-run показывает UNAPPROVED)";
  }
  if (!parsed.minimumQuoteVolumeProvided) {
    return "--apply требует явный --minimum-quote-volume-24h >=0 (оператор должен выбрать; dry-run показывает UNAPPROVED)";
  }
  if (!parsed.top100OnlyProvided) {
    return "--apply требует явный --top100-only true|false (оператор должен выбрать universe; dry-run показывает UNAPPROVED)";
  }
  // Values already validated in parser, but double-check
  if (parsed.minExchanges === null) {
    return "--min-exchanges значение некорректно";
  }
  if (parsed.minimumQuoteVolume24h === null) {
    return "--minimum-quote-volume-24h значение некорректно";
  }
  if (parsed.top100Only === null) {
    return "--top100-only значение некорректно";
  }
  return null;
}

export function buildCanonicalConfig(
  filters: { minimumQuoteVolume24h: number; top500Only: boolean },
) {
  return {
    minimumSignalScore: CANONICAL_SMC_CONFIG.minimumSignalScore,
    swingLeft: CANONICAL_SMC_CONFIG.swingLeft,
    swingRight: CANONICAL_SMC_CONFIG.swingRight,
    internalLeft: CANONICAL_SMC_CONFIG.internalLeft,
    internalRight: CANONICAL_SMC_CONFIG.internalRight,
    atrPeriod: CANONICAL_SMC_CONFIG.atrPeriod,
    structureEventFreshBars: CANONICAL_SMC_CONFIG.structureEventFreshBars,
    sweepFreshBars: CANONICAL_SMC_CONFIG.sweepFreshBars,
    orderBlockFreshBars: CANONICAL_SMC_CONFIG.orderBlockFreshBars,
    fvgFreshBars: CANONICAL_SMC_CONFIG.fvgFreshBars,
    eqBand: CANONICAL_SMC_CONFIG.eqBand,
    weights: { ...CANONICAL_SMC_CONFIG.weights },
    filters: {
      minimumQuoteVolume24h: filters.minimumQuoteVolume24h,
      top500Only: filters.top500Only,
    },
  };
}

/**
 * Build intended Strategy row payload.
 * For dry-run without operator params, use UNAPPROVED placeholders for display,
 * but still produce canonical SMC fields for UX verification.
 */
export function buildSeedPayload(parsed: ParsedSeedArgs): {
  ok: true;
  payload: Record<string, unknown>;
  warnings: string[];
} | {
  ok: false;
  errors: string[];
} {
  if (parsed.errors.length > 0) {
    return { ok: false, errors: [...parsed.errors] };
  }

  const isApply = parsed.apply;
  // For dry-run, allow placeholders; for apply, require all
  const applyError = isApply ? validateForApply(parsed) : null;
  if (applyError) {
    return { ok: false, errors: [applyError] };
  }

  const warnings: string[] = [];

  // Prepare operator values or UNAPPROVED placeholders for dry-run
  let minExchangesToUse: number | string;
  let volumeToUse: number | string;
  let topOnlyToUse: boolean | string;

  if (parsed.minExchangesProvided && parsed.minExchanges !== null) {
    minExchangesToUse = parsed.minExchanges;
  } else if (!isApply) {
    minExchangesToUse = "UNAPPROVED — требуется --min-exchanges 1..5";
    warnings.push("minExchanges: UNAPPROVED — оператор должен явно указать --min-exchanges для --apply");
  } else {
    // apply without provided already handled above, but keep error
    return { ok: false, errors: ["--min-exchanges missing"] };
  }

  if (parsed.minimumQuoteVolumeProvided && parsed.minimumQuoteVolume24h !== null) {
    volumeToUse = parsed.minimumQuoteVolume24h;
  } else if (!isApply) {
    volumeToUse = "UNAPPROVED — требуется --minimum-quote-volume-24h";
    warnings.push("filters.minimumQuoteVolume24h: UNAPPROVED — оператор должен явно указать");
  } else {
    return { ok: false, errors: ["--minimum-quote-volume-24h missing"] };
  }

  if (parsed.top100OnlyProvided && parsed.top100Only !== null) {
    topOnlyToUse = parsed.top100Only;
  } else if (!isApply) {
    topOnlyToUse = "UNAPPROVED — требуется --top100-only true|false";
    warnings.push("filters.top500Only: UNAPPROVED — оператор должен явно указать --top100-only");
  } else {
    return { ok: false, errors: ["--top100-only missing"] };
  }

  // For dry-run placeholders, use fallback numeric for config that still shows canonical structure
  // But payload's filters will show UNAPPROVED strings to signal need for operator choice.
  // For validation in dry-run with placeholders, we skip runtime validation; for apply we validate.
  const payload: Record<string, unknown> = {
    slug: SMART_MONEY_SLUG,
    name: SMART_MONEY_NAME,
    version: SMART_MONEY_VERSION,
    enabled: SMART_MONEY_ENABLED,
    status: SMART_MONEY_STATUS,
    description: CANONICAL_DESCRIPTION,
    timeframes: [...SMART_MONEY_TIMEFRAMES],
    minExchanges: minExchangesToUse,
    config:
      typeof volumeToUse === "number" && typeof topOnlyToUse === "boolean"
        ? buildCanonicalConfig({
            minimumQuoteVolume24h: volumeToUse,
            top500Only: topOnlyToUse,
          })
        : {
            minimumSignalScore: CANONICAL_SMC_CONFIG.minimumSignalScore,
            swingLeft: CANONICAL_SMC_CONFIG.swingLeft,
            swingRight: CANONICAL_SMC_CONFIG.swingRight,
            internalLeft: CANONICAL_SMC_CONFIG.internalLeft,
            internalRight: CANONICAL_SMC_CONFIG.internalRight,
            atrPeriod: CANONICAL_SMC_CONFIG.atrPeriod,
            structureEventFreshBars: CANONICAL_SMC_CONFIG.structureEventFreshBars,
            sweepFreshBars: CANONICAL_SMC_CONFIG.sweepFreshBars,
            orderBlockFreshBars: CANONICAL_SMC_CONFIG.orderBlockFreshBars,
            fvgFreshBars: CANONICAL_SMC_CONFIG.fvgFreshBars,
            eqBand: CANONICAL_SMC_CONFIG.eqBand,
            weights: { ...CANONICAL_SMC_CONFIG.weights },
            filters: {
              minimumQuoteVolume24h: volumeToUse,
              top500Only: topOnlyToUse,
            },
          },
  };

  return { ok: true, payload, warnings };
}

export function canonicalWeightsSum(): number {
  const w = CANONICAL_SMC_CONFIG.weights;
  return Object.values(w).reduce((a, b) => a + b, 0);
}
