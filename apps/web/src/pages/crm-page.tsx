import { RefreshCw } from 'lucide-react';
import {
  useGetCrmConflictsQuery,
  useGetCrmIntegrationStatusQuery,
  useGetCrmPolicyQuery,
} from '@/api/baseApi';
import { Button, uiStyles } from '@/components/ui';
import { AmocrmConnectionPanel } from '@/features/crm/amocrm-connection-panel';
import { CrmConflictsPanel } from '@/features/crm/crm-conflicts-panel';
import { CrmDiagnosticsPanel } from '@/features/crm/crm-diagnostics-panel';
import { CrmPeoplePanel } from '@/features/crm/crm-people-panel';
import { CrmPipelinesPanel } from '@/features/crm/crm-pipelines-panel';
import { CrmPolicyPanel } from '@/features/crm/crm-policy-panel';
import { CrmResyncPanel } from '@/features/crm/crm-resync-panel';
import { useHasRole } from '@/store/session';
import styles from './crm-page.module.scss';

/**
 * CRM: политика назначений, конфликты владельцев, ручная ресинхронизация и
 * диагностика. Политику видно всем, меняет только admin; остальные действия
 * проверяет сервер, а интерфейс показывает отказ как есть.
 */
export function CrmPage() {
  const isAdmin = useHasRole('admin');
  const policy = useGetCrmPolicyQuery();
  const conflicts = useGetCrmConflictsQuery({ limit: 50 });
  const integration = useGetCrmIntegrationStatusQuery();

  const refresh = () => {
    void policy.refetch();
    void conflicts.refetch();
    void integration.refetch();
  };
  const refreshing = policy.isFetching || conflicts.isFetching || integration.isFetching;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>CRM</h1>
          <p className={uiStyles.muted}>
            Кто владеет диалогом, где расходятся назначения и как привести данные в порядок. Все
            изменения фиксируются в аудите.
          </p>
        </div>
        <Button onClick={refresh} disabled={refreshing}>
          <RefreshCw size={16} aria-hidden="true" />
          {refreshing ? 'Обновляем…' : 'Обновить'}
        </Button>
      </header>

      <div className={styles.grid}>
        <AmocrmConnectionPanel isAdmin={isAdmin} />
        {isAdmin ? <CrmPipelinesPanel /> : null}
        {isAdmin ? <CrmPeoplePanel /> : null}
        <CrmPolicyPanel isAdmin={isAdmin} />
        <CrmResyncPanel />
        <CrmDiagnosticsPanel />
        <CrmConflictsPanel />
      </div>
    </div>
  );
}
