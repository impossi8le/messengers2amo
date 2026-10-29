import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/error-boundary';
import { MessageList } from '@/features/messages/message-list';

function Boom(): JSX.Element {
  throw new Error('сломанный ответ сервера');
}

describe('устойчивость к ответу не по контракту', () => {
  it('показывает ошибку вместо пустого экрана', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Интерфейс не смог отобразить данные')).toBeInTheDocument();
    expect(screen.getByText('сломанный ответ сервера')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Попробовать снова' })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('список сообщений объясняет неверный формат вместо падения', () => {
    render(
      <MessageList
        messages={undefined as unknown as never}
        obligations={undefined as unknown as never}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/неизвестном формате/);
  });
});
