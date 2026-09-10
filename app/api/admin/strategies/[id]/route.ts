import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { validateTrendSuslikConfig } from "@/lib/strategies/config";
import { validateSmartMoneyRuntime } from "@/lib/strategies/smart-money";

async function isAdmin() {
  const session = await auth();

  return (
    session?.user &&
    session.user.role === "ADMIN"
  );
}

export async function GET(
  request: Request,
  context: {
    params: Promise<{ id: string }>;
  }
) {
  if (!(await isAdmin())) {
    return NextResponse.json(
      { error: "Доступ запрещён" },
      { status: 403 }
    );
  }

  const { id } = await context.params;

  const strategy =
    await prisma.strategy.findUnique({
      where: {
        id: Number(id)
      }
    });

  if (!strategy) {
    return NextResponse.json(
      { error: "Стратегия не найдена" },
      { status: 404 }
    );
  }

  return NextResponse.json(strategy);
}

export async function PUT(
  request: Request,
  context: {
    params: Promise<{ id: string }>;
  }
) {
  if (!(await isAdmin())) {
    return NextResponse.json(
      { error: "Доступ запрещён" },
      { status: 403 }
    );
  }

  const { id } = await context.params;

  const strategyId = Number(id);

  if (!Number.isInteger(strategyId)) {
    return NextResponse.json(
      { error: "Неверный ID стратегии" },
      { status: 400 }
    );
  }

  const body = await request.json();

  const config = body.config;

  if (!config) {
    return NextResponse.json(
      { error: "Отсутствует конфигурация" },
      { status: 400 }
    );
  }

  // Discriminate validation by existing.slug from DB, not by body.slug.
  // Client cannot change slug/version via body — those fields are ignored.
  const existing = await prisma.strategy.findUnique({
    where: { id: strategyId },
  });

  if (!existing) {
    return NextResponse.json(
      { error: "Стратегия не найдена" },
      { status: 404 }
    );
  }

  const rawTimeframes = body.timeframes;
  const rawMinExchanges = body.minExchanges;

  if (existing.slug === "trend-suslik") {
    const validation = validateTrendSuslikConfig(config);
    if (!validation.ok) {
      return NextResponse.json(
        {
          error:
            "Конфигурация не прошла проверку: " +
            validation.errors.join("; "),
        },
        { status: 400 }
      );
    }

    const minExchanges = Number(rawMinExchanges);
    if (!Number.isInteger(minExchanges) || minExchanges < 1 || minExchanges > 5) {
      return NextResponse.json(
        { error: "Количество подтверждающих бирж должно быть от 1 до 5" },
        { status: 400 }
      );
    }

    const allowedTimeframes = ["5m", "15m", "1h", "4h", "1d"];
    const timeframes = Array.isArray(rawTimeframes)
      ? rawTimeframes.filter(
          (x: unknown) => typeof x === "string" && allowedTimeframes.includes(x as string)
        )
      : [];
    if (!timeframes.length) {
      return NextResponse.json(
        { error: "Выберите хотя бы один таймфрейм" },
        { status: 400 }
      );
    }

    const updated = await prisma.strategy.update({
      where: { id: strategyId },
      data: {
        enabled: Boolean(body.enabled),
        minExchanges,
        timeframes,
        config,
      },
    });
    return NextResponse.json(updated);
  }

  if (existing.slug === "smart-money-suslik") {
    // Use canonical Smart Money runtime validator — checks timeframes, minExchanges and config per TF.
    const runtimeValidation = validateSmartMoneyRuntime({
      config,
      timeframes: rawTimeframes,
      minExchanges: rawMinExchanges,
    });
    if (!runtimeValidation.ok) {
      return NextResponse.json(
        {
          error: "Конфигурация не прошла проверку: " + runtimeValidation.errors.join("; "),
        },
        { status: 400 }
      );
    }

    // Phase 3C staged enforcement: only ["1h"] allowed until Phase 3E verification.
    // Rejects crafted PUT before any prisma.strategy.update.
    const stagedTF = runtimeValidation.timeframes;
    if (stagedTF.length !== 1 || stagedTF[0] !== "1h") {
      return NextResponse.json(
        {
          error:
            "Smart Money Phase 3C разрешает только timeframe [\"1h\"] (staged rollout). 5m/15m/4h/1d будут доступны после Phase 3E проверки реальных данных",
        },
        { status: 400 }
      );
    }

    const updated = await prisma.strategy.update({
      where: { id: strategyId },
      data: {
        enabled: Boolean(body.enabled),
        minExchanges: runtimeValidation.minExchanges,
        timeframes: runtimeValidation.timeframes,
        config,
      },
    });
    return NextResponse.json(updated);
  }

  // Unknown slug — safe reject, no fallback to Trend
  return NextResponse.json(
    {
      error: `Стратегия с slug "${existing.slug}" не поддерживается текущим API (требуется обновление)`,
    },
    { status: 400 }
  );
}
