import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { AuthProvider } from './auth/AuthContext.js';
import { ThemeProvider } from './theme/ThemeContext.js';
import { ToastProvider } from './components/ui/Toast.js';
import { setUnauthorizedHandler, setToken } from './api/client.js';

// Порядок импорта стилей значим: токены первыми, потому что компоненты
// ссылаются на них переменными, а сброс — до всего остального.
import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/pages.css';
// Стили витрины подключаются всегда: страница удаляется одним импортом,
// а отдельный подключатель в vite.config означал бы ещё одно место, где
// о ней надо вспомнить.
import './styles/showcase.css';

/**
 * Точка входа клиента.
 *
 * ─── Порядок провайдеров ─────────────────────────────────────────────────────
 *
 * Снаружи тема: она не зависит ни от чего, кроме `localStorage`, и должна быть
 * готова до первого кадра — иначе страница моргнёт светлым на тёмной теме.
 * Дальше `ToastProvider`: он ничего не знает об аутентификации, но уведомления
 * показываются из `AuthContext`. Внутри `AuthProvider` и `Router` — роутеру
 * нужен `useAuth`, а `AuthProvider` ничего не знает о маршрутах.
 *
 * ─── Глобальная обработка 401 ────────────────────────────────────────────────
 *
 * Ставится один раз здесь: любой запрос может получить 401, и редирект на
 * `/login` должен происходить в одном месте. Внутри компонента он отработал бы
 * только для того, кто этот компонент вызвал.
 *
 * Токен кладётся в память **до** проверки сессии: он лежит в `localStorage`, и
 * первый запрос `/api/auth/me` должен уйти с заголовком, а не только с cookie.
 * Cookie на этом шаге ещё может не быть — она ставится сервером при входе, а
 * страницу могли открыть напрямую.
 */

const container = document.getElementById('root');
if (container === null) {
  // Без корня приложение некуда смонтировать. Сообщение в консоль, а не
  // тишина: пустая страница с нулевой причиной — худший вид поломки.
  throw new Error('Не найден элемент #root в index.html');
}

const storedToken = readStoredToken();
if (storedToken !== null) setToken(storedToken);

setUnauthorizedHandler(() => {
  // Полная перезагрузка, а не `navigate`: сокеты и подписки уже могли быть
  // созданы под старым пользователем, и мягкий переход оставил бы их жить.
  // `window.location.assign` надёжнее и совпадает с тем, что делает вход.
  window.location.assign('/login');
});

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);

function readStoredToken(): string | null {
  try {
    const value = window.localStorage.getItem('rd.token');
    return value === null || value === '' ? null : value;
  } catch {
    // Приватный режим: человек не останется без входа, просто сессия не
    // переживёт перезагрузку.
    return null;
  }
}
