import Link from "next/link";
import ThemeToggle from "./ThemeToggle";
import UserMenu from "./UserMenu";
import SearchBox from "./SearchBox";

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
        <SearchBox />

        <ThemeToggle />

        <UserMenu />
      </div>
    </header>
  );
}
