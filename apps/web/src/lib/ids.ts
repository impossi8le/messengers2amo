/**
 * Идемпотентные ключи операторских команд. Генерируются на клиенте один раз
 * на действие и переиспользуются при повторе, чтобы сетевой ретрай не создал
 * вторую отправку или второй перевод.
 */

let counter = 0;

function randomPart(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return Math.random().toString(36).slice(2, 14);
}

export function newIdempotencyKey(prefix = 'op'): string {
  counter += 1;
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${counter.toString(36)}_${randomPart()}`.slice(0, 128);
}

export function newDeadline(secondsFromNow = 300, now = new Date()): string {
  return new Date(now.getTime() + secondsFromNow * 1000).toISOString();
}
