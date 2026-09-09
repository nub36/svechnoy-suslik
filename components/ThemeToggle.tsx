"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const value = saved ? saved === "dark" : true;

    setDark(value);
    document.documentElement.dataset.theme = value ? "dark" : "light";
  }, []);

  function toggle() {
    const value = !dark;

    setDark(value);
    document.documentElement.dataset.theme = value ? "dark" : "light";
    localStorage.setItem("theme", value ? "dark" : "light");
  }

  return (
    <button className="iconBtn" onClick={toggle} title="Сменить тему">
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
