import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { useTheme } from '../../theme/theme-context.js';

/**
 * Шапка.
 *
 * Логотип — начертание Archivo Black. Крупный, без трекинга: трекинг на
 * заголовке уменьшает чёрные пятна между буквами, и на тёмном фоне жирный
 * шрифт с разрядкой распадается на отдельные линии.
 *
 * Высота 56px — выше порога 44px для касания и ниже, чем место под подвал
 * на телефоне.
 */

const NAV = [
  { to: '/', label: 'Лобби', end: true },
  { to: '/catalog', label: 'Каталог', end: false },
  { to: '/profile', label: 'Профиль', end: false },
];

export function TopBar() {
  const { user, logout } = useAuth();
  const { resolved, toggle } = useTheme();
  const navigate = useNavigate();

  const signOut = async (): Promise<void> => {
    await logout();
    // Переход после выхода, а не по эффекту: пока пользователь был вошедшим,
    // `RequireAuth` его не пускал бы на `/login`.
    navigate('/login', { replace: true });
  };

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <NavLink to="/" className="topbar__logo display">
          ЧИТАЙ
        </NavLink>

        <nav className="topbar__nav" aria-label="Основная навигация">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `topbar__link${isActive ? ' is-active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar__actions">
          {user?.role === 'admin' && (
            <NavLink to="/admin" className="topbar__link">
              Админка
            </NavLink>
          )}

          <button
            type="button"
            className="topbar__theme"
            onClick={toggle}
            aria-label={resolved === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            title={resolved === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          >
            {/* Иконка — метка, а не картинка: контраст и размер получаются из
                currentColor и потому работают в обеих темах. */}
            {resolved === 'dark' ? '○' : '●'}
          </button>

          <button type="button" className="topbar__link topbar__link--button" onClick={() => void signOut()}>
            Выйти
          </button>
        </div>
      </div>
    </header>
  );
}
