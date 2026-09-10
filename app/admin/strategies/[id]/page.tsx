import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import StrategyEditor from "@/components/admin/StrategyEditor";
import AdminNav from "@/components/admin/AdminNav";

export default async function Page({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  const { id } = await params;

  const strategy =
    await prisma.strategy.findUnique({
      where: {
        id: Number(id)
      }
    });

  if (!strategy) {
    notFound();
  }

  return (
    <main className="shell">
      <AdminNav active="strategies" />

      <StrategyEditor
        strategy={{
          id: strategy.id,
          name: strategy.name,
          description:
            strategy.description,
          version: strategy.version,
          enabled: strategy.enabled,
          status: strategy.status,
          minExchanges:
            strategy.minExchanges,
          timeframes:
            strategy.timeframes,
          config:
            strategy.config as any
        }}
      />
    </main>
  );
}
