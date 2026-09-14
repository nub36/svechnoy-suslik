import { NextResponse } from "next/server";
import { validateTrendSuslikConfig } from "@/lib/strategies/config";
import { validateSmartMoneyRuntime } from "@/lib/strategies/smart-money";
import { normalizeV2Config, validateV2Config } from "@/lib/strategies/smart-money-v2";

export const dynamic = "force-dynamic";

async function isAdmin() {
  const { auth } = await import("@/auth");
  const session = await auth();
  return session?.user && session.user.role === "ADMIN";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  }
  const { id } = await context.params;
  const { prisma } = await import("@/lib/prisma");
  const strategy = await prisma.strategy.findUnique({ where: { id: Number(id) } });
  if (!strategy) {
    return NextResponse.json({ error: "Стратегия не найдена" }, { status: 404 });
  }
  return NextResponse.json(strategy);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  }
  const { id } = await context.params;
  const strategyId = Number(id);
  if (!Number.isInteger(strategyId)) {
    return NextResponse.json({ error: "Неверный ID стратегии" }, { status: 400 });
  }
  const body = await request.json();
  const config = body.config;
  if (!config) {
    return NextResponse.json({ error: "Отсутствует конфигурация" }, { status: 400 });
  }

  // Discriminate validation by existing.slug from DB, not by body.slug.
  const { prisma } = await import("@/lib/prisma");
  const existing = await prisma.strategy.findUnique({ where: { id: strategyId } });
  if (!existing) {
    return NextResponse.json({ error: "Стратегия не найдена" }, { status: 404 });
  }

  const rawTimeframes = body.timeframes;
  const rawMinExchanges = body.minExchanges;

  if (existing.slug === "trend-suslik") {
    const validation = validateTrendSuslikConfig(config);
    if (!validation.ok) {
      return NextResponse.json(
        { error: "Конфигурация не прошла проверку: " + validation.errors.join("; ") },
        { status: 400 }
      );
    }
    const minExchanges = Number(rawMinExchanges);
    if (!Number.isInteger(minExchanges) || minExchanges < 1 || minExchanges > 5) {
      return NextResponse.json({ error: "Количество подтверждающих бирж должно быть от 1 до 5" }, { status: 400 });
    }
    const allowedTimeframes = ["5m", "15m", "1h", "4h", "1d"];
    const timeframes = Array.isArray(rawTimeframes)
      ? rawTimeframes.filter((x: unknown) => typeof x === "string" && allowedTimeframes.includes(x as string))
      : [];
    if (!timeframes.length) {
      return NextResponse.json({ error: "Выберите хотя бы один таймфрейм" }, { status: 400 });
    }
    const updated = await prisma.strategy.update({
      where: { id: strategyId },
      data: { enabled: Boolean(body.enabled), minExchanges, timeframes, config },
    });
    return NextResponse.json(updated);
  }

  if (existing.slug === "smart-money-suslik") {
    const runtimeValidation = validateSmartMoneyRuntime({ config, timeframes: rawTimeframes, minExchanges: rawMinExchanges });
    if (!runtimeValidation.ok) {
      return NextResponse.json(
        { error: "Конфигурация не прошла проверку: " + runtimeValidation.errors.join("; ") },
        { status: 400 }
      );
    }
    const verifiedTF = runtimeValidation.timeframes;
    const allowedVerified = new Set(["5m", "15m", "1h", "4h", "1d"]);
    if (verifiedTF.length === 0) {
      return NextResponse.json({ error: "Выберите хотя бы один таймфрейм" }, { status: 400 });
    }
    const hasDisallowed = verifiedTF.some((tf) => !allowedVerified.has(tf as string));
    if (hasDisallowed) {
      return NextResponse.json(
        { error: "timeframes: недопустимые значения: " + verifiedTF.filter((tf) => !allowedVerified.has(tf as string)).join(", ") },
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

  if (existing.slug === "smart-money-v2") {
    // ONE effective operating mode — DB column mode is authoritative
    // Bug was: strategy.mode=FORWARD_TEST but config.mode=DISABLED stale, engine used config.mode
    const rawMode = typeof body.mode === "string" ? body.mode : (config as any).mode || (existing as any).mode || "DISABLED";
    if (rawMode === "LIVE") {
      return NextResponse.json(
        { error: "LIVE режим запрещён в этой задаче — используйте DISABLED/DRY_RUN/FORWARD_TEST, LIVE gated" },
        { status: 400 }
      );
    }
    const v2Config = normalizeV2Config(config);
    // Ensure config JSON mode matches authoritative column mode — single source of truth
    (v2Config as any).mode = rawMode;

    const runtimeValidation = validateV2Config(v2Config, rawTimeframes, rawMinExchanges);
    if (runtimeValidation.length > 0) {
      return NextResponse.json(
        { error: "Конфигурация V2 не прошла проверку: " + runtimeValidation.join("; ") },
        { status: 400 }
      );
    }
    const verifiedTF = Array.isArray(rawTimeframes)
      ? rawTimeframes.filter((x: unknown) => typeof x === "string" && ["5m", "15m", "1h", "4h", "1d"].includes(x as string))
      : [];
    if (verifiedTF.length === 0) {
      return NextResponse.json({ error: "Выберите хотя бы один таймфрейм" }, { status: 400 });
    }
    const minEx = Number(rawMinExchanges);
    if (!Number.isInteger(minEx) || minEx < 1 || minEx > 5) {
      return NextResponse.json({ error: "Количество подтверждающих бирж должно быть от 1 до 5" }, { status: 400 });
    }
    const updated = await prisma.strategy.update({
      where: { id: strategyId },
      data: {
        enabled: Boolean(body.enabled),
        mode: rawMode,
        minExchanges: minEx,
        timeframes: verifiedTF,
        config: v2Config as any,
      },
    });
    return NextResponse.json(updated);
  }

  return NextResponse.json(
    { error: `Стратегия с slug "${existing.slug}" не поддерживается текущим API (требуется обновление)` },
    { status: 400 }
  );
}
