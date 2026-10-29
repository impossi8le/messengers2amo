// amoCRM adapter for the assignment-workflow contract (#12).
//
// The workflow domain owns policy and persistence; this module is the only place
// that turns its two CRM operations into amoCRM v4 requests. Failures are never
// swallowed: the caller must observe an upstream error instead of a silent success.

import {
  AmocrmApiError,
  AmocrmClient,
  AuthRequiredError,
  type AmocrmClientOptions,
} from './client.ts';
import type { WorkflowClient } from './workflow.ts';

export type AmocrmWorkflowClientOptions = {
  accountDomain: string;
  /** Resolves the OAuth access token of the account that owns the conversation. */
  getAccessToken: (input: { companyId: string; accountId: string }) => Promise<string>;
  fetch: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

type CallInit = { method?: string; body?: unknown };

type EntityPayload = { id?: unknown; responsible_user_id?: unknown };

function ownerRefOf(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** amoCRM entity ids are positive integers; anything else is a caller bug, not a no-op. */
function positiveInt(value: string, code: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new AmocrmApiError(0, code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AmocrmApiError(0, code);
  return parsed;
}

function parseEntity(payload: unknown, code: string): EntityPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AmocrmApiError(200, code);
  return payload as EntityPayload;
}

export function createAmocrmWorkflowClient(options: AmocrmWorkflowClientOptions): WorkflowClient {
  // A client per workflow call keeps the token bound to the company/account that
  // owns the conversation; the account itself is identified by the domain and token.
  function clientFor(input: { companyId: string; accountId: string }): AmocrmClient {
    const clientOptions: AmocrmClientOptions = {
      accountDomain: options.accountDomain,
      getAccessToken: () => options.getAccessToken(input),
      fetch: options.fetch,
      apiBase: options.apiBase,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
    };
    return new AmocrmClient(clientOptions);
  }

  async function call<T>(client: AmocrmClient, path: string, init: CallInit = {}): Promise<T> {
    try {
      return await client.request<T>(path, init);
    } catch (error) {
      // An expired token is still an upstream HTTP failure for the workflow layer;
      // it must not look like a different kind of outcome.
      if (error instanceof AuthRequiredError) throw new AmocrmApiError(401, 'http_401');
      throw error;
    }
  }

  return {
    async readResponsible(input) {
      const client = clientFor(input);
      const contact = parseEntity(
        await call<unknown>(client, `/api/v4/contacts/${encodeURIComponent(input.contactId)}`),
        'invalid_contact_response',
      );
      const contactOwnerRef = ownerRefOf(contact.responsible_user_id);

      let lead: { id: string; responsibleUserId: string | null } | null = null;
      if (input.leadId !== null) {
        try {
          const payload = parseEntity(
            await call<unknown>(client, `/api/v4/leads/${encodeURIComponent(input.leadId)}`),
            'invalid_lead_response',
          );
          lead = { id: input.leadId, responsibleUserId: ownerRefOf(payload.responsible_user_id) };
        } catch (error) {
          // A lead deleted in CRM is the documented `lead_missing` state, not a failure.
          if (error instanceof AmocrmApiError && error.status === 404) {
            lead = null;
          } else {
            throw error;
          }
        }
      }

      return { contactOwnerRef, lead };
    },

    async setContactOwner(input) {
      const ownerId = positiveInt(input.ownerRef, 'invalid_owner_ref');
      const contactId = positiveInt(input.contactId, 'invalid_contact_id');
      const client = clientFor(input);
      await call(client, '/api/v4/contacts', {
        method: 'PATCH',
        body: [{ id: contactId, responsible_user_id: ownerId }],
      });
    },
  };
}
