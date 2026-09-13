import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import AssetManagerClient from "./AssetManagerClient";

export const dynamic = "force-dynamic";

export default async function AdminAssetsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/");

  const assets = await prisma.asset.findMany({
    where: { archivedAt: null },
    orderBy: { rank: "asc" },
    take: 100,
    include: {
      markets: {
        where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
        select: { exchange: true, exchangeSymbol: true },
      },
    },
  });

  const top50Count = assets.filter((a: any) => a.rank !== null && a.rank >= 1 && a.rank <= 50).length;

  return (
    <main className="adminPage">
      <AdminNav active="assets" />
      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">TOP-50 Публичный</div>
            <h1>Активы — TOP-50 из Asset rank</h1>
            <p className="muted">
              Публичный сайт формируется из Asset rank 1..50 в DB, не хардкод. BINANCE default exchange, fallback по priority.
              TOP-50 в БД: {top50Count} активов. Добавить монету: Symbol, Name, Rank optional + discovery markets BINANCE first.
              Архивация — soft delete (archivedAt), OHLCV/Signals/Outcomes сохраняются.
            </p>
          </div>
        </div>

        <AssetManagerClient initialAssets={assets as any} />
      </section>
    </main>
  );
}
