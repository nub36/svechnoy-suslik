"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { LogIn, LogOut, Shield, User } from "lucide-react";

export default function UserMenu() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="userAvatar">•••</div>;
  }

  if (!session?.user) {
    return (
      <Link href="/login" className="loginButton">
        <LogIn size={17} />
        <span>Войти</span>
      </Link>
    );
  }

  const letter = (
    session.user.name?.[0] ||
    session.user.email?.[0] ||
    "С"
  ).toUpperCase();

  return (
    <div className="userMenu">
      <button className="userTrigger">
        <span className="userAvatar">{letter}</span>

        <span className="userInfo">
          <b>{session.user.name || "Пользователь"}</b>
          <small>
            {session.user.role === "ADMIN"
              ? "Администратор"
              : session.user.role === "PRO"
                ? "PRO"
                : "Пользователь"}
          </small>
        </span>
      </button>

      <div className="userDropdown">
        <div className="dropdownEmail">
          {session.user.email}
        </div>

        <Link href="/profile">
          <User size={16} />
          Мой профиль
        </Link>

        {session.user.role === "ADMIN" && (
          <Link href="/admin">
            <Shield size={16} />
            Админка
          </Link>
        )}

        <button
          type="button"
          onClick={() =>
            signOut({
              callbackUrl: "/"
            })
          }
        >
          <LogOut size={16} />
          Выйти
        </button>
      </div>
    </div>
  );
}
