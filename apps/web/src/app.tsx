import { type ReactNode, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { messengerApi, useGetSessionQuery, useLogoutMutation } from '@/api/baseApi';
import { ErrorBoundary } from '@/components/error-boundary';
import { LoadingState } from '@/components/ui';
import { NotificationsIndicator } from '@/features/notifications/notifications-indicator';
import { AvailabilityIndicator } from '@/features/staff/availability-indicator';
import { ConnectionsPage } from '@/pages/connections-page';
import { CrmPage } from '@/pages/crm-page';
import { DiagnosticsPage } from '@/pages/diagnostics-page';
import { LoginPage } from '@/pages/login-page';
import { StaffPage } from '@/pages/staff-page';
import { WorkItemPage } from '@/pages/work-item-page';
import { WorkItemsPage } from '@/pages/work-items-page';
import { WorkshopsPage } from '@/pages/workshops-page';
import { useSessionStore } from '@/store/session';
import styles from './app.module.scss';

const NAV = [
  { to: '/work-items', label: 'Обращения' },
  { to: '/connections', label: 'Подключения' },
  { to: '/workshops', label: 'Мастерские' },
  { to: '/crm', label: 'CRM' },
  { to: '/staff', label: 'Смены и нагрузка' },
  { to: '/diagnostics', label: 'Диагностика' },
];

/**
 * Проверка серверной сессии при загрузке страницы.
 *
 * Cookie HttpOnly; сервер возвращает актуальные роль и область доступа.
 * Ответ 401 означает отсутствие действующей сессии.
 */
function SessionProbe() {
  const status = useSessionStore((state) => state.status);
  const setSession = useSessionStore((state) => state.setSession);
  const clear = useSessionStore((state) => state.clear);

  const probe = useGetSessionQuery(undefined, { skip: status !== 'unknown' });

  useEffect(() => {
    if (status !== 'unknown') return;
    if (probe.isSuccess && probe.data) setSession(probe.data);
    if (probe.isError) clear();
  }, [status, probe.isSuccess, probe.isError, probe.data, setSession, clear]);

  return null;
}

/** Операторские маршруты открываются только с подтверждённой сессией. */
function RequireSession({ children }: { children: ReactNode }) {
  const status = useSessionStore((state) => state.status);
  const location = useLocation();

  if (status === 'unknown') return <LoadingState label="Проверяем сессию…" />;
  if (status === 'anonymous') {
    const next = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

function LogoutButton() {
  const dispatch = useDispatch();
  const clear = useSessionStore((state) => state.clear);
  const [logout, { isLoading }] = useLogoutMutation();

  // Выход гасит cookie на сервере; локальное состояние и кэш запросов
  // очищаются в любом случае, чтобы следующие экраны не показали чужие данные.
  const handleLogout = async () => {
    try {
      await logout().unwrap();
    } catch {
      // Cookie могла уже истечь — для интерфейса это тот же результат.
    }
    dispatch(messengerApi.util.resetApiState());
    clear();
  };

  return (
    <button
      type="button"
      className={styles.logout}
      disabled={isLoading}
      onClick={() => void handleLogout()}
    >
      Выйти
    </button>
  );
}

export function App() {
  const status = useSessionStore((state) => state.status);

  return (
    <div className={styles.shell}>
      <SessionProbe />
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true" />
          <span>
            <strong className={styles.brandTitle}>Шлюз мессенджеров</strong>
            <span className={styles.brandSubtitle}>Рабочее место оператора</span>
          </span>
        </div>
        {status === 'authenticated' ? (
          <>
            <AvailabilityIndicator />
            <NotificationsIndicator />
          </>
        ) : null}
        <nav className={styles.nav} aria-label="Основная навигация">
          <ul className={styles.navList}>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {status === 'authenticated' ? <LogoutButton /> : null}
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<Navigate to="/work-items" replace />} />
            <Route
              path="/work-items"
              element={
                <RequireSession>
                  <WorkItemsPage />
                </RequireSession>
              }
            />
            <Route
              path="/work-items/:workItemId"
              element={
                <RequireSession>
                  <WorkItemPage />
                </RequireSession>
              }
            />
            <Route
              path="/connections"
              element={
                <RequireSession>
                  <ConnectionsPage />
                </RequireSession>
              }
            />
            <Route
              path="/workshops"
              element={
                <RequireSession>
                  <WorkshopsPage />
                </RequireSession>
              }
            />
            <Route
              path="/crm"
              element={
                <RequireSession>
                  <CrmPage />
                </RequireSession>
              }
            />
            <Route
              path="/staff"
              element={
                <RequireSession>
                  <StaffPage />
                </RequireSession>
              }
            />
            <Route
              path="/diagnostics"
              element={
                <RequireSession>
                  <DiagnosticsPage />
                </RequireSession>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <footer className={styles.footer}>
        <p>
          Основная переписка менеджера — в штатных чатах amoCRM. Этот интерфейс отвечает за
          подключения, назначения и диагностику; он не заменяет inbox.
        </p>
      </footer>
    </div>
  );
}

function NotFound() {
  return (
    <section aria-labelledby="not-found-title">
      <h1 id="not-found-title">Страница не найдена</h1>
      <p>Проверьте адрес или вернитесь к списку обращений.</p>
      <NavLink to="/work-items">К списку обращений</NavLink>
    </section>
  );
}
