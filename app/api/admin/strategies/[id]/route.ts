import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { validateTrendSuslikConfig } from "@/lib/strategies/config";

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

  /*
   * Polnaya servernaya validaciya config
 * (te zhe pravila, chto i dlya runtime):
   * weights, ema, rsi, macd (vklyuchaya myortvuyu
   * zonu), atr, volume, execution, filters.
   * Ran'she proveryalsya tolko minimumSignalScore.
   */
  const validation =
    validateTrendSuslikConfig(config);

  if (!validation.ok) {
    return NextResponse.json(
      {
        error:
          "Конфигурация не прошла проверку: " +
          validation.errors.join("; ")
      },
      { status: 400 }
    );
  }

  const minExchanges =
    Number(body.minExchanges);

  if (
    !Number.isInteger(minExchanges) ||
    minExchanges < 1 ||
    minExchanges > 5
  ) {
    return NextResponse.json(
      {
        error:
          "Количество подтверждающих бирж должно быть от 1 до 5"
      },
      { status: 400 }
    );
  }

  const allowedTimeframes =
    ["5m", "15m", "1h", "4h", "1d"];

  const timeframes =
    Array.isArray(body.timeframes)
      ? body.timeframes.filter(
          (x: unknown) =>
            typeof x === "string" &&
            allowedTimeframes.includes(x)
        )
      : [];

  if (!timeframes.length) {
    return NextResponse.json(
      {
        error:
          "Выберите хотя бы один таймфрейм"
      },
      { status: 400 }
    );
  }

  const updated =
    await prisma.strategy.update({
      where: {
        id: strategyId
      },

      data: {
        enabled: Boolean(body.enabled),
        minExchanges,
        timeframes,
        config
      }
    });

  return NextResponse.json(updated);
}
