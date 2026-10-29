import { describe, expect, it } from 'vitest';
import type { ComposeSnapshot } from '@/api/types';
import type { Draft } from '@/store/drafts';
import { checkSnapshot, validateReplyText } from './snapshotGuard';

const snapshot: ComposeSnapshot = {
  id: 'snap-2',
  workItemId: 'wi-1',
  conversationId: 'conv-1',
  bindingEpoch: 1,
  assignmentVersion: 4,
  obligationRefs: [
    { obligationId: 'obl-1', contentVersion: 2 },
    { obligationId: 'obl-2', contentVersion: 1 },
  ],
};

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    workItemId: 'wi-1',
    text: 'Здравствуйте',
    snapshotId: 'snap-2',
    snapshotWorkItemId: 'wi-1',
    expectedAssignmentVersion: 4,
    selectedObligations: [{ obligationId: 'obl-1', contentVersion: 2 }],
    phase: 'idle',
    blockReason: null,
    errorMessage: null,
    sendOperationId: null,
    ...overrides,
  };
}

const base = {
  currentWorkItemId: 'wi-1',
  snapshot,
  snapshotLoading: false,
  snapshotError: null,
};

describe('защита от устаревшего снимка', () => {
  it('пропускает отправку, когда снимок совпадает', () => {
    expect(checkSnapshot({ ...base, draft: draft() })).toEqual({
      ok: true,
      code: 'ok',
      message: null,
    });
  });

  it('блокирует отправку, если сервер вернул новый снимок', () => {
    const result = checkSnapshot({
      ...base,
      draft: draft({ snapshotId: 'snap-1' }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('snapshot-changed');
    expect(result.message).toContain('снимок устарел');
  });

  it('блокирует, когда черновик принадлежит другому диалогу', () => {
    const result = checkSnapshot({
      ...base,
      currentWorkItemId: 'wi-2',
      snapshot: { ...snapshot, workItemId: 'wi-2' },
      draft: draft(),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('other-work-item');
  });

  it('блокирует при смене версии назначения', () => {
    const result = checkSnapshot({
      ...base,
      draft: draft({ expectedAssignmentVersion: 3 }),
    });
    expect(result.code).toBe('assignment-changed');
  });

  it('блокирует, если выбранный вопрос исчез или изменил версию', () => {
    const result = checkSnapshot({
      ...base,
      draft: draft({ selectedObligations: [{ obligationId: 'obl-1', contentVersion: 1 }] }),
    });
    expect(result.code).toBe('obligation-changed');
  });

  it('блокирует повторную отправку, пока идёт предыдущая', () => {
    const result = checkSnapshot({ ...base, draft: draft({ phase: 'sending' }) });
    expect(result.code).toBe('sending');
  });

  it('блокирует, если снимок не загрузился или ещё грузится', () => {
    expect(
      checkSnapshot({ ...base, draft: draft(), snapshot: null, snapshotError: 'нет связи' }).code,
    ).toBe('snapshot-error');
    expect(
      checkSnapshot({ ...base, draft: draft(), snapshot: null, snapshotLoading: true }).code,
    ).toBe('snapshot-loading');
    expect(checkSnapshot({ ...base, draft: draft(), snapshot: null }).code).toBe('no-snapshot');
  });

  it('блокирует, если снимок принадлежит другому обращению', () => {
    const result = checkSnapshot({
      ...base,
      snapshot: { ...snapshot, workItemId: 'wi-9' },
      draft: draft(),
    });
    expect(result.code).toBe('snapshot-changed');
  });

  it('не отправляет пустой черновик без привязки к снимку', () => {
    const result = checkSnapshot({ ...base, draft: draft({ snapshotId: null }) });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('no-snapshot');
  });
});

describe('валидация текста ответа', () => {
  it('требует непустой текст', () => {
    expect(validateReplyText('   ').ok).toBe(false);
    expect(validateReplyText('привет').ok).toBe(true);
  });

  it('ограничивает длину 4096 символами', () => {
    expect(validateReplyText('а'.repeat(4097)).ok).toBe(false);
    expect(validateReplyText('а'.repeat(4096)).ok).toBe(true);
  });
});
