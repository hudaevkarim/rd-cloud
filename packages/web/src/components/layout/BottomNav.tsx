import { NavLink } from 'react-router-dom';

/**
 * Нижняя навигация.
 *
 * Только на телефоне: при 768px и шире её скрывает `display: none` в стилях.
 * Дублировать верхнюю навигацию внизу на десктопе незачем — там есть курсор и
 * есть место.
 *
 * Четыре вкладки, не пять: «Комнаты» и «Каталог» — это два состояния одного
 * раздела, и пятый пункт сделал бы каждый таб уже 25% ширины, а на 320px это
 * 80px — меньше, чем палец.
 */

const TABS = [
  { to: '/', label: 'Лобби', end: true },
  { to: '/catalog', label: 'Каталог', end: false },
  { to: '/search', label: 'Поиск', end: false },
  { to: '/profile', label: 'Профиль', end: false },
];

export function BottomNav() {
  return (
    <nav className="bottomnav" aria-label="Навигация">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => `bottomnav__tab${isActive ? ' is-active' : ''}`}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
