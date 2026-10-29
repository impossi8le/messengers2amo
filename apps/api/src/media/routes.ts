import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../app.ts';
import type { Session } from '../platform/auth.ts';
import { MediaError, type AttachmentReplyInput, type MediaService } from './service.ts';
import { DEFAULT_MAX_CONCURRENT_UPLOADS } from './policy.ts';

const uploadRequestSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    displayName: z.string().min(1).max(255).regex(/^[^\r\n]+$/),
    mimeType: z
      .string()
      .min(1)
      .max(127)
      .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
    sizeBytes: z.number().int().min(1).max(104857600),
  })
  .strict();

const obligationRefSchema = z.object({ obligationId: z.string().min(1).max(128), contentVersion: z.number().int().min(0) }).strict();

const attachmentReplySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    snapshotId: z.string().min(1).max(128),
    expectedAssignmentVersion: z.number().int().min(0),
    selectedObligations: z.array(obligationRefSchema).max(500),
    mediaIds: z.array(z.string().min(1).max(128)).min(1).max(1),
    caption: z.string().max(4096),
    deadline: z.string().datetime({ offset: true }),
  })
  .strict();

function errorBody(code: string, requestId: string, retryable: boolean): Record<string, unknown> {
  return { code, requestId, retryable };
}

function sendError(reply: FastifyReply, request: FastifyRequest, error: MediaError): FastifyReply {
  return reply.code(error.statusCode).send(errorBody(error.code, request.correlationId, error.retryable));
}

async function handle<T>(request: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MediaError) return sendError(reply, request, error);
    throw error;
  }
}

function sessionOf(request: FastifyRequest): Session {
  const session = request.session;
  if (!session) throw new MediaError(401, 'UNAUTHENTICATED');
  return session;
}

function mediaPath(id: string): string {
  return `/api/v2/media/${encodeURIComponent(id)}/content`;
}

export function registerMediaRoutes(
  app: FastifyInstance,
  service: MediaService,
  maxFileBytes: number,
  maxConcurrentUploads = DEFAULT_MAX_CONCURRENT_UPLOADS,
): void {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: maxFileBytes + 1 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  // Upload bodies are buffered in memory, so every guard that can be decided from
  // the request line and headers runs in `onRequest`, before Fastify reads a byte.
  let uploadsInFlight = 0;
  const holdsUploadSlot = Symbol('media-upload-slot');

  const releaseUploadSlot = (request: FastifyRequest) => {
    const record = request as unknown as Record<symbol, boolean>;
    if (record[holdsUploadSlot]) {
      record[holdsUploadSlot] = false;
      uploadsInFlight -= 1;
    }
  };
  // Both a normal response and a client abort must return the slot.
  app.addHook('onResponse', async (request) => releaseUploadSlot(request));
  app.addHook('onRequestAbort', async (request) => releaseUploadSlot(request));

  function guardUpload(request: FastifyRequest, reply: FastifyReply): FastifyReply | null {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;

    const declared = request.headers['content-length'];
    if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
      // Without a declared length the body would have to be streamed and buffered
      // until it crosses the limit; refuse instead of guessing.
      return reply.code(411).send(errorBody('VALIDATION_FAILED', request.correlationId, false));
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxFileBytes) {
      return reply.code(413).send(errorBody('VALIDATION_FAILED', request.correlationId, false));
    }

    if (uploadsInFlight >= maxConcurrentUploads) {
      reply.header('retry-after', '1');
      return reply.code(429).send(errorBody('RATE_LIMITED', request.correlationId, true));
    }
    uploadsInFlight += 1;
    (request as unknown as Record<symbol, boolean>)[holdsUploadSlot] = true;
    return null;
  }

  app.post('/api/v2/operator/media/uploads', async (request, reply) => {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;
    return handle(request, reply, async () => {
      const parsed = uploadRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new MediaError(400, 'VALIDATION_FAILED');
      const accepted = await service.requestUpload(session.companyId, parsed.data);
      return reply.code(202).send(accepted);
    });
  });

  app.get<{ Params: { id: string } }>('/api/v2/operator/media/:id', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    return handle(request, reply, () =>
      service.getAsset(session.companyId, session.workshopId, request.params.id),
    );
  });

  app.get<{ Params: { id: string } }>('/api/v2/operator/media/:id/access', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    return handle(request, reply, () =>
      service.issueAccessGrant(
        session.companyId,
        session.staffId,
        session.role,
        session.workshopId,
        request.params.id,
      ),
    );
  });

  app.put<{ Params: { id: string } }>(
    '/api/v2/media/:id/content',
    {
      bodyLimit: maxFileBytes + 1,
      // Runs before the content-type parser: an anonymous caller never gets its
      // body read, and the in-flight counter bounds buffered upload memory.
      onRequest: async (request, reply) => guardUpload(request, reply),
    },
    async (request, reply) => {
      const session = requireRole(request, reply, 'send');
      if (!session) return reply;
      return handle(request, reply, async () => {
        if (!Buffer.isBuffer(request.body)) throw new MediaError(415, 'VALIDATION_FAILED');
        const declared = typeof request.headers['x-content-sha256'] === 'string' ? request.headers['x-content-sha256'] : null;
        const asset = await service.uploadBytes(session.companyId, request.params.id, request.body, declared);
        return reply.code(202).send(asset);
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/v2/media/:id/content', async (request, reply) => {
    const session = requireRole(request, reply, 'read');
    if (!session) return reply;
    return handle(request, reply, async () => {
      const content = await service.readContent(
        session.companyId,
        session.staffId,
        session.role,
        session.workshopId,
        request.params.id,
      );
      return reply
        .code(200)
        .header('content-type', content.mimeType)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(content.fileName)}`)
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(content.bytes));
    });
  });

  app.post<{ Params: { id: string } }>('/api/v2/operator/work-items/:id/attachment-reply', async (request, reply) => {
    const session = requireRole(request, reply, 'send');
    if (!session) return reply;
    return handle(request, reply, async () => {
      const parsed = attachmentReplySchema.safeParse(request.body);
      if (!parsed.success) throw new MediaError(400, 'VALIDATION_FAILED');
      const body: AttachmentReplyInput = parsed.data;
      const operation = await service.createAttachmentReply(
        session.companyId,
        session.staffId,
        session.role,
        session.workshopId,
        request.params.id,
        body,
      );
      return reply.code(202).send(operation);
    });
  });
}

export { mediaPath };
