import Link from "next/link";
import {
  Activity,
  BarChart3,
  CandlestickChart,
  Database,
  FlaskConical,
  Gauge,
  SlidersHorizontal,
  Zap
} from "lucide-react";

/**
 * Единая навигация админки.
 *
 * Каждый пункт ведёт на реальную страницу с реальными
 * данными либо (Сигналы) на публичный честный экран.
 * Мёртвых ссылок нет.
 */

const ITEMS: {
  key: string;
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}[] = [
  {
    key: "overview",
    href: "/admin",
    label: "Обзор",
    icon: Gauge
  },
  {
    key: "strategies",
    href: "/admin#strategies",
    label: "Стратегии",
    icon: SlidersHorizontal
  },
  {
    key: "indicators",
    href: "/admin/indicators",
    label: "Индикаторы",
    icon: CandlestickChart
  },
  {
    key: "data",
    href: "/admin/data",
    label: "Источники данных",
    icon: Database
  },
  {
    key: "markets",
    href: "/admin/markets",
    label: "Рынки",
    icon: BarChart3
  },
  {
    key: "backtests",
    href: "/admin/backtests",
    label: "Бэктесты",
    icon: FlaskConical
  },
  {
    key: "signals",
    href: "/signals",
    label: "Сигналы",
    icon: Zap
  },
  {
    key: "monitoring",
    href: "/admin/monitoring",
    label: "Мониторинг",
    icon: Activity
  }
];

export default function AdminNav({
  active
}: {
  active: string;
}) {
  return (
    <aside className="adminNavigation">
      <div className="adminNavTitle">
        Администрирование
      </div>

      {ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = item.key === active;

        return (
          <Link
            key={item.key}
            href={item.href}
            className={
              isActive
                ? "adminNavActive"
                : undefined
            }
          >
            <Icon size={17} />
            {item.label}
          </Link>
        );
      })}
    </aside>
  );
}
