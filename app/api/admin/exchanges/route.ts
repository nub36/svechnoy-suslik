import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function isAdmin() {
  const { auth } = await import("@/auth");
  const session = await auth();
  return session?.user && session.user.role === "ADMIN";
}

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  }

  try {
    const { prisma } = await import("@/lib/prisma");
    let configs;
    try {
      configs = await prisma.exchangeConfig.findMany({ orderBy: [{ priority: "desc" }, { exchange: "asc" }] });
    } catch {
      const { DEFAULT_EXCHANGE_CONFIGS } = await import("@/lib/exchanges/config");
      configs = DEFAULT_EXCHANGE_CONFIGS;
    }
    return NextResponse.json(configs);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  }

  const body = await request.json();
  const exchange = typeof body.exchange === "string" ? body.exchange.toUpperCase() : "";
  const publicEnabled = typeof body.publicEnabled === "boolean" ? body.publicEnabled : undefined;
  const ohlcvEnabled = typeof body.ohlcvEnabled === "boolean" ? body.ohlcvEnabled : undefined;
  const liveEnabled = typeof body.liveEnabled === "boolean" ? body.liveEnabled : undefined;
  const isDefault = typeof body.isDefault === "boolean" ? body.isDefault : undefined;
  const priority = typeof body.priority === "number" ? body.priority : undefined;

  if (!exchange) {
    return NextResponse.json({ error: "exchange required" }, { status: 400 });
  }

  const allowed = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];
  if (!allowed.includes(exchange)) {
    return NextResponse.json({ error: `exchange must be one of ${allowed.join(", ")}` }, { status: 400 });
  }

  try {
    const { prisma } = await import("@/lib/prisma");

    // If setting isDefault true, clear other defaults
    if (isDefault === true) {
      await prisma.exchangeConfig.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }

    const data: Record<string, unknown> = {};
    if (publicEnabled !== undefined) data.publicEnabled = publicEnabled;
    if (ohlcvEnabled !== undefined) data.ohlcvEnabled = ohlcvEnabled;
    if (liveEnabled !== undefined) data.liveEnabled = liveEnabled;
    if (isDefault !== undefined) data.isDefault = isDefault;
    if (priority !== undefined) data.priority = priority;

    // Safety: if disabling public for BINANCE, ensure BTC V1 still has 5 exchanges?
    // BTC V1 uses 5 exchanges quorum 3/5 — public disable must not break V1
    // V1 uses Market.enabled not ExchangeConfig.publicEnabled, so public disable is safe
    // But we warn if trying to disable BINANCE public
    if (exchange === "BINANCE" && publicEnabled === false) {
      // Allow but log warning — BTC V1 still uses 5 exchanges via ohlcvEnabled, not publicEnabled
      console.warn("[ExchangeConfig] BINANCE publicEnabled set to false — public site will fallback, but BTC V1 (5 exchanges quorum 3/5) remains via ohlcvEnabled");
    }

    const updated = await prisma.exchangeConfig.upsert({
      where: { exchange },
      update: data,
      create: {
        exchange,
        publicEnabled: publicEnabled ?? true,
        ohlcvEnabled: ohlcvEnabled ?? true,
        liveEnabled: liveEnabled ?? true,
        isDefault: isDefault ?? exchange === "BINANCE",
        priority: priority ?? (exchange === "BINANCE" ? 100 : 90),
      },
    });

    return NextResponse.json(updated);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
