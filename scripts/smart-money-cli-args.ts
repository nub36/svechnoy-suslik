/**
 * Pure CLI args parser for Smart Money — side-effect-free.
 * No DB, no imports of strategies, no main() side effect.
 * Используется и CLI, и тестами без риска запуска CLI при импорте.
 */

export type Args = {
  symbol: string | null;
  marketId: number | null;
  timeframe: string;
  selfTest: boolean;
  help: boolean;
};

/**
 * Чистый парсер CLI — без побочек БД, детерминирован, тестируем.
 * Поддерживает ОБЕ формы:
 *   --symbol BTC  и  --symbol=BTC
 *   --market-id 123, --market-id=123, а также legacy --marketId
 *   --timeframe 1h и --timeframe=1h
 * Флаги --self-test и --help — boolean.
 * Не поглощает следующий флаг как значение (требует точного разделения).
 */
export function parseSmartMoneyArgs(argv: string[]): {
  args: Args;
  errors: string[];
  symbolProvided: boolean;
  marketIdProvided: boolean;
} {
  let symbol: string | null = null;
  let marketId: number | null = null;
  let timeframe = "1h";
  let selfTest = false;
  let help = false;
  const errors: string[] = [];
  let symbolProvided = false;
  let marketIdProvided = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--self-test") {
      selfTest = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--symbol") {
      symbolProvided = true;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        errors.push(
          "--symbol требует значение (например --symbol BTC или --symbol=BTC)"
        );
      } else {
        symbol = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--symbol=")) {
      symbolProvided = true;
      const value = arg.slice("--symbol=".length);
      if (value === "" || value.startsWith("-")) {
        errors.push(
          "--symbol требует значение (например --symbol BTC или --symbol=BTC)"
        );
      } else {
        symbol = value;
      }
      continue;
    }

    if (arg === "--market-id" || arg === "--marketId") {
      marketIdProvided = true;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        errors.push(
          "--market-id требует числовое значение (например --market-id 123 или --market-id=123)"
        );
      } else {
        if (!/^\d+$/.test(next)) {
          errors.push(
            `--market-id значение "${next}" не является положительным целым числом`
          );
        } else {
          const n = Number(next);
          if (!Number.isInteger(n) || n <= 0) {
            errors.push(
              `--market-id значение "${next}" должно быть положительным целым`
            );
          } else {
            marketId = n;
          }
        }
        i++;
      }
      continue;
    }
    if (
      arg.startsWith("--market-id=") ||
      arg.startsWith("--marketId=")
    ) {
      marketIdProvided = true;
      const value = arg.startsWith("--market-id=")
        ? arg.slice("--market-id=".length)
        : arg.slice("--marketId=".length);
      if (value === "" || value.startsWith("-")) {
        errors.push(
          "--market-id требует числовое значение (например --market-id 123 или --market-id=123)"
        );
      } else if (!/^\d+$/.test(value)) {
        errors.push(
          `--market-id значение "${value}" не является положительным целым числом`
        );
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          errors.push(
            `--market-id значение "${value}" должно быть положительным целым`
          );
        } else {
          marketId = n;
        }
      }
      continue;
    }

    if (arg === "--timeframe") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        errors.push(
          "--timeframe требует значение (например --timeframe 1h или --timeframe=1h)"
        );
      } else {
        timeframe = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--timeframe=")) {
      const value = arg.slice("--timeframe=".length);
      if (value === "" || value.startsWith("-")) {
        errors.push(
          "--timeframe требует значение (например --timeframe 1h или --timeframe=1h)"
        );
      } else {
        timeframe = value;
      }
      continue;
    }

    if (arg.startsWith("--")) {
      errors.push(`неизвестный флаг ${arg}`);
      continue;
    }

    errors.push(`неожиданный аргумент ${arg}`);
  }

  return {
    args: { symbol, marketId, timeframe, selfTest, help },
    errors,
    symbolProvided,
    marketIdProvided,
  };
}

/**
 * Валидация CLI-аргументов без БД.
 * Возвращает строку ошибки или null если всё корректно.
 */
export function validateCliArgs(
  parsed: ReturnType<typeof parseSmartMoneyArgs>
): string | null {
  if (parsed.errors.length > 0) {
    return parsed.errors[0];
  }
  const { args } = parsed;
  if (args.help || args.selfTest) {
    return null;
  }
  const hasSymbol = parsed.symbolProvided;
  const hasMarketId = parsed.marketIdProvided;
  if (hasSymbol && hasMarketId) {
    return "укажите ровно один из --symbol или --market-id (оба указаны)";
  }
  if (!hasSymbol && !hasMarketId) {
    return "требуется ровно один из --symbol или --market-id (никакого default Top-100 скана)";
  }
  if (hasSymbol && (args.symbol === null || args.symbol.trim() === "")) {
    return "--symbol требует непустое значение";
  }
  if (hasMarketId && args.marketId === null) {
    return "--market-id требует положительное целое число";
  }
  return null;
}
