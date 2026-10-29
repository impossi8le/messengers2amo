import { API_BASE_URL } from './baseApi';
import { httpError, invalidResponseError, networkError } from './errors';

/** Secret-bearing requests bypass Redux: a bot token must not enter the query cache. */
export async function postConnectionSecret<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/v2/operator/connections/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw networkError();
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidResponseError(response.status);
  }
  if (!response.ok) throw httpError(response.status, payload);
  if (!payload || typeof payload !== 'object') throw invalidResponseError(response.status);
  return payload as T;
}
