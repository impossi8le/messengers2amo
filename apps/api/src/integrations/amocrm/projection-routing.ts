import type { Db } from '../../platform/db.ts';
import type { InboundMessageInput, ProjectionResult } from './sync.ts';
import { loadChannelForConversation } from './store.ts';

export type MessageProjection = (input: InboundMessageInput) => Promise<ProjectionResult>;
export function createMessageProjectionRouter(deps: {
  db: Db; schema: string; nativeProject: MessageProjection;
  prepareMessage: (input: InboundMessageInput) => Promise<InboundMessageInput>;
  capture?: { companyId: string; connectionId: string; projectMessage: MessageProjection;
    wrapFiles?: (projectMessage: MessageProjection) => MessageProjection };
}): MessageProjection {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.schema)) throw new Error('INVALID_SCHEMA');
  const capture = deps.capture;
  // Resolve on every dispatch: registering a channel upgrades the existing pilot
  // binding without a new conversation, replay identity or capture flag change.
  const pilotProject: MessageProjection = capture ? async (input) => {
    const channel = await loadChannelForConversation(deps.db, deps.schema, input);
    return channel ? deps.nativeProject(input) : capture.projectMessage(input);
  } : deps.nativeProject;
  // The Files API wrapper supplies caption/filename as text. It owns original
  // bytes independently of native chat import and must not require S3.
  const files = capture?.wrapFiles?.(pilotProject);
  return async (input) => {
    if (capture && input.companyId === capture.companyId) {
      const conversation = await deps.db.query<{ connection_id: string }>(
        `SELECT connection_id FROM "${deps.schema}".conversations WHERE company_id=$1 AND id=$2`,
        [input.companyId, input.conversationId],
      );
      if (conversation.rows[0]?.connection_id === capture.connectionId) {
        return files ? files(input) : pilotProject(await deps.prepareMessage(input));
      }
    }
    return deps.nativeProject(await deps.prepareMessage(input));
  };
}
