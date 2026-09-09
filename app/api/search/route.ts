import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Поиск активов для шапки сайта.
 * Только чтение PostgreSQL Asset; никаких внешних API.
 */

export async function GET(
  request: Request
) {
  const { searchParams } = new URL(
    request.url
  );

  const query = searchParams
    .get("q")
    ?.trim()
    .toUpperCase();

  if (!query || query.length < 1) {
    return NextResponse.json({
      results: []
    });
  }

  try {
    const { prisma } = await import(
      "@/lib/prisma"
    );

    const assets = await prisma.asset.findMany({
      where: {
        enabled: true,
        OR: [
          { symbol: { startsWith: query } },
          { name: { contains: query } }
        ]
      },
      orderBy: [
        { rank: "asc" }
      ],
      take: 8,
      select: {
        symbol: true,
        name: true,
        rank: true
      }
    });

    return NextResponse.json({
      results: assets.map(
        (a: {
          symbol: string;
          name: string | null;
          rank: number | null;
        }) => ({
          symbol: a.symbol,
          name: a.name,
          rank: a.rank
        })
      )
    });
  } catch (error) {
    // Техническая причина — в server-лог; клиенту —
    // безопасное сообщение без stack/secrets.
    console.error(
      "[api/search] Ошибка поиска активов:",
      error
    );

    return NextResponse.json(
      { error: "База данных временно недоступна" },
      { status: 503 }
    );
  }
}
