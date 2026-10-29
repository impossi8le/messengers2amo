import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AMOCRM_AUTHORIZE_URL,
  AMOCRM_OAUTH_WINDOW_FEATURES,
  AMOCRM_OAUTH_WINDOW_NAME,
  startAmocrmAuthorization,
} from '@/lib/amocrm';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('запуск OAuth amoCRM во всплывающем окне', () => {
  it('открывает окно с серверным адресом согласия и именованным таргетом', () => {
    const popup = { closed: false } as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);

    const result = startAmocrmAuthorization();

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      AMOCRM_AUTHORIZE_URL,
      AMOCRM_OAUTH_WINDOW_NAME,
      AMOCRM_OAUTH_WINDOW_FEATURES,
    );
    expect(result).toEqual({ opened: true, popup });
  });

  it('возвращает URL для ручного открытия, если браузер заблокировал окно', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    const result = startAmocrmAuthorization();

    expect(result).toEqual({ opened: false, url: AMOCRM_AUTHORIZE_URL });
  });

  it('использует имя окна amocrm-oauth и размеры 560×760', () => {
    expect(AMOCRM_OAUTH_WINDOW_NAME).toBe('amocrm-oauth');
    expect(AMOCRM_OAUTH_WINDOW_FEATURES).toBe('width=560,height=760');
  });
});
