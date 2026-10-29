import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';
import { ru } from 'date-fns/locale';

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = parseISO(value);
  return isValid(date) ? date : null;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '—';
  return format(date, 'dd.MM.yyyy HH:mm', { locale: ru });
}

export function formatTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '—';
  return format(date, 'HH:mm', { locale: ru });
}

export function formatRelative(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '—';
  return formatDistanceToNowStrict(date, { addSuffix: true, locale: ru, unit: 'minute' });
}

export function formatWaiting(sinceSeconds: number): string {
  if (!Number.isFinite(sinceSeconds) || sinceSeconds < 0) return '—';
  const totalMinutes = Math.floor(sinceSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} мин`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  return `${days} д ${hours % 24} ч`;
}

export function pluralize(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
