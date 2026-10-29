import { useGetSendOperationQuery } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import type { SendOperation } from '@/api/types';
import { Alert, Badge, Button, uiStyles } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { SEND_STATE_LABELS, SEND_STATE_TONE } from '@/lib/labels';

const TERMINAL: ReadonlySet<SendOperation['state']> = new Set([
  'sent',
  'failed',
  'unknown',
  'cancelled',
]);

/**
 * Достоверный результат отправки.
 *
 * 202 на POST /reply означает только приём команды, а не доставку клиенту.
 * Пока операция не в терминальном состоянии, интерфейс опрашивает сервер и
 * честно пишет «ещё не подтверждено». Состояние unknown НЕ даёт кнопку
 * «Отправить ещё раз»: повтор вслепую создаёт дубль.
 */
export function SendOperationStatus({ operationId }: { operationId: string }) {
  const query = useGetSendOperationQuery(operationId, {
    pollingInterval: 2000,
    skipPollingIfUnfocused: true,
  });

  if (query.isLoading) {
    return (
      <Alert tone="neutral" role="status">
        Отправка принята. Проверяем результат доставки…
      </Alert>
    );
  }

  if (query.isError) {
    return (
      <Alert tone="error" title="Не удалось узнать результат отправки">
        {describeError(query.error)} Операция {operationId} могла быть выполнена — не отправляйте
        повторно без проверки.
      </Alert>
    );
  }

  const operation = query.data;
  if (!operation) return null;

  const isTerminal = TERMINAL.has(operation.state);

  return (
    <div className={uiStyles.stack}>
      <div className={uiStyles.row}>
        <Badge tone={SEND_STATE_TONE[operation.state]}>{SEND_STATE_LABELS[operation.state]}</Badge>
        <span className={uiStyles.mono}>операция {operation.id}</span>
        {!isTerminal ? (
          <Button size="small" onClick={() => void query.refetch()}>
            Проверить ещё раз
          </Button>
        ) : null}
      </div>

      {operation.state === 'sent' ? (
        <Alert tone="success" title="Доставка подтверждена провайдером">
          Подтверждение получено {formatDateTime(operation.deliveryEvidence?.timestamp ?? null)}.
          {operation.readEvidence
            ? ` Прочитано: ${formatDateTime(operation.readEvidence.timestamp)}.`
            : ' Прочтение клиентом не подтверждено.'}
        </Alert>
      ) : null}

      {operation.state === 'unknown' ? (
        <Alert tone="warning" title="Результат неизвестен">
          Сервер не получил подтверждение от провайдера. Сообщение могло уйти. Повторная отправка
          запрещена до сверки: проверьте чат у клиента и зафиксируйте ручное покрытие.
        </Alert>
      ) : null}

      {operation.state === 'failed' ? (
        <Alert tone="error" title="Провайдер отклонил отправку">
          Сообщение не доставлено. Проверьте подключение и повторите после устранения причины.
        </Alert>
      ) : null}

      {!isTerminal ? (
        <Alert tone="neutral">
          Команда принята, но провайдер ещё не подтвердил доставку. Статус обновляется
          автоматически.
        </Alert>
      ) : null}
    </div>
  );
}
