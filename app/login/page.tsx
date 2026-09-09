"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  const [registration, setRegistration] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();

    setLoading(true);
    setMessage("");

    try {
      if (registration) {
        const response = await fetch("/api/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name,
            email,
            password
          })
        });

        const data = await response.json();

        if (!response.ok) {
          setMessage(data.error ?? "Ошибка регистрации.");
          return;
        }
      }

      const result = await signIn("credentials", {
        email,
        password,
        redirect: false
      });

      if (result?.error) {
        setMessage("Неверный e-mail или пароль.");
        return;
      }

      router.push("/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="authPage">
      <div className="authCard">
        <div className="authLogo">🐿️</div>

        <h1>
          {registration
            ? "Создать аккаунт"
            : "Войти в Суслика"}
        </h1>

        <p className="muted authIntro">
          Избранное, персональные сигналы и настройки стратегий.
        </p>

        <div className="oauthComing">
          <button disabled className="oauthButton telegram">
            Telegram
            <small>Скоро</small>
          </button>

          <button disabled className="oauthButton vk">
            VK ID
            <small>Скоро</small>
          </button>
        </div>

        <div className="authDivider">
          <span>или через e-mail</span>
        </div>

        <form onSubmit={submit}>
          {registration && (
            <label className="authLabel">
              Имя
              <input
                className="authInput"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Имя или ник"
                maxLength={60}
              />
            </label>
          )}

          <label className="authLabel">
            E-mail

            <input
              type="email"
              className="authInput"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="name@example.com"
            />
          </label>

          <label className="authLabel">
            Пароль

            <input
              type="password"
              className="authInput"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              placeholder="Минимум 8 символов"
            />
          </label>

          {message && (
            <div className="authError">
              {message}
            </div>
          )}

          <button
            className="authSubmit"
            disabled={loading}
          >
            {loading
              ? "Подождите..."
              : registration
                ? "Зарегистрироваться"
                : "Войти"}
          </button>
        </form>

        <button
          type="button"
          className="authSwitch"
          onClick={() => {
            setRegistration(!registration);
            setMessage("");
          }}
        >
          {registration
            ? "Уже есть аккаунт? Войти"
            : "Нет аккаунта? Зарегистрироваться"}
        </button>
      </div>
    </main>
  );
}
