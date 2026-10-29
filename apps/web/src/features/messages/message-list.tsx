import { Paperclip } from 'lucide-react';
import type { Message, Obligation } from '@/api/types';
import { Badge, EmptyState, uiStyles } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import styles from './message-list.module.scss';

export function messagePreview(content: Message['content']): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'attachment':
      return content.caption || 'Вложение';
    case 'unsupported':
      return `Неподдерживаемый тип сообщения: ${content.providerType}`;
    default:
      return 'Сообщение';
  }
}

export function MessageList({
  messages,
  obligations,
}: {
  messages: Message[];
  obligations: Obligation[];
}) {
  // Ответ не по контракту не должен ронять всю страницу: показываем явную
  // ошибку формата вместо пустого экрана.
  if (!Array.isArray(messages)) {
    return (
      <p role="alert" className={uiStyles.errorText}>
        Сервер вернул историю сообщений в неизвестном формате. Обновите карточку.
      </p>
    );
  }

  if (messages.length === 0) {
    return <EmptyState title="Сообщений нет" description="В этом диалоге ещё не было переписки." />;
  }

  const safeObligations = Array.isArray(obligations) ? obligations : [];
  const pendingByMessage = new Map(safeObligations.map((item) => [item.messageId, item]));

  return (
    <ol className={styles.list} aria-label="История сообщений">
      {messages.map((message) => {
        const obligation = pendingByMessage.get(message.id);
        const outgoing = message.direction === 'out';
        return (
          <li
            key={message.id}
            className={`${styles.item} ${outgoing ? styles.outgoing : styles.incoming}`}
          >
            <div className={styles.meta}>
              <span className={styles.author}>{outgoing ? 'Оператор' : 'Клиент'}</span>
              <time dateTime={message.createdAt} className={styles.time}>
                {formatDateTime(message.createdAt)}
              </time>
              {obligation ? (
                <Badge tone="warning">ждёт ответа · вопрос #{obligation.attentionSeq}</Badge>
              ) : null}
            </div>
            <p className={styles.body}>
              {message.content.kind === 'attachment' ? (
                <Paperclip size={14} aria-hidden="true" className={styles.clip} />
              ) : null}
              {messagePreview(message.content)}
            </p>
            {message.sendOperationId ? (
              <p className={uiStyles.mono}>операция {message.sendOperationId}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
