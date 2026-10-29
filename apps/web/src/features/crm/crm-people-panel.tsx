import { useEffect, useRef, useState } from 'react';
import {
  useGetChannelCrmAccessQuery,
  useGetCrmDirectoryQuery,
  useGetCrmIntegrationStatusQuery,
  useRefreshCrmDirectoryMutation,
  useSaveChannelCrmAccessMutation,
} from '@/api/baseApi';
import { describeError } from '@/api/errors';
import type { ChannelCrmRole } from '@/api/types';
import { Alert, Badge, Button, ErrorState, Field, LoadingState, uiStyles } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import styles from './crm.module.scss';

const ROLE_LABELS: Record<ChannelCrmRole | 'none', string> = {
  none: 'Без доступа',
  manager: 'Менеджер — ответы своим клиентам',
  supervisor: 'Руководитель — ответы всем клиентам',
  quality: 'Контроль качества — без отправки',
};

export function CrmPeoplePanel() {
  const status = useGetCrmIntegrationStatusQuery();
  const accounts = status.data?.accounts ?? [];
  const [accountDraft, setAccount] = useState('');
  const accountId = accounts.some((a) => a.id === accountDraft)
    ? accountDraft
    : ((accounts.find((a) => a.state === 'active') ?? accounts[0])?.id ?? '');
  const directory = useGetCrmDirectoryQuery(accountId, { skip: !accountId });
  const people = directory.currentData;
  const [channelDraft, setChannel] = useState('');
  const connectionId = people?.channels.some((c) => c.id === channelDraft)
    ? channelDraft
    : (people?.channels[0]?.id ?? '');
  const access = useGetChannelCrmAccessQuery(connectionId, { skip: !connectionId });
  const current = access.currentData;
  const [refresh, refreshing] = useRefreshCrmDirectoryMutation();
  const [save, saving] = useSaveChannelCrmAccessMutation();
  const [draft, setDraft] = useState<Record<string, ChannelCrmRole | 'none'>>({});
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const loadedVersion = useRef('');
  useEffect(() => {
    const key = current ? `${current.accountId}:${current.connectionId}:${current.version}` : '';
    if (loadedVersion.current === key) return;
    loadedVersion.current = key;
    setDraft(Object.fromEntries((current?.grants ?? []).map((g) => [g.crmUserId, g.role])));
  }, [current]);
  const reload = async () => {
    setMessage(null);
    try {
      await refresh({ accountId }).unwrap();
      setMessage({ tone: 'success', text: 'Сотрудники и роли обновлены из amoCRM.' });
    } catch (error) {
      setMessage({ tone: 'error', text: describeError(error) });
    }
  };
  const apply = async () => {
    if (!current || !people || current.accountId !== accountId) return;
    setMessage(null);
    try {
      const grants = people.users.flatMap((user) => {
        const role = draft[user.id] ?? 'none';
        return role === 'none' ? [] : [{ crmUserId: user.id, role }];
      });
      await save({
        id: connectionId,
        body: { accountId, expectedVersion: current.version, grants },
      }).unwrap();
      setMessage({ tone: 'success', text: 'Права канала применены.' });
    } catch (error) {
      setMessage({ tone: 'error', text: describeError(error) });
    }
  };
  return (
    <section
      className={`${styles.section} ${styles.wideSection}`}
      aria-labelledby="crm-people-title"
    >
      <h2 id="crm-people-title" className={styles.sectionTitle}>
        Сотрудники и права каналов
      </h2>
      <p className={uiStyles.hint}>
        Загрузите сотрудников из amoCRM, выберите канал и назначьте права. Для обновления нужны
        права администратора amoCRM. Видимость сделок в штатном чате определяется настройками самой
        CRM.
      </p>
      {!accountId && !status.isLoading ? <p>Сначала подключите amoCRM в блоке выше.</p> : null}
      {accountId ? (
        <>
          <div className={uiStyles.row}>
            <Field id="people-account" label="Аккаунт CRM">
              <select
                className={uiStyles.select}
                id="people-account"
                value={accountId}
                disabled={refreshing.isLoading || saving.isLoading}
                onChange={(e) => {
                  setAccount(e.target.value);
                  setChannel('');
                  setDraft({});
                  setMessage(null);
                }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              onClick={() => void reload()}
              disabled={!people?.refreshEnabled || refreshing.isLoading || saving.isLoading}
            >
              {refreshing.isLoading ? 'Обновляем сотрудников…' : 'Обновить данные из CRM'}
            </Button>
          </div>
          {directory.isFetching ? <LoadingState label="Загружаем сотрудников…" /> : null}
          {directory.isError ? (
            <ErrorState
              title="Сотрудники недоступны"
              message={describeError(directory.error)}
              onRetry={() => void directory.refetch()}
            />
          ) : null}
          {people ? (
            <>
              <p className={uiStyles.muted}>
                Последнее обновление из CRM: {formatDateTime(people.lastSuccessAt)}. Ролей CRM:{' '}
                {people.roles.length}.
              </p>
              {!people.refreshEnabled ? (
                <p className={uiStyles.hint}>Загрузка сотрудников не настроена на сервере.</p>
              ) : null}
              {!people.users.length ? (
                <p>Список ещё не загружен. Нажмите «Обновить данные из CRM».</p>
              ) : null}
              {!people.channels.length ? (
                <p>Добавьте канал и выберите его привязку к этому аккаунту CRM.</p>
              ) : (
                <Field id="people-channel" label="Канал для настройки прав">
                  <select
                    className={uiStyles.select}
                    id="people-channel"
                    value={connectionId}
                    disabled={saving.isLoading}
                    onChange={(e) => {
                      setChannel(e.target.value);
                      setMessage(null);
                    }}
                  >
                    {people.channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {access.isError ? (
                <ErrorState
                  title="Права канала недоступны"
                  message={describeError(access.error)}
                  onRetry={() => void access.refetch()}
                />
              ) : null}
              {current && current.accountId === accountId ? (
                <>
                  <p className={uiStyles.hint}>
                    {current.enforced
                      ? 'Права этого канала применяются к ответам.'
                      : 'Назначьте роли и примените права этого канала.'}{' '}
                    Новые обращения не распределяются автоматически.
                  </p>
                  {people.users.length ? (
                    <div className={styles.tableWrap}>
                      <table className={`${styles.table} ${styles.peopleTable}`}>
                        <caption>Сотрудники из CRM и права выбранного канала</caption>
                        <thead>
                          <tr>
                            <th scope="col">Сотрудник</th>
                            <th scope="col">Роль в CRM</th>
                            <th scope="col">Доступ к каналу</th>
                          </tr>
                        </thead>
                        <tbody>
                          {people.users.map((u) => (
                            <tr key={u.id}>
                              <th scope="row">
                                {u.name}{' '}
                                {!u.isActive ? <Badge tone="neutral">Неактивен в CRM</Badge> : null}
                                {u.groupName ? (
                                  <div className={uiStyles.muted}>{u.groupName}</div>
                                ) : null}
                                {u.isActive && !u.chatIdentityAvailable ? (
                                  <div className={uiStyles.hint}>
                                    Идентификатор чата недоступен. Обновите данные из CRM.
                                  </div>
                                ) : null}
                              </th>
                              <td>
                                {u.isCrmAdmin
                                  ? 'Администратор CRM'
                                  : (u.roleName ?? 'Без роли CRM')}
                              </td>
                              <td>
                                <select
                                  className={uiStyles.select}
                                  aria-label={`Доступ к каналу: ${u.name} (${u.id})`}
                                  value={draft[u.id] ?? 'none'}
                                  disabled={saving.isLoading || refreshing.isLoading}
                                  onChange={(e) =>
                                    setDraft((old) => ({
                                      ...old,
                                      [u.id]: e.target.value as ChannelCrmRole | 'none',
                                    }))
                                  }
                                >
                                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>
                                      {label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  <p className={uiStyles.hint}>
                    Менеджер может отвечать после определения ответственного в CRM. Неактивные
                    сотрудники не отправляют сообщения. Эти роли не выдают административный доступ к
                    шлюзу.
                  </p>
                  <Button
                    onClick={() => void apply()}
                    disabled={
                      saving.isLoading ||
                      refreshing.isLoading ||
                      access.isFetching ||
                      !people.lastSuccessAt
                    }
                  >
                    {saving.isLoading ? 'Применяем…' : 'Применить права канала'}
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {message ? (
        <Alert tone={message.tone} title={message.tone === 'error' ? 'Не выполнено' : 'Готово'}>
          {message.text}
        </Alert>
      ) : null}
    </section>
  );
}
