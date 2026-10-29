import { randomUUID } from 'node:crypto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_EVENTS = new Set([
  'request.completed',
  'inbox.persisted',
  'send.result_recorded',
  'assignment.changed',
  'projection.failed',
]);

const VALID_OUTCOMES = new Set([
  'accepted',
  'succeeded',
  'failed',
  'unknown',
  'blocked',
]);

const VALID_ERROR_CODES = new Set([
  'UPSTREAM_TIMEOUT',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'VERSION_CONFLICT',
  'STALE_EPOCH',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

const diagnosticErrorCodes = new WeakMap();
// One listener per actual stdout stream, shared by all loggers from this module.
// It lives with that process-wide stream; it never stores or formats the raw error.
const stdoutTransports = new WeakMap();

function stdoutTransport(stream) {
  const existing = stdoutTransports.get(stream);
  if (existing) return existing;
  const state = {
    failed: false,
    write(line) {
      if (state.failed) return false;
      try {
        stream.write(line, (error) => {
          if (error) state.failed = true;
        });
        return !state.failed;
      } catch {
        state.failed = true;
        return false;
      }
    },
  };
  stream.on('error', () => { state.failed = true; });
  stdoutTransports.set(stream, state);
  return state;
}

export class DiagnosticError extends Error {
  constructor(code) {
    if (!VALID_ERROR_CODES.has(code)) {
      throw new TypeError('Invalid diagnostic error code');
    }
    super(code);
    this.name = 'DiagnosticError';
    diagnosticErrorCodes.set(this, code);
  }

  get code() {
    return diagnosticErrorCodes.get(this);
  }
}

export function createLogger({
  write,
  wallClock = () => new Date(),
  monotonicClock = () => performance.now(),
  idFactory = randomUUID,
} = {}) {
  const contextMap = new WeakMap();
  const transport = write === undefined ? stdoutTransport(process.stdout) : {
    failed: false,
    write(line) {
      write(line);
      return true;
    },
  };

  function generateId(prefix) {
    const rawId = idFactory();
    if (typeof rawId !== 'string' || !UUID_REGEX.test(rawId)) {
      throw new TypeError('Invalid generated diagnostic ID');
    }
    return prefix + rawId;
  }

  function getContextData(context) {
    if (!context || typeof context !== 'object' || !contextMap.has(context)) {
      throw new TypeError('Invalid diagnostic context');
    }
    return contextMap.get(context);
  }

  function createContext() {
    const requestId = generateId('req_');
    const handle = Object.freeze({});
    contextMap.set(handle, {
      requestId,
      operationId: null,
      eventId: null,
    });
    return handle;
  }

  function withOperation(context) {
    const parentData = getContextData(context);
    const operationId = generateId('op_');
    const handle = Object.freeze({});
    contextMap.set(handle, {
      requestId: parentData.requestId,
      operationId,
      eventId: parentData.eventId,
    });
    return handle;
  }

  function withEvent(context) {
    const parentData = getContextData(context);
    const eventId = generateId('evt_');
    const handle = Object.freeze({});
    contextMap.set(handle, {
      requestId: parentData.requestId,
      operationId: parentData.operationId,
      eventId,
    });
    return handle;
  }

  function emit(context, options) {
    const ctxData = getContextData(context);

    if (!options || typeof options !== 'object') {
      throw new TypeError('Invalid diagnostic event');
    }

    const event = options.event;
    if (!VALID_EVENTS.has(event)) {
      throw new TypeError('Invalid diagnostic event');
    }

    const outcome = options.outcome;
    if (!VALID_OUTCOMES.has(outcome)) {
      throw new TypeError('Invalid diagnostic event');
    }

    const rawErrorCode = options.errorCode;
    let errorCode = null;
    if (rawErrorCode !== undefined && rawErrorCode !== null) {
      if (!VALID_ERROR_CODES.has(rawErrorCode)) {
        throw new TypeError('Invalid diagnostic event');
      }
      errorCode = rawErrorCode;
    }

    const durationMs = options.durationMs;
    if (durationMs !== undefined) {
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
        throw new TypeError('Invalid diagnostic event');
      }
    }

    let level;
    if (outcome === 'failed') {
      level = 'error';
    } else if (outcome === 'unknown' || outcome === 'blocked') {
      level = 'warn';
    } else {
      level = 'info';
    }

    try {
      const rawWall = wallClock();
      const timestamp = (rawWall instanceof Date ? rawWall : new Date(rawWall)).toISOString();
      const record = {
        schemaVersion: 1,
        timestamp,
        level,
        event,
        outcome,
        errorCode,
        correlation: {
          requestId: ctxData.requestId,
          operationId: ctxData.operationId,
          eventId: ctxData.eventId,
        },
      };
      if (durationMs !== undefined) record.durationMs = durationMs;
      if (transport.failed) return false;
      const line = JSON.stringify(record) + '\n';
      try {
        return transport.write(line);
      } catch {
        transport.failed = true;
        return false;
      }
    } catch {
      // Formatting/clock failures are diagnostic failures, never raw fallback output.
      return false;
    }
  }

  function failure(context, options) {
    getContextData(context);

    if (!options || typeof options !== 'object') {
      throw new TypeError('Invalid diagnostic event');
    }

    const event = options.event;
    const outcome = options.outcome === undefined ? 'failed' : options.outcome;
    if (!['failed', 'unknown', 'blocked'].includes(outcome)) {
      throw new TypeError('Invalid diagnostic event');
    }
    const durationMs = options.durationMs;
    const rawError = options.error;
    const errorCode = (rawError && typeof rawError === 'object' && diagnosticErrorCodes.get(rawError)) || 'INTERNAL_ERROR';

    return emit(context, {
      event,
      outcome,
      errorCode,
      durationMs,
    });
  }

  function readMonotonicTime() {
    try {
      const value = monotonicClock();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function elapsedSince(start) {
    const end = readMonotonicTime();
    if (start === undefined || end === undefined || end < start) return undefined;
    const elapsed = end - start;
    return Number.isFinite(elapsed) ? elapsed : undefined;
  }

  function correlation(context) {
    return Object.freeze({ ...getContextData(context) });
  }

  function transportState() {
    return Object.freeze({ failed: transport.failed });
  }

  async function run(context, options, action) {
    getContextData(context);
    if (!options || typeof options !== 'object' || !VALID_EVENTS.has(options.event)) {
      throw new TypeError('Invalid diagnostic event');
    }
    if (typeof action !== 'function') throw new TypeError('Action must be a function');
    const event = options.event;
    if (event === 'send.result_recorded' || event === 'projection.failed') {
      throw new TypeError('Event requires explicit outcome');
    }
    const started = readMonotonicTime();
    let result;
    try {
      result = await action();
    } catch (error) {
      try {
        failure(context, { event, error, outcome: 'failed', durationMs: elapsedSince(started) });
      } catch {
        // Instrumentation can never replace the original rollback error.
      }
      throw error;
    }
    try {
      emit(context, { event, outcome: 'succeeded', durationMs: elapsedSince(started) });
    } catch {
      // A committed action must not become a retryable failure because logging failed.
    }
    return result;
  }

  return {
    createContext,
    correlation,
    transportState,
    withOperation,
    withEvent,
    emit,
    failure,
    run,
  };
}
