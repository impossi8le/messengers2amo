import { create } from 'zustand';
import type { ComposeSnapshot, ObligationRef, SendOperation } from '@/api/types';

/**
 * Черновики ответов. Живут только в памяти вкладки: текст сообщений
 * не пишется в localStorage и не переживает закрытие страницы.
 *
 * Ключевая идея: черновик жёстко связан со снимком (snapshotId) и версией
 * назначения, при которых оператор начал писать. Если снимок устарел,
 * отправка блокируется — «дожать» старый снимок нельзя.
 */

export type SendPhase = 'idle' | 'sending' | 'sent' | 'failed' | 'blocked';

export interface Draft {
  workItemId: string;
  text: string;
  snapshotId: string | null;
  snapshotWorkItemId: string | null;
  expectedAssignmentVersion: number | null;
  selectedObligations: ObligationRef[];
  phase: SendPhase;
  blockReason: string | null;
  errorMessage: string | null;
  sendOperationId: string | null;
}

export interface DraftsState {
  drafts: Record<string, Draft>;
  ensureDraft: (workItemId: string) => void;
  setText: (workItemId: string, text: string) => void;
  bindSnapshot: (workItemId: string, snapshot: ComposeSnapshot) => void;
  toggleObligation: (workItemId: string, ref: ObligationRef) => void;
  selectAllObligations: (workItemId: string, refs: ObligationRef[]) => void;
  beginSend: (workItemId: string) => void;
  completeSend: (workItemId: string, operation: SendOperation) => void;
  failSend: (workItemId: string, message: string) => void;
  block: (workItemId: string, reason: string) => void;
  clearBlock: (workItemId: string) => void;
  resetDraft: (workItemId: string) => void;
  resetAll: () => void;
}

export function createEmptyDraft(workItemId: string): Draft {
  return {
    workItemId,
    text: '',
    snapshotId: null,
    snapshotWorkItemId: null,
    expectedAssignmentVersion: null,
    selectedObligations: [],
    phase: 'idle',
    blockReason: null,
    errorMessage: null,
    sendOperationId: null,
  };
}

function sameRef(a: ObligationRef, b: ObligationRef): boolean {
  return a.obligationId === b.obligationId && a.contentVersion === b.contentVersion;
}

function update(
  drafts: Record<string, Draft>,
  workItemId: string,
  patch: Partial<Draft>,
): Record<string, Draft> {
  const current = drafts[workItemId] ?? createEmptyDraft(workItemId);
  return { ...drafts, [workItemId]: { ...current, ...patch } };
}

export const useDraftsStore = create<DraftsState>((set) => ({
  drafts: {},

  ensureDraft: (workItemId) =>
    set((state) =>
      state.drafts[workItemId]
        ? state
        : { drafts: { ...state.drafts, [workItemId]: createEmptyDraft(workItemId) } },
    ),

  setText: (workItemId, text) =>
    set((state) => {
      const current = state.drafts[workItemId] ?? createEmptyDraft(workItemId);
      return {
        drafts: update(state.drafts, workItemId, {
          text,
          // Новый ввод снимает ошибку прошлой попытки, но не снимает блокировку
          // по устаревшему снимку: её снимает только перепривязка к свежему снимку.
          errorMessage: null,
          phase: current.phase === 'failed' ? 'idle' : current.phase,
        }),
      };
    }),

  bindSnapshot: (workItemId, snapshot) =>
    set((state) => ({
      drafts: update(state.drafts, workItemId, {
        snapshotId: snapshot.id,
        snapshotWorkItemId: snapshot.workItemId,
        expectedAssignmentVersion: snapshot.assignmentVersion,
        selectedObligations: snapshot.obligationRefs,
        blockReason: null,
        errorMessage: null,
        phase: state.drafts[workItemId]?.phase === 'sending' ? 'sending' : 'idle',
      }),
    })),

  toggleObligation: (workItemId, ref) =>
    set((state) => {
      const current = state.drafts[workItemId] ?? createEmptyDraft(workItemId);
      const exists = current.selectedObligations.some((item) => sameRef(item, ref));
      return {
        drafts: update(state.drafts, workItemId, {
          selectedObligations: exists
            ? current.selectedObligations.filter((item) => !sameRef(item, ref))
            : [...current.selectedObligations, ref],
        }),
      };
    }),

  selectAllObligations: (workItemId, refs) =>
    set((state) => ({
      drafts: update(state.drafts, workItemId, { selectedObligations: refs }),
    })),

  beginSend: (workItemId) =>
    set((state) => ({
      drafts: update(state.drafts, workItemId, {
        phase: 'sending',
        blockReason: null,
        errorMessage: null,
      }),
    })),

  completeSend: (workItemId, operation) =>
    set((state) => ({
      drafts: update(state.drafts, workItemId, {
        phase: 'sent',
        text: '',
        sendOperationId: operation.id,
        errorMessage: null,
        blockReason: null,
      }),
    })),

  failSend: (workItemId, message) =>
    set((state) => ({
      drafts: update(state.drafts, workItemId, {
        phase: 'failed',
        errorMessage: message,
      }),
    })),

  block: (workItemId, reason) =>
    set((state) => ({
      drafts: update(state.drafts, workItemId, { phase: 'blocked', blockReason: reason }),
    })),

  clearBlock: (workItemId) =>
    set((state) => ({
      drafts: update(state.drafts, workItemId, {
        phase:
          state.drafts[workItemId]?.phase === 'blocked'
            ? 'idle'
            : (state.drafts[workItemId]?.phase ?? 'idle'),
        blockReason: null,
      }),
    })),

  resetDraft: (workItemId) =>
    set((state) => {
      const next = { ...state.drafts };
      delete next[workItemId];
      return { drafts: next };
    }),

  resetAll: () => set({ drafts: {} }),
}));

export function getDraft(drafts: Record<string, Draft>, workItemId: string): Draft {
  return drafts[workItemId] ?? createEmptyDraft(workItemId);
}

export function selectPendingSends(state: DraftsState): Draft[] {
  return Object.values(state.drafts).filter((draft) => draft.phase === 'sending');
}
