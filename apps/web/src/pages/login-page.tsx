import { zodResolver } from '@hookform/resolvers/zod';
import { LogIn } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch } from 'react-redux';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { messengerApi, useLoginMutation } from '@/api/baseApi';
import { describeError, type NormalizedApiError } from '@/api/errors';
import { Alert, Button, Field, uiStyles } from '@/components/ui';
import { useSessionStore } from '@/store/session';
import styles from './login-page.module.scss';

const loginSchema = z.object({
  companyId: z.string().trim().min(1, 'Укажите компанию').max(128),
  staffId: z.string().trim().min(1, 'Укажите сотрудника').max(128),
  password: z.string().min(1, 'Введите пароль').max(1024),
});

type LoginValues = z.infer<typeof loginSchema>;

/** Компания подставляется из окружения, если администратор её задал. */
function defaultCompanyId(): string {
  return import.meta.env.VITE_OPERATOR_COMPANY_ID ?? '';
}

/** Куда вернуть после входа: только внутренний путь, без внешних адресов. */
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

function loginErrorMessage(error: unknown): string {
  const normalized = error as NormalizedApiError | undefined;
  if (normalized?.httpStatus === 401 || normalized?.code === 'UNAUTHENTICATED') {
    return 'Неверные данные';
  }
  if (normalized?.httpStatus === 429 || normalized?.code === 'RATE_LIMITED') {
    return 'Слишком много попыток, подождите';
  }
  return describeError(error);
}

/**
 * Вход оператора: компания, сотрудник, пароль.
 *
 * Cookie сессии ставит сервер; здесь только запрос и запоминание роли для
 * видимости разделов. Пароль живёт исключительно в состоянии формы и
 * очищается сразу после успешного входа.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [login, { isLoading }] = useLoginMutation();
  const dispatch = useDispatch();
  const [error, setError] = useState<string | null>(null);
  const setSession = useSessionStore((state) => state.setSession);
  const status = useSessionStore((state) => state.status);
  const next = safeNext(searchParams.get('next')) ?? '/work-items';

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { companyId: defaultCompanyId(), staffId: '', password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const result = await login({
        companyId: values.companyId.trim(),
        staffId: values.staffId.trim(),
        password: values.password,
      }).unwrap();
      setSession({
        role: result.role,
        staffId: result.staffId,
        workshopId: result.workshopId,
        companyId: result.companyId,
      });
      form.reset({ companyId: defaultCompanyId(), staffId: '', password: '' });
      navigate(next, { replace: true });
    } catch (caught) {
      setError(loginErrorMessage(caught));
    } finally {
      // RTK Query хранит аргументы последней мутации (originalArgs), то есть
      // пароль остался бы в Redux. Сбрасываем кэш сразу после попытки: данных,
      // которые нужно сохранить, на этом экране ещё нет.
      dispatch(messengerApi.util.resetApiState());
    }
  });

  // Уже вошедшего пользователя форма не нужна: сразу возвращаем туда, куда он шёл.
  if (status === 'authenticated') {
    return <Navigate to={next} replace />;
  }

  return (
    <div className={styles.page}>
      <section className={styles.card} aria-labelledby="login-title">
        <header className={styles.header}>
          <span className={styles.brandMark} aria-hidden="true" />
          <div>
            <h1 id="login-title" className={styles.title}>
              Вход
            </h1>
            <p className={uiStyles.muted}>
              Рабочее место оператора шлюза мессенджеров. Используйте учётные данные, выданные
              администратором компании.
            </p>
          </div>
        </header>

        <form className={styles.form} onSubmit={submit} noValidate>
          <Field
            id="login-company"
            label="Компания"
            error={form.formState.errors.companyId?.message}
            hint="Идентификатор компании в шлюзе"
          >
            <input
              id="login-company"
              className={uiStyles.input}
              autoComplete="organization"
              autoFocus
              aria-invalid={Boolean(form.formState.errors.companyId)}
              {...form.register('companyId')}
            />
          </Field>

          <Field
            id="login-staff"
            label="Сотрудник"
            error={form.formState.errors.staffId?.message}
            hint="Ваш идентификатор сотрудника"
          >
            <input
              id="login-staff"
              className={uiStyles.input}
              autoComplete="username"
              aria-invalid={Boolean(form.formState.errors.staffId)}
              {...form.register('staffId')}
            />
          </Field>

          <Field id="login-password" label="Пароль" error={form.formState.errors.password?.message}>
            <input
              id="login-password"
              type="password"
              className={uiStyles.input}
              autoComplete="current-password"
              aria-invalid={Boolean(form.formState.errors.password)}
              {...form.register('password')}
            />
          </Field>

          <div aria-live="assertive">
            {error ? (
              <Alert tone="error" title="Войти не удалось">
                {error}
              </Alert>
            ) : null}
          </div>

          <Button type="submit" variant="primary" className={styles.submit} disabled={isLoading}>
            <LogIn size={16} aria-hidden="true" />
            {isLoading ? 'Входим…' : 'Войти'}
          </Button>
        </form>

        <p className={uiStyles.hint}>
          Сессия хранится в защищённой cookie и завершается кнопкой «Выйти» в шапке консоли.
        </p>
      </section>
    </div>
  );
}
