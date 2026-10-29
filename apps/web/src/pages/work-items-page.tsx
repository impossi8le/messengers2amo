import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useGetWorkItemsQuery } from '@/api/baseApi';
import { describeError } from '@/api/errors';
import type { WorkItem } from '@/api/types';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  uiStyles,
} from '@/components/ui';
import {
  attentionChartData,
  filterWorkItems,
  summarizeAttention,
  WAITING_FILTER_LABELS,
  type WaitingFilter,
} from '@/features/work-items/filters';
import { WORK_ITEM_STATE_LABELS, WORK_ITEM_STATE_TONE } from '@/lib/labels';
import styles from './work-items-page.module.scss';

const PAGE_SIZE = 25;

const FILTER_ORDER: WaitingFilter[] = ['all', 'needs_reply', 'waiting_customer', 'closed'];

const BAR_COLORS = ['#b45309', '#2f5d8a', '#1f6b45', '#7a4bb0'];

export function WorkItemsPage() {
  const [filter, setFilter] = useState<WaitingFilter>('all');
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'state', desc: false }]);
  const [cursors, setCursors] = useState<string[]>([]);

  const after = cursors.length ? cursors[cursors.length - 1] : undefined;
  const query = useGetWorkItemsQuery({ limit: PAGE_SIZE, after });

  const items = query.data?.items ?? [];
  const visible = useMemo(() => filterWorkItems(items, filter, search), [items, filter, search]);
  const summary = useMemo(() => summarizeAttention(items), [items]);

  const columns = useMemo<ColumnDef<WorkItem>[]>(
    () => [
      {
        id: 'id',
        header: 'Обращение',
        accessorFn: (row) => row.id,
        cell: ({ row }) => (
          <Link to={`/work-items/${encodeURIComponent(row.original.id)}`} className={styles.idLink}>
            {row.original.id}
          </Link>
        ),
      },
      {
        id: 'conversationId',
        header: 'Диалог',
        accessorFn: (row) => row.conversationId,
        cell: ({ getValue }) => <span className={uiStyles.mono}>{String(getValue())}</span>,
      },
      {
        id: 'state',
        header: 'Состояние',
        accessorFn: (row) => row.state,
        sortingFn: 'alphanumeric',
        cell: ({ row }) => (
          <Badge tone={WORK_ITEM_STATE_TONE[row.original.state]}>
            {WORK_ITEM_STATE_LABELS[row.original.state]}
          </Badge>
        ),
      },
      {
        id: 'owner',
        header: 'Ответственный',
        accessorFn: (row) => row.owner ?? '',
        cell: ({ row }) =>
          row.original.owner ? (
            <span>{row.original.owner}</span>
          ) : (
            <Badge tone="warning">не назначен</Badge>
          ),
      },
      {
        id: 'assignmentVersion',
        header: 'Версия',
        accessorFn: (row) => row.assignmentVersion,
        cell: ({ getValue }) => <span className={uiStyles.mono}>{String(getValue())}</span>,
      },
    ],
    [],
  );

  const table = useReactTable({
    data: visible,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  const nextCursor = query.data?.page.nextCursor ?? null;
  const hasPrev = cursors.length > 0;

  const resetPaging = () => setCursors([]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.title}>Обращения</h1>
          <p className={uiStyles.muted}>
            Очередь диалогов шлюза. Ответы менеджеры отправляют в штатных чатах amoCRM; здесь —
            контроль назначений, ожидания и ошибок.
          </p>
        </div>
        <Button onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw size={16} aria-hidden="true" />
          {query.isFetching ? 'Обновляем…' : 'Обновить'}
        </Button>
      </header>

      <section className={styles.summary} aria-labelledby="attention-title">
        <h2 id="attention-title" className={styles.sectionTitle}>
          Счётчики внимания
        </h2>
        <div className={styles.summaryGrid}>
          <div className={styles.chartWrap}>
            <ResponsiveContainer width="100%" height={170}>
              <BarChart
                data={attentionChartData(summary)}
                margin={{ top: 16, right: 8, bottom: 8, left: 0 }}
              >
                <XAxis dataKey="shortLabel" tick={{ fontSize: 11 }} interval={0} />
                <YAxis allowDecimals={false} width={28} tick={{ fontSize: 11 }} />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {attentionChartData(summary).map((entry, index) => (
                    <Cell key={entry.key} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                  ))}
                  <LabelList dataKey="value" position="top" fontSize={11} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <dl className={styles.counters}>
            {attentionChartData(summary).map((entry) => (
              <div key={entry.key} className={styles.counter}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className={uiStyles.hint}>
          Счётчики считаются по загруженной странице ({items.length} из {PAGE_SIZE}), не по всей
          базе.
        </p>
      </section>

      <section className={styles.controls} aria-label="Поиск и фильтры">
        <div className={styles.searchField}>
          <label htmlFor="work-items-search" className={styles.searchLabel}>
            Поиск
          </label>
          <div className={styles.searchBox}>
            <Search size={16} aria-hidden="true" className={styles.searchIcon} />
            <input
              id="work-items-search"
              type="search"
              className={`${uiStyles.input} ${styles.searchInput}`}
              placeholder="ID обращения, диалога или ответственный"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              aria-describedby="work-items-search-hint"
            />
          </div>
          <p id="work-items-search-hint" className={uiStyles.hint}>
            Поиск по загруженной странице: серверный поиск контрактом пока не предусмотрен.
          </p>
        </div>

        <fieldset className={styles.filters}>
          <legend className={styles.searchLabel}>Ожидание ответа</legend>
          <div className={styles.filterRow}>
            {FILTER_ORDER.map((option) => (
              <label key={option} className={styles.filterChip}>
                <input
                  type="radio"
                  name="waiting-filter"
                  value={option}
                  checked={filter === option}
                  onChange={() => setFilter(option)}
                />
                <span>{WAITING_FILTER_LABELS[option]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      {query.isLoading ? <LoadingState label="Загружаем обращения…" /> : null}

      {query.isError ? (
        <ErrorState
          title="Не удалось загрузить обращения"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {!query.isLoading && !query.isError && visible.length === 0 ? (
        <EmptyState
          title={items.length === 0 ? 'Обращений нет' : 'Ничего не найдено'}
          description={
            items.length === 0
              ? 'На этой странице очередь пуста. Возможно, все обращения закрыты.'
              : 'Измените фильтр ожидания или строку поиска.'
          }
          action={
            items.length > 0 ? (
              <Button
                size="small"
                onClick={() => {
                  setFilter('all');
                  setSearch('');
                }}
              >
                Сбросить фильтры
              </Button>
            ) : null
          }
        />
      ) : null}

      {!query.isLoading && !query.isError && visible.length > 0 ? (
        <>
          <Alert tone="neutral">
            Отсортировано по состоянию. Заголовки колонок — кнопки: сортировка доступна с
            клавиатуры.
          </Alert>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="visually-hidden">
                Список обращений: идентификатор, диалог, состояние, ответственный, версия назначения
              </caption>
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          aria-sort={
                            sorted === 'asc'
                              ? 'ascending'
                              : sorted === 'desc'
                                ? 'descending'
                                : 'none'
                          }
                          className={styles.th}
                        >
                          <button
                            type="button"
                            className={styles.sortButton}
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === 'asc' ? (
                              <ArrowUp size={14} aria-hidden="true" />
                            ) : sorted === 'desc' ? (
                              <ArrowDown size={14} aria-hidden="true" />
                            ) : null}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className={styles.tr}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className={styles.td}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav className={styles.pagination} aria-label="Постраничная навигация">
            <Button
              size="small"
              onClick={() => setCursors((prev) => prev.slice(0, -1))}
              disabled={!hasPrev || query.isFetching}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              Назад
            </Button>
            <span className={uiStyles.muted} aria-live="polite">
              Страница {cursors.length + 1} · показано {visible.length} из {items.length}
            </span>
            <Button
              size="small"
              onClick={() => {
                if (nextCursor) setCursors((prev) => [...prev, nextCursor]);
              }}
              disabled={!nextCursor || query.isFetching}
            >
              Вперёд
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
            {cursors.length > 0 ? (
              <Button size="small" onClick={resetPaging}>
                В начало
              </Button>
            ) : null}
          </nav>
        </>
      ) : null}
    </div>
  );
}
