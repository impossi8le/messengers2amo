import { useState } from 'react';
import { useDispatch } from 'react-redux';
import {
  messengerApi,
  useGetConnectionSetupOptionsQuery,
  useGetPipelinesQuery,
} from '@/api/baseApi';
import { postConnectionSecret } from '@/api/connection-setup';
import { describeError, invalidResponseError } from '@/api/errors';
import type { ConnectionProjection } from '@/api/types';
import { Alert, Button, Field, LoadingState, uiStyles } from '@/components/ui';
import { newIdempotencyKey } from '@/lib/ids';

export function ConnectionSetup({ onClose }: { onClose: () => void }) {
  const dispatch = useDispatch();
  const options = useGetConnectionSetupOptionsQuery();
  const pipelines = useGetPipelinesQuery(undefined);
  const [step, setStep] = useState(1);
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [workshopId, setWorkshopId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [funnelId, setFunnelId] = useState('');
  const [statusId, setStatusId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => newIdempotencyKey('setup'));
  const stages =
    pipelines.data?.items
      .find((item) => item.id === funnelId)
      ?.stages.filter((stage) => !stage.isFinal) ?? [];

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const bot = await postConnectionSecret<{ providerId: string; displayName: string }>(
        'verify-telegram',
        { botToken: token },
      );
      if (!bot.providerId || !bot.displayName) throw invalidResponseError();
      if (!name) setName(bot.displayName);
      setStep(3);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const connection = await postConnectionSecret<ConnectionProjection>('setup-telegram', {
        idempotencyKey: key,
        botToken: token,
        displayName: name,
        workshopId,
        sourceId,
        funnelId,
        statusId: statusId || null,
      });
      if (!connection.id || connection.state !== 'setup') throw invalidResponseError();
      setToken('');
      dispatch(messengerApi.util.invalidateTags(['Connections']));
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="setup-title">
      <h2 id="setup-title">Добавить канал — шаг {step} из 3</h2>
      {options.isLoading ? <LoadingState label="Проверяем настройки подключения…" /> : null}
      {options.isError ? (
        <Alert tone="error" title="Настройки подключения недоступны">
          {describeError(options.error)}
        </Alert>
      ) : null}
      {options.data && !options.data.enabled ? (
        <Alert tone="neutral" title="Подключение пока недоступно">
          Сначала подключите amoCRM в разделе CRM.
        </Alert>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 1) setStep(2);
          else if (step === 2) void verify();
          else void save();
        }}
      >
        {step === 1 ? (
          <Field id="setup-type" label="Тип канала">
            <select id="setup-type" className={uiStyles.select}>
              <option>Telegram Bot</option>
            </select>
          </Field>
        ) : null}
        {step === 2 ? (
          <Field
            id="setup-token"
            label="Токен Telegram-бота"
            hint="Возьмите токен у BotFather. Проверка не отправляет сообщений."
          >
            <input
              id="setup-token"
              className={uiStyles.input}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={busy}
            />
          </Field>
        ) : null}
        {step === 3 ? (
          <>
            <Field id="setup-name" label="Название канала">
              <input
                id="setup-name"
                className={uiStyles.input}
                value={name}
                maxLength={120}
                required
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field id="setup-workshop" label="Мастерская">
              <select
                id="setup-workshop"
                className={uiStyles.select}
                required
                value={workshopId}
                disabled={busy}
                onChange={(event) => setWorkshopId(event.target.value)}
              >
                <option value="">Выберите мастерскую</option>
                {options.data?.workshops.map((workshop) => (
                  <option key={workshop.id} value={workshop.id}>
                    {workshop.displayName ?? workshop.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="setup-source" label="Источник чатов amoCRM">
              <select
                id="setup-source"
                className={uiStyles.select}
                required
                value={sourceId}
                disabled={busy}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="">Выберите подключённый источник</option>
                {options.data?.sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name} — {source.externalId}
                  </option>
                ))}
              </select>
            </Field>
            {options.data?.sources.length === 0 ? (
              <p className={uiStyles.hint}>
                В amoCRM ещё не подключён источник чатов. Настройте его перед добавлением канала.
              </p>
            ) : null}
            <Field id="setup-funnel" label="Воронка нового канала">
              <select
                id="setup-funnel"
                className={uiStyles.select}
                required
                value={funnelId}
                disabled={busy || pipelines.isFetching || pipelines.isError}
                onChange={(event) => {
                  setFunnelId(event.target.value);
                  setStatusId('');
                }}
              >
                <option value="">Выберите воронку</option>
                {pipelines.data?.items.map((funnel) => (
                  <option key={funnel.id} value={funnel.id}>
                    {funnel.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="setup-stage" label="Новые обращения">
              <select
                id="setup-stage"
                className={uiStyles.select}
                value={statusId}
                disabled={busy}
                onChange={(event) => setStatusId(event.target.value)}
              >
                <option value="">Неразобранное — без ответственного</option>
                {stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className={uiStyles.hint}>
              Канал сохранится выключенным. Запуск выполняется отдельно после подготовки
              сотрудников.
            </p>
            {pipelines.isError ? (
              <Alert tone="error" title="Воронки недоступны">
                {describeError(pipelines.error)}
              </Alert>
            ) : null}
          </>
        ) : null}
        {error ? (
          <Alert tone="error" title="Подключение не создано">
            {error}
          </Alert>
        ) : null}
        <div className={uiStyles.row}>
          {step > 1 ? (
            <Button
              disabled={busy}
              onClick={() => {
                setStep(step - 1);
                setError(null);
              }}
            >
              Назад
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy ||
              !options.data?.enabled ||
              (step === 2 && !token.trim()) ||
              (step === 3 &&
                (!name.trim() || !funnelId || !workshopId || !sourceId || pipelines.isError))
            }
          >
            {busy
              ? 'Проверяем…'
              : step === 1
                ? 'Продолжить'
                : step === 2
                  ? 'Проверить подключение'
                  : 'Сохранить канал'}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setToken('');
              onClose();
            }}
          >
            Отмена
          </Button>
        </div>
      </form>
    </section>
  );
}
