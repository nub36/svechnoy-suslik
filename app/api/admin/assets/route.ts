import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function isAdmin() {
  const { auth } = await import("@/auth");
  const session = await auth();
  return session?.user && session.user.role === "ADMIN";
}

export async function POST(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  }

  const body = await request.json();
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const name = typeof body.name === "string" ? body.name : undefined;
  const rank = typeof body.rank === "number" ? body.rank : undefined;

  if (!symbol) {
    return NextResponse.json({ error: "Symbol required" }, { status: 400 });
  }

  try {
    const { addCoin } = await import("@/lib/assets/service");
    const result = await addCoin({ symbol, name, rank });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "";

  if (!symbol) {
    return NextResponse.json({ error: "Symbol query param required" }, { status: 400 });
  }

  try {
    const { archiveCoin } = await import("@/lib/assets/service");
    const result = await archiveCoin(symbol);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  }

  try {
    const { prisma } = await import("@/lib/prisma");
    const assets = await prisma.asset.findMany({
      where: { archivedAt: null },
      orderBy: { rank: "asc" },
      take: 100,
      select: { id: true, symbol: true, name: true, rank: true, enabled: true, archivedAt: true, createdAt: true },
    });
    return NextResponse.json(assets);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
