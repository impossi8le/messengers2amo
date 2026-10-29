import { create } from 'zustand';
import { ROLE_RANK, type Role } from '@/api/types';

/**
 * Состояние сессии.
 *
 * Сессия выдаётся сервером в HttpOnly-cookie, поэтому фронтенд не может
 * прочитать её сам: роль приходит в ответах `/auth/login` и `/auth/session`.
 * `VITE_OPERATOR_ROLE` — только подсказка для интерфейса (что показывать);
 * любые права всё равно проверяет сервер, и 403 показывается как есть.
 *
 * `status` отвечает на другой вопрос — есть ли сессия вообще:
 * - `unknown` — ещё не проверяли (сразу после загрузки страницы);
 * - `authenticated` — сервер принял cookie;
 * - `anonymous` — cookie нет или она истекла.
 *
 * Проверка выполняется запросом к API, потому что cookie недоступна скрипту.
 * Пока роль неизвестна, интерфейс ведёт себя по принципу наименьших прав:
 * админские действия скрыты.
 */
export type SessionStatus = 'unknown' | 'authenticated' | 'anonymous';

export interface SessionState {
  role: Role | null;
  staffId: string | null;
  workshopId: string | null;
  companyId: string | null;
  status: SessionStatus;
  setSession: (input: {
    role: Role;
    staffId?: string | null;
    workshopId?: string | null;
    companyId?: string | null;
  }) => void;
  /** Cookie подтверждена запросом, но роль из ответа логина уже потеряна. */
  markAuthenticated: () => void;
  clear: () => void;
}

function isRole(value: unknown): value is Role {
  return value === 'read' || value === 'send' || value === 'manage' || value === 'admin';
}

function bootstrapRole(): Role | null {
  const raw = import.meta.env.VITE_OPERATOR_ROLE;
  return isRole(raw) ? raw : null;
}

export const useSessionStore = create<SessionState>((set) => ({
  role: bootstrapRole(),
  staffId: null,
  workshopId: null,
  companyId: null,
  status: 'unknown',
  setSession: ({ role, staffId = null, workshopId = null, companyId = null }) =>
    set({ role, staffId, workshopId, companyId, status: 'authenticated' }),
  markAuthenticated: () => set({ status: 'authenticated' }),
  clear: () =>
    set({ role: null, staffId: null, workshopId: null, companyId: null, status: 'anonymous' }),
}));

export function roleAtLeast(role: Role | null, required: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Есть ли у текущей сессии роль не ниже `required`. */
export function useHasRole(required: Role): boolean {
  return useSessionStore((state) => roleAtLeast(state.role, required));
}
