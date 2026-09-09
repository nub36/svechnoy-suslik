import Link from "next/link";
import { Search } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import UserMenu from "./UserMenu";

export default function Header() {
  return (
    <header className="header">
      <Link href="/" className="brand">
        <span className="brandMark">🐿️</span>
        Свечной Суслик
      </Link>

      <nav className="nav">
        <Link href="/">Рынок</Link>
        <Link href="/signals">Сигналы</Link>
        <Link href="/strategies">Стратегии</Link>
      </nav>

      <div className="actions">
        <button className="iconBtn" title="Поиск">
          <Search size={18} />
        </button>

        <ThemeToggle />

        <UserMenu />
      </div>
    </header>
  );
}
