import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, uiStyles } from '@/components/ui';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Последний рубеж: если сервер вернул данные не по контракту и рендер упал,
 * оператор видит объяснение и кнопку перезагрузки, а не пустой экран.
 * Сам факт падения не скрывается — текст ошибки показывается целиком.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Консоль — единственный безопасный канал: сюда не попадают сообщения клиентов.
    console.error('Ошибка интерфейса:', error.message, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={uiStyles.stack} role="alert">
        <Alert tone="error" title="Интерфейс не смог отобразить данные">
          Ответ сервера не соответствует ожидаемому формату. Перезагрузите страницу; если ошибка
          повторяется — передайте администратору текст ниже.
          <p className={uiStyles.mono} style={{ marginTop: 8 }}>
            {error.message}
          </p>
        </Alert>
        <div className={uiStyles.row}>
          <Button variant="primary" onClick={this.reset}>
            Попробовать снова
          </Button>
          <Button onClick={() => window.location.reload()}>Перезагрузить страницу</Button>
        </div>
      </div>
    );
  }
}
