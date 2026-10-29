import type { ComposeSnapshot, ObligationRef } from '@/api/types';
import type { Draft } from '@/store/drafts';

/**
 * Правило «ответ уходит только со свежим снимком».
 *
 * Оператор пишет ответ, глядя на состояние диалога в момент открытия карточки.
 * Пока он печатает, диалог мог измениться: новый входящий вопрос, перевод
 * другому сотруднику, перепривязка подключения. Отправка с прежним снимком
 * либо потеряла бы новый вопрос, либо перезаписала чужое назначение.
 *
 * Поэтому перед отправкой снимок сверяется с тем, к которому привязан черновик.
 * Любое расхождение — блокировка с объяснением, а не «тихая» отправка.
 */

export type SnapshotGuardCode =
  | 'ok'
  | 'sending'
  | 'snapshot-loading'
  | 'snapshot-error'
  | 'no-snapshot'
  | 'other-work-item'
  | 'snapshot-changed'
  | 'assignment-changed'
  | 'obligation-changed';

export interface SnapshotGuardInput {
  draft: Draft;
  /** Диалог, открытый в интерфейсе прямо сейчас. */
  currentWorkItemId: string;
  /** Снимок, только что полученный с сервера для текущего диалога. */
  snapshot: ComposeSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
}

export interface SnapshotGuardResult {
  ok: boolean;
  code: SnapshotGuardCode;
  message: string | null;
}

const OK: SnapshotGuardResult = { ok: true, code: 'ok', message: null };

function fail(code: SnapshotGuardCode, message: string): SnapshotGuardResult {
  return { ok: false, code, message };
}

function sameRef(a: ObligationRef, b: ObligationRef): boolean {
  return a.obligationId === b.obligationId && a.contentVersion === b.contentVersion;
}

export function checkSnapshot(input: SnapshotGuardInput): SnapshotGuardResult {
  const { draft, currentWorkItemId, snapshot, snapshotLoading, snapshotError } = input;

  if (draft.phase === 'sending') {
    return fail(
      'sending',
      'Отправка ещё не завершена. Дождитесь ответа сервера: повторная отправка создаст дубль.',
    );
  }

  if (snapshotError) {
    return fail(
      'snapshot-error',
      `Не удалось проверить актуальность диалога: ${snapshotError}. Обновите снимок перед отправкой.`,
    );
  }

  if (snapshotLoading) {
    return fail(
      'snapshot-loading',
      'Проверяем актуальность диалога — отправка станет доступна после ответа сервера.',
    );
  }

  if (!snapshot) {
    return fail('no-snapshot', 'Снимок диалога не получен. Обновите карточку перед отправкой.');
  }

  if (draft.workItemId !== currentWorkItemId) {
    return fail(
      'other-work-item',
      'Черновик относится к другому диалогу. Откройте его заново, чтобы не отправить ответ не туда.',
    );
  }

  if (snapshot.workItemId !== currentWorkItemId) {
    return fail(
      'snapshot-changed',
      'Снимок принадлежит другому обращению. Обновите карточку перед отправкой.',
    );
  }

  if (!draft.snapshotId) {
    return fail('no-snapshot', 'Черновик не привязан к снимку. Обновите карточку перед отправкой.');
  }

  if (snapshot.id !== draft.snapshotId) {
    return fail(
      'snapshot-changed',
      'Диалог изменился, пока вы писали ответ: снимок устарел. Текст сохранён — обновите снимок и проверьте, что ответ покрывает новые вопросы.',
    );
  }

  if (
    draft.expectedAssignmentVersion !== null &&
    snapshot.assignmentVersion !== draft.expectedAssignmentVersion
  ) {
    return fail(
      'assignment-changed',
      'Ответственного переназначили, пока вы писали. Обновите снимок, чтобы не отвечать от чужого имени.',
    );
  }

  const fresh = new Map(
    snapshot.obligationRefs.map((ref) => [ref.obligationId, ref.contentVersion]),
  );
  const staleSelection = draft.selectedObligations.some((ref) => {
    const version = fresh.get(ref.obligationId);
    return version === undefined || version !== ref.contentVersion;
  });
  if (staleSelection) {
    return fail(
      'obligation-changed',
      'Выбранные вопросы изменились с момента открытия карточки. Обновите снимок и выберите вопросы заново.',
    );
  }

  return OK;
}

export function validateReplyText(text: string): { ok: boolean; message: string | null } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, message: 'Введите текст ответа.' };
  }
  if (text.length > 4096) {
    return { ok: false, message: `Текст длиннее 4096 символов (сейчас ${text.length}).` };
  }
  return { ok: true, message: null };
}

export function sameObligationRef(a: ObligationRef, b: ObligationRef): boolean {
  return sameRef(a, b);
}
