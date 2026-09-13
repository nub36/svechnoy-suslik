import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import ExchangeManagerClient from "./ExchangeManagerClient";

export const dynamic = "force-dynamic";

export default async function AdminExchangesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/");

  let configs: any[] = [];
  try {
    configs = await prisma.exchangeConfig.findMany({ orderBy: [{ priority: "desc" }, { exchange: "asc" }] });
  } catch {
    configs = [
      { exchange: "BINANCE", publicEnabled: true, ohlcvEnabled: true, liveEnabled: true, isDefault: true, priority: 100 },
      { exchange: "BYBIT", publicEnabled: true, ohlcvEnabled: true, liveEnabled: true, isDefault: false, priority: 90 },
      { exchange: "GATE", publicEnabled: true, ohlcvEnabled: true, liveEnabled: true, isDefault: false, priority: 80 },
      { exchange: "KUCOIN", publicEnabled: true, ohlcvEnabled: true, liveEnabled: true, isDefault: false, priority: 70 },
      { exchange: "BINGX", publicEnabled: true, ohlcvEnabled: true, liveEnabled: true, isDefault: false, priority: 60 },
    ];
  }

  return (
    <main className="adminPage">
      <AdminNav active="exchanges" />
      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">Управление биржами</div>
            <h1>Биржи — Public / OHLCV / Live / Default / Priority</h1>
            <p className="muted">
              BINANCE Default true priority 100. Public выключение биржи НЕ должно ломать BTC V1 (5 exchanges quorum 3/5) — V1 использует Market.enabled, не ExchangeConfig.publicEnabled.
              Public Enabled — для публичного сайта TOP-50, OHLCV Enabled — для OHLCV worker, Live Enabled — для live WS, Default — дефолтная биржа, Priority — порядок fallback.
            </p>
          </div>
        </div>

        <ExchangeManagerClient initialConfigs={configs} />
      </section>
    </main>
  );
}
