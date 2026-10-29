import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './ui.module.scss';

type ButtonVariant = 'default' | 'primary' | 'danger';
type ButtonSize = 'default' | 'small';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'default',
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = [styles.button];
  if (variant === 'primary') classes.push(styles.primary);
  if (variant === 'danger') classes.push(styles.danger);
  if (size === 'small') classes.push(styles.small);
  if (className) classes.push(className);
  return (
    <button type={type} className={classes.join(' ')} {...rest}>
      {children}
    </button>
  );
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  const classes = [styles.badge];
  if (tone === 'success') classes.push(styles.badgeSuccess);
  if (tone === 'warning') classes.push(styles.badgeWarning);
  if (tone === 'danger') classes.push(styles.badgeDanger);
  if (tone === 'accent') classes.push(styles.badgeAccent);
  return <span className={classes.join(' ')}>{children}</span>;
}

export function Card({
  children,
  className,
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'article' | 'div' | 'li';
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={[styles.card, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </Tag>
  );
}

export function Alert({
  tone = 'neutral',
  title,
  children,
  role,
}: {
  tone?: 'neutral' | 'error' | 'warning' | 'success';
  title?: string;
  children?: ReactNode;
  role?: 'alert' | 'status';
}) {
  const classes = [styles.alert];
  if (tone === 'error') classes.push(styles.alertError);
  if (tone === 'warning') classes.push(styles.alertWarning);
  if (tone === 'success') classes.push(styles.alertSuccess);
  const resolvedRole = role ?? (tone === 'error' ? 'alert' : 'status');
  return (
    <div className={classes.join(' ')} role={resolvedRole}>
      <div>
        {title ? <strong className={styles.alertTitle}>{title}</strong> : null}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.emptyState} role="status">
      <p className={styles.stateTitle}>{title}</p>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = 'Повторить',
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className={styles.errorState} role="alert">
      <p className={styles.stateTitle}>{title}</p>
      <p>{message}</p>
      {onRetry ? (
        <Button variant="primary" size="small" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingState({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite">
      <p>{label}</p>
    </div>
  );
}

export function Switch({
  id,
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
}) {
  const describedBy = description ? `${id}-desc` : undefined;
  return (
    <div className={styles.switchRow}>
      <div>
        <label htmlFor={id} className={styles.label} style={{ color: 'var(--text)', fontSize: 14 }}>
          {label}
        </label>
        {description ? (
          <p id={describedBy} className={styles.hint}>
            {description}
          </p>
        ) : null}
      </div>
      <span className={styles.switch}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className={styles.switchInput}
          checked={checked}
          disabled={disabled}
          aria-checked={checked}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className={styles.switchTrack} aria-hidden="true" />
      </span>
    </div>
  );
}

export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={styles.errorText} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p className={styles.errorText} role="alert">
      {children}
    </p>
  );
}

export { styles as uiStyles };
