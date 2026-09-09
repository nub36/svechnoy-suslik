"use client";

import { useState } from "react";

type Config = {
  minimumSignalScore: number;

  weights: {
    trend: number;
    mediumTrend: number;
    rsi: number;
    macd: number;
    volume: number;
  };

  ema: {
    fast: number;
    medium: number;
    slow: number;
  };

  rsi: {
    period: number;
    longMin: number;
    longMax: number;
    shortMin: number;
    shortMax: number;
  };

  macd: {
    fast: number;
    slow: number;
    signal: number;
  };

  atr: {
    period: number;
    stopMultiplier: number;
    takeProfit1Multiplier: number;
    takeProfit2Multiplier: number;
    takeProfit3Multiplier: number;
  };

  volume: {
    period: number;
    minimumRatio: number;
  };

  execution: {
    closedCandleOnly: boolean;
    cooldownCandles: number;
  };

  filters: {
    minimumQuoteVolume24h: number;
    top500Only: boolean;
  };
};

type Props = {
  strategy: {
    id: number;
    name: string;
    description: string;
    version: number;
    enabled: boolean;
    status: string;
    minExchanges: number;
    timeframes: string[];
    config: Config;
  };
};

function NumberField({
  label,
  description,
  value,
  onChange,
  step = "1"
}: {
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
  step?: string;
}) {
  return (
    <label className="settingField">
      <span>
        <b>{label}</b>
        <small>{description}</small>
      </span>

      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) =>
          onChange(Number(e.target.value))
        }
      />
    </label>
  );
}

export default function StrategyEditor({
  strategy
}: Props) {
  const [config, setConfig] =
    useState<Config>(strategy.config);

  const [enabled, setEnabled] =
    useState(strategy.enabled);

  const [minExchanges, setMinExchanges] =
    useState(strategy.minExchanges);

  const [timeframes, setTimeframes] =
    useState(strategy.timeframes);

  const [message, setMessage] =
    useState("");

  const [saving, setSaving] =
    useState(false);

  function updateSection<
    K extends keyof Config
  >(
    section: K,
    values: Partial<Config[K]>
  ) {
    setConfig((current) => ({
      ...current,
      [section]: {
        ...(current[section] as object),
        ...values
      }
    }));
  }

  function toggleTimeframe(tf: string) {
    setTimeframes((current) =>
      current.includes(tf)
        ? current.filter((x) => x !== tf)
        : [...current, tf]
    );
  }

  async function save() {
    setSaving(true);
    setMessage("");

    try {
      const response = await fetch(
        `/api/admin/strategies/${strategy.id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            enabled,
            minExchanges,
            timeframes,
            config
          })
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        setMessage(
          data.error ||
          "Не удалось сохранить настройки"
        );

        return;
      }

      setMessage(
        "✓ Настройки сохранены в PostgreSQL"
      );
    } catch {
      setMessage(
        "Ошибка соединения с сервером"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="strategyEditor">
      <section className="editorHero">
        <div>
          <div className="editorBadges">
            <span>
              Версия {strategy.version}
            </span>

            <span>
              {strategy.status === "PUBLISHED"
                ? "Опубликована"
                : strategy.status}
            </span>
          </div>

          <h1>{strategy.name}</h1>

          <p>{strategy.description}</p>
        </div>

        <label className="switchLabel">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) =>
              setEnabled(e.target.checked)
            }
          />

          <span>
            {enabled
              ? "Стратегия включена"
              : "Стратегия выключена"}
          </span>
        </label>
      </section>

      <section className="editorSection">
        <h2>Общие настройки</h2>

        <NumberField
          label="Минимальная сила сигнала"
          description="Сигнал LONG или SHORT публикуется только при достижении этого количества баллов."
          value={
            config.minimumSignalScore
          }
          onChange={(value) =>
            setConfig({
              ...config,
              minimumSignalScore: value
            })
          }
        />

        <NumberField
          label="Подтверждение бирж"
          description="Сколько из пяти бирж должны независимо подтвердить одинаковое направление."
          value={minExchanges}
          onChange={setMinExchanges}
        />

        <div className="settingBlock">
          <b>Рабочие таймфреймы</b>

          <small>
            На каких периодах стратегия
            будет искать сигналы.
          </small>

          <div className="timeframeSelector">
            {[
              "5m",
              "15m",
              "1h",
              "4h",
              "1d"
            ].map((tf) => (
              <button
                type="button"
                key={tf}
                className={
                  timeframes.includes(tf)
                    ? "tfActive"
                    : ""
                }
                onClick={() =>
                  toggleTimeframe(tf)
                }
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="editorSection">
        <h2>EMA — направление тренда</h2>

        <p className="sectionDescription">
          Три экспоненциальные средние
          определяют быстрый, средний и
          основной тренд.
        </p>

        <NumberField
          label="Быстрая EMA"
          description="Чувствительная средняя для краткосрочного движения."
          value={config.ema.fast}
          onChange={(value) =>
            updateSection(
              "ema",
              { fast: value }
            )
          }
        />

        <NumberField
          label="Средняя EMA"
          description="Используется для подтверждения среднего направления."
          value={config.ema.medium}
          onChange={(value) =>
            updateSection(
              "ema",
              { medium: value }
            )
          }
        />

        <NumberField
          label="Медленная EMA"
          description="Основной фильтр долгосрочного тренда."
          value={config.ema.slow}
          onChange={(value) =>
            updateSection(
              "ema",
              { slow: value }
            )
          }
        />
      </section>

      <section className="editorSection">
        <h2>RSI — импульс</h2>

        <NumberField
          label="Период RSI"
          description="Количество свечей для расчёта RSI."
          value={config.rsi.period}
          onChange={(value) =>
            updateSection(
              "rsi",
              { period: value }
            )
          }
        />

        <div className="fieldGrid">
          <NumberField
            label="LONG от"
            description="Минимальный RSI для LONG."
            value={config.rsi.longMin}
            onChange={(value) =>
              updateSection(
                "rsi",
                { longMin: value }
              )
            }
          />

          <NumberField
            label="LONG до"
            description="Максимальный RSI для LONG."
            value={config.rsi.longMax}
            onChange={(value) =>
              updateSection(
                "rsi",
                { longMax: value }
              )
            }
          />

          <NumberField
            label="SHORT от"
            description="Минимальный RSI для SHORT."
            value={config.rsi.shortMin}
            onChange={(value) =>
              updateSection(
                "rsi",
                { shortMin: value }
              )
            }
          />

          <NumberField
            label="SHORT до"
            description="Максимальный RSI для SHORT."
            value={config.rsi.shortMax}
            onChange={(value) =>
              updateSection(
                "rsi",
                { shortMax: value }
              )
            }
          />
        </div>
      </section>

      <section className="editorSection">
        <h2>MACD</h2>

        <div className="fieldGrid">
          <NumberField
            label="Fast"
            description="Быстрый период."
            value={config.macd.fast}
            onChange={(value) =>
              updateSection(
                "macd",
                { fast: value }
              )
            }
          />

          <NumberField
            label="Slow"
            description="Медленный период."
            value={config.macd.slow}
            onChange={(value) =>
              updateSection(
                "macd",
                { slow: value }
              )
            }
          />

          <NumberField
            label="Signal"
            description="Период сигнальной линии."
            value={config.macd.signal}
            onChange={(value) =>
              updateSection(
                "macd",
                { signal: value }
              )
            }
          />
        </div>
      </section>

      <section className="editorSection">
        <h2>Веса условий</h2>

        <p className="sectionDescription">
          Определяют вклад каждого
          подтверждения в итоговую силу
          сигнала.
        </p>

        <div className="fieldGrid">
          {[
            ["trend", "Основной тренд"],
            [
              "mediumTrend",
              "Краткосрочный тренд"
            ],
            ["rsi", "RSI"],
            ["macd", "MACD"],
            ["volume", "Объём"]
          ].map(([key, title]) => (
            <NumberField
              key={key}
              label={title}
              description="Баллы условия."
              value={
                config.weights[
                  key as keyof typeof config.weights
                ]
              }
              onChange={(value) =>
                updateSection(
                  "weights",
                  {
                    [key]: value
                  }
                )
              }
            />
          ))}
        </div>

        <div className="scoreTotal">
          Сумма весов:{" "}
          <b>
            {Object.values(
              config.weights
            ).reduce(
              (sum, x) => sum + x,
              0
            )}
          </b>
        </div>
      </section>

      <section className="editorSection">
        <h2>ATR и управление риском</h2>

        <NumberField
          label="Период ATR"
          description="Период измерения текущей волатильности."
          value={config.atr.period}
          onChange={(value) =>
            updateSection(
              "atr",
              { period: value }
            )
          }
        />

        <div className="fieldGrid">
          <NumberField
            label="Stop Loss × ATR"
            description="Расстояние до стопа."
            value={
              config.atr.stopMultiplier
            }
            step="0.1"
            onChange={(value) =>
              updateSection(
                "atr",
                {
                  stopMultiplier:
                    value
                }
              )
            }
          />

          <NumberField
            label="TP1 × ATR"
            description="Первая цель."
            value={
              config.atr
                .takeProfit1Multiplier
            }
            step="0.1"
            onChange={(value) =>
              updateSection(
                "atr",
                {
                  takeProfit1Multiplier:
                    value
                }
              )
            }
          />

          <NumberField
            label="TP2 × ATR"
            description="Вторая цель."
            value={
              config.atr
                .takeProfit2Multiplier
            }
            step="0.1"
            onChange={(value) =>
              updateSection(
                "atr",
                {
                  takeProfit2Multiplier:
                    value
                }
              )
            }
          />

          <NumberField
            label="TP3 × ATR"
            description="Третья цель."
            value={
              config.atr
                .takeProfit3Multiplier
            }
            step="0.1"
            onChange={(value) =>
              updateSection(
                "atr",
                {
                  takeProfit3Multiplier:
                    value
                }
              )
            }
          />
        </div>
      </section>

      <section className="editorSection">
        <h2>Объём и фильтры</h2>

        <NumberField
          label="Период среднего объёма"
          description="Количество свечей для среднего объёма."
          value={config.volume.period}
          onChange={(value) =>
            updateSection(
              "volume",
              { period: value }
            )
          }
        />

        <NumberField
          label="Минимальный относительный объём"
          description="1.0 = текущий объём не ниже среднего. 1.5 = на 50% выше среднего."
          value={
            config.volume.minimumRatio
          }
          step="0.1"
          onChange={(value) =>
            updateSection(
              "volume",
              {
                minimumRatio: value
              }
            )
          }
        />

        <NumberField
          label="Минимальный объём рынка 24ч"
          description="Пары с меньшим оборотом USDT не анализируются."
          value={
            config.filters
              .minimumQuoteVolume24h
          }
          onChange={(value) =>
            updateSection(
              "filters",
              {
                minimumQuoteVolume24h:
                  value
              }
            )
          }
        />

        <label className="checkSetting">
          <input
            type="checkbox"
            checked={
              config.filters.top500Only
            }
            onChange={(e) =>
              updateSection(
                "filters",
                {
                  top500Only:
                    e.target.checked
                }
              )
            }
          />

          <span>
            <b>
              Анализировать только Top-500
            </b>

            <small>
              Ограничивает автоматический
              сканер нашим рейтингом
              ликвидности.
            </small>
          </span>
        </label>
      </section>

      <section className="editorSection">
        <h2>Исполнение сигнала</h2>

        <label className="checkSetting">
          <input
            type="checkbox"
            checked={
              config.execution
                .closedCandleOnly
            }
            onChange={(e) =>
              updateSection(
                "execution",
                {
                  closedCandleOnly:
                    e.target.checked
                }
              )
            }
          />

          <span>
            <b>
              Только закрытая свеча
            </b>

            <small>
              Защищает от сигналов,
              исчезающих до закрытия
              текущей свечи.
            </small>
          </span>
        </label>

        <NumberField
          label="Cooldown"
          description="Сколько свечей ждать до повторного сигнала того же типа."
          value={
            config.execution
              .cooldownCandles
          }
          onChange={(value) =>
            updateSection(
              "execution",
              {
                cooldownCandles:
                  value
              }
            )
          }
        />
      </section>

      <div className="editorSaveBar">
        <div>
          {message && (
            <span>{message}</span>
          )}
        </div>

        <button
          onClick={save}
          disabled={saving}
        >
          {saving
            ? "Сохранение..."
            : "Сохранить настройки"}
        </button>
      </div>
    </div>
  );
}
