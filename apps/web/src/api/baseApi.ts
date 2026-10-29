import {
  type BaseQueryFn,
  createApi,
  type FetchArgs,
  type FetchBaseQueryError,
  fetchBaseQuery,
} from '@reduxjs/toolkit/query/react';
import { httpError, invalidResponseError, type NormalizedApiError, networkError } from './errors';
import type {ChannelCatalogResponse} from './channel-catalog';
import type {
  ChannelCrmAccess,
  ChannelPermissionList,
  ClaimRequest,
  ComposeSnapshot,
  ConnectionCredentialRotationRequest,
  ConnectionLifecycleRequest,
  ConnectionProjection,
  ConnectionProjectionList,
  ConnectionRoute,
  ConnectionRouteList,
  ConnectionRouteRequest,
  ConnectionRouting,
  ConnectionRoutingRequest,
  ConnectionSetupOptions,
  CrmBindingList,
  CrmConflictList,
  CrmDiagnostics,
  CrmDirectoryView,
  CrmIntegrationStatus,
  CrmPolicy,
  CrmPolicyRequest,
  CrmResyncRequest,
  CrmResyncResult,
  EmptyRequest,
  GroupRule,
  GroupRuleList,
  GroupRuleRequest,
  LoginRequest,
  LoginResponse,
  ManualCoverageRequest,
  MessageList,
  NotificationList,
  PageQuery,
  PipelineList,
  ResolveRequest,
  SendOperation,
  SendReplyRequest,
  StaffAvailability,
  StaffAvailabilityList,
  StaffAvailabilityRequest,
  SystemStatus,
  TransferRequest,
  WorkItem,
  WorkItemDetail,
  WorkItemList,
  Workshop,
  WorkshopList,
} from './types';

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '/api';

const rawBaseQuery = fetchBaseQuery({
  baseUrl: `${API_BASE_URL.replace(/\/$/, '')}/v2`,
  credentials: 'include',
  prepareHeaders: (headers) => {
    headers.set('accept', 'application/json');
    return headers;
  },
});

function normalizeFetchError(error: FetchBaseQueryError): NormalizedApiError {
  if (error.status === 'FETCH_ERROR' || error.status === 'TIMEOUT_ERROR') {
    return networkError();
  }
  if (error.status === 'PARSING_ERROR') {
    return invalidResponseError(error.originalStatus);
  }
  if (error.status === 'CUSTOM_ERROR') {
    return invalidResponseError();
  }
  return httpError(error.status, error.data);
}

/**
 * Обёртка над fetchBaseQuery: любая ошибка транспорта приводится к
 * NormalizedApiError, поэтому UI не разбирает `status: 'FETCH_ERROR'` вручную.
 */
export const baseQuery: BaseQueryFn<string | FetchArgs, unknown, NormalizedApiError> = async (
  args,
  api,
  extraOptions,
) => {
  const result = await rawBaseQuery(args, api, extraOptions);
  if (result.error) {
    return { error: normalizeFetchError(result.error) };
  }
  return { data: result.data };
};

export const messengerApi = createApi({
  reducerPath: 'messengerApi',
  baseQuery,
  tagTypes: [
    'WorkItem',
    'WorkItemList',
    'Messages',
    'Connections',
    'ConnectionRouting',
    'Pipelines',
    'SendOperation',
    'Staff',
    'Notifications',
    'CrmBindings',
    'CrmIntegration',
    'CrmDirectory',
    'ChannelCrmAccess',
    'Workshops',
    'WorkshopRoutes',
    'WorkshopGroups',
    'WorkshopPermissions',
    'CrmPolicy',
    'CrmConflicts',
    'CrmDiagnostics',
    'SystemStatus',
  ],
  endpoints: (build) => ({
    getChannelCatalog:build.query<ChannelCatalogResponse,void>({query:()=>'/operator/channels/catalog'}),
    // ---------- вход ----------
    // Пароль уходит только в теле запроса; cookie сессии ставит сервер и
    // фронтенд её не читает. Ответ нужен лишь для роли и идентификаторов.
    login: build.mutation<LoginResponse, LoginRequest>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
    }),

    logout: build.mutation<void, void>({
      query: () => ({ url: '/auth/logout', method: 'POST', body: {} }),
    }),
    getSession: build.query<
      Pick<LoginResponse, 'staffId' | 'companyId' | 'role' | 'workshopId'>,
      void
    >({
      query: () => '/auth/session',
    }),

    // ---------- work items ----------
    getWorkItems: build.query<WorkItemList, PageQuery | undefined>({
      query: (params) => {
        const search = new URLSearchParams();
        if (params?.after) search.set('after', params.after);
        if (params?.limit) search.set('limit', String(params.limit));
        const qs = search.toString();
        return `/operator/work-items${qs ? `?${qs}` : ''}`;
      },
      providesTags: (result) => [
        { type: 'WorkItemList' as const, id: 'LIST' },
        ...(result?.items ?? []).map((item) => ({ type: 'WorkItem' as const, id: item.id })),
      ],
    }),

    getWorkItem: build.query<WorkItemDetail, string>({
      query: (id) => `/operator/work-items/${encodeURIComponent(id)}`,
      providesTags: (_result, _error, id) => [{ type: 'WorkItem', id }],
    }),

    getWorkItemMessages: build.query<MessageList, { id: string } & PageQuery>({
      query: ({ id, after, limit }) => {
        const search = new URLSearchParams();
        if (after) search.set('after', after);
        if (limit) search.set('limit', String(limit));
        const qs = search.toString();
        return `/operator/work-items/${encodeURIComponent(id)}/messages${qs ? `?${qs}` : ''}`;
      },
      providesTags: (_result, _error, { id }) => [{ type: 'Messages', id }],
    }),

    createSnapshot: build.mutation<ComposeSnapshot, string>({
      query: (id) => ({
        url: `/operator/work-items/${encodeURIComponent(id)}/snapshot`,
        method: 'POST',
        body: {} satisfies EmptyRequest,
      }),
    }),

    claimWorkItem: build.mutation<WorkItem, { id: string; body: ClaimRequest }>({
      query: ({ id, body }) => ({
        url: `/operator/work-items/${encodeURIComponent(id)}/claim`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'WorkItem', id },
        { type: 'WorkItemList', id: 'LIST' },
      ],
    }),

    transferWorkItem: build.mutation<WorkItem, { id: string; body: TransferRequest }>({
      query: ({ id, body }) => ({
        url: `/operator/work-items/${encodeURIComponent(id)}/transfer`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'WorkItem', id },
        { type: 'WorkItemList', id: 'LIST' },
      ],
    }),

    replyToWorkItem: build.mutation<SendOperation, { id: string; body: SendReplyRequest }>({
      query: ({ id, body }) => ({
        url: `/operator/work-items/${encodeURIComponent(id)}/reply`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'Messages', id },
        { type: 'WorkItem', id },
      ],
    }),

    resolveWorkItem: build.mutation<WorkItem, { id: string; body: ResolveRequest }>({
      query: ({ id, body }) => ({
        url: `/operator/work-items/${encodeURIComponent(id)}/resolve`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'WorkItem', id },
        { type: 'WorkItemList', id: 'LIST' },
      ],
    }),

    manualCoverage: build.mutation<WorkItem, { id: string; body: ManualCoverageRequest }>({
      query: ({ id, body }) => ({
        url: `/operator/work-items/${encodeURIComponent(id)}/manual-coverage`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: 'WorkItem', id },
        { type: 'WorkItemList', id: 'LIST' },
      ],
    }),

    // ---------- отправки ----------
    getSendOperation: build.query<SendOperation, string>({
      query: (id) => `/operator/send-operations/${encodeURIComponent(id)}`,
      providesTags: (_r, _e, id) => [{ type: 'SendOperation', id }],
    }),

    // ---------- подключения ----------
    getConnectionSetupOptions: build.query<ConnectionSetupOptions, void>({
      query: () => '/operator/connections/setup-options',
    }),
    getConnections: build.query<ConnectionProjectionList, PageQuery | undefined>({
      query: (params) => {
        const search = new URLSearchParams();
        if (params?.after) search.set('after', params.after);
        if (params?.limit) search.set('limit', String(params.limit));
        const qs = search.toString();
        return `/operator/connections${qs ? `?${qs}` : ''}`;
      },
      providesTags: ['Connections'],
    }),

    getConnectionHealth: build.query<ConnectionProjection, string>({
      query: (id) => `/operator/connections/${encodeURIComponent(id)}/health`,
      providesTags: ['Connections'],
    }),

    updateConnectionLifecycle: build.mutation<
      ConnectionProjection,
      { id: string; body: ConnectionLifecycleRequest }
    >({
      query: ({ id, body }) => ({
        url: `/operator/connections/${encodeURIComponent(id)}/lifecycle`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Connections'],
    }),

    rotateConnectionCredentials: build.mutation<
      ConnectionProjection,
      { id: string; body: ConnectionCredentialRotationRequest }
    >({
      query: ({ id, body }) => ({
        url: `/operator/connections/${encodeURIComponent(id)}/credentials-reference`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Connections'],
    }),

    // ---------- персонал ----------
    getStaffAvailability: build.query<StaffAvailabilityList, PageQuery | undefined>({
      query: (params) => {
        const search = new URLSearchParams();
        if (params?.after) search.set('after', params.after);
        if (params?.limit) search.set('limit', String(params.limit));
        const qs = search.toString();
        return `/operator/staff/availability${qs ? `?${qs}` : ''}`;
      },
      providesTags: ['Staff'],
    }),

    setStaffAvailability: build.mutation<
      StaffAvailability,
      { id: string; body: StaffAvailabilityRequest }
    >({
      query: ({ id, body }) => ({
        url: `/operator/staff/${encodeURIComponent(id)}/availability`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Staff'],
    }),

    // ---------- уведомления ----------
    // Персональная лента из уже существующего состояния; hints — сводка по
    // области сессии для бейджей. Экран пока не сделан, контракт доступен консоли.
    getNotifications: build.query<NotificationList, PageQuery | undefined>({
      query: (params) => {
        const search = new URLSearchParams();
        if (params?.after) search.set('after', params.after);
        if (params?.limit) search.set('limit', String(params.limit));
        const qs = search.toString();
        return `/operator/notifications${qs ? `?${qs}` : ''}`;
      },
      providesTags: ['Notifications'],
    }),

    // ---------- состояние системы ----------
    // Сводка по компании для страницы диагностики; доступна роли admin.
    getPipelines: build.query<PipelineList, { refresh?: boolean } | undefined>({
      query: (params) => `/operator/amocrm/pipelines${params?.refresh ? '?refresh=true' : ''}`,
      providesTags: ['Pipelines'],
    }),

    refreshPipelines: build.mutation<PipelineList, void>({
      query: () => '/operator/amocrm/pipelines?refresh=true',
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(messengerApi.util.upsertQueryData('getPipelines', undefined, data));
        } catch {
          // Keep the last successful catalogue; the caller displays the refresh error.
        }
      },
    }),

    getConnectionRouting: build.query<ConnectionRouting, string>({
      query: (id) => `/operator/connections/${encodeURIComponent(id)}/routing`,
      providesTags: (_result, _error, id) => [{ type: 'ConnectionRouting', id }],
    }),

    updateConnectionRouting: build.mutation<
      ConnectionRouting,
      { id: string; body: ConnectionRoutingRequest }
    >({
      query: ({ id, body }) => ({
        url: `/operator/connections/${encodeURIComponent(id)}/routing`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: (_result, _error, { id }) => [{ type: 'ConnectionRouting', id }],
    }),

    getSystemStatus: build.query<SystemStatus, void>({
      query: () => '/operator/system-status',
      providesTags: ['SystemStatus'],
    }),

    // ---------- CRM ----------
    // Операторская ручка: только чтение спорных связей в области компании
    // сессии. Внутренний /internal/crm/bindings принадлежит адаптеру и
    // авторизуется отдельным сервисным токеном, cookie оператора его не пускает.
    getCrmBindings: build.query<CrmBindingList, PageQuery | undefined>({
      query: (params) => {
        const search = new URLSearchParams();
        if (params?.after) search.set('after', params.after);
        if (params?.limit) search.set('limit', String(params.limit));
        const qs = search.toString();
        return `/operator/crm/bindings${qs ? `?${qs}` : ''}`;
      },
      providesTags: ['CrmBindings'],
    }),

    // ---------- мастерские ----------
    getWorkshops: build.query<WorkshopList, void>({
      query: () => '/operator/workshops',
      providesTags: ['Workshops'],
    }),

    createWorkshop: build.mutation<Workshop, { id: string; displayName?: string | null }>({
      query: (body) => ({ url: '/operator/workshops', method: 'POST', body }),
      invalidatesTags: ['Workshops'],
    }),

    getWorkshopRoutes: build.query<ConnectionRouteList, string>({
      query: (workshopId) => `/operator/workshops/${encodeURIComponent(workshopId)}/routes`,
      providesTags: ['WorkshopRoutes'],
    }),

    setWorkshopRoute: build.mutation<
      ConnectionRoute,
      { workshopId: string; body: ConnectionRouteRequest }
    >({
      query: ({ workshopId, body }) => ({
        url: `/operator/workshops/${encodeURIComponent(workshopId)}/routes`,
        method: 'POST',
        body,
      }),
      // Права канала выводятся из маршрутов, поэтому обновляем и их.
      invalidatesTags: ['WorkshopRoutes', 'WorkshopPermissions'],
    }),

    getWorkshopGroups: build.query<
      GroupRuleList,
      { workshopId: string; connectionId?: string; bindingEpoch?: number }
    >({
      query: ({ workshopId, connectionId, bindingEpoch }) => {
        const search = new URLSearchParams();
        if (connectionId) search.set('connectionId', connectionId);
        if (bindingEpoch !== undefined) search.set('bindingEpoch', String(bindingEpoch));
        const qs = search.toString();
        return `/operator/workshops/${encodeURIComponent(workshopId)}/groups${qs ? `?${qs}` : ''}`;
      },
      providesTags: ['WorkshopGroups'],
    }),

    setWorkshopGroupRule: build.mutation<GroupRule, { workshopId: string; body: GroupRuleRequest }>(
      {
        query: ({ workshopId, body }) => ({
          url: `/operator/workshops/${encodeURIComponent(workshopId)}/groups`,
          method: 'POST',
          body,
        }),
        invalidatesTags: ['WorkshopGroups'],
      },
    ),

    getWorkshopPermissions: build.query<ChannelPermissionList, string>({
      query: (workshopId) => `/operator/workshops/${encodeURIComponent(workshopId)}/permissions`,
      providesTags: ['WorkshopPermissions'],
    }),

    // ---------- CRM: политика, конфликты, ресинхронизация ----------
    getCrmPolicy: build.query<CrmPolicy, void>({
      query: () => '/operator/crm/policy',
      providesTags: ['CrmPolicy'],
    }),

    updateCrmPolicy: build.mutation<CrmPolicy, CrmPolicyRequest>({
      query: (body) => ({ url: '/operator/crm/policy', method: 'POST', body }),
      invalidatesTags: ['CrmPolicy', 'CrmConflicts'],
    }),

    getCrmConflicts: build.query<
      CrmConflictList,
      (PageQuery & { conversationId?: string; accountId?: string }) | undefined
    >({
      query: (params) => {
        const search = new URLSearchParams();
        if (params?.after) search.set('after', params.after);
        if (params?.limit) search.set('limit', String(params.limit));
        if (params?.conversationId) search.set('conversationId', params.conversationId);
        if (params?.accountId) search.set('accountId', params.accountId);
        const qs = search.toString();
        return `/operator/crm/conflicts${qs ? `?${qs}` : ''}`;
      },
      providesTags: ['CrmConflicts'],
    }),

    resyncCrm: build.mutation<CrmResyncResult, CrmResyncRequest>({
      query: (body) => ({ url: '/operator/crm/resync', method: 'POST', body }),
      invalidatesTags: ['CrmDiagnostics', 'CrmConflicts', 'CrmBindings'],
    }),

    getCrmIntegrationStatus: build.query<CrmIntegrationStatus, void>({
      query: () => '/operator/amocrm/status',
      providesTags: ['CrmIntegration'],
    }),

    getCrmDirectory: build.query<CrmDirectoryView, string>({
      query: (accountId) => `/operator/amocrm/directory?${new URLSearchParams({ accountId })}`,
      providesTags: ['CrmDirectory'],
    }),
    refreshCrmDirectory: build.mutation<CrmDirectoryView, { accountId: string }>({
      query: (body) => ({ url: '/operator/amocrm/directory/refresh', method: 'POST', body }),
      invalidatesTags: ['CrmDirectory', 'Staff', 'ChannelCrmAccess'],
    }),
    getChannelCrmAccess: build.query<ChannelCrmAccess, string>({
      query: (id) => `/operator/connections/${encodeURIComponent(id)}/crm-access`,
      providesTags: ['ChannelCrmAccess'],
    }),
    saveChannelCrmAccess: build.mutation<
      ChannelCrmAccess,
      {
        id: string;
        body: Pick<ChannelCrmAccess, 'accountId' | 'grants'> & { expectedVersion: number };
      }
    >({
      query: ({ id, body }) => ({
        url: `/operator/connections/${encodeURIComponent(id)}/crm-access`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: ['ChannelCrmAccess', 'Connections', 'WorkshopPermissions'],
    }),

    getCrmDiagnostics: build.query<CrmDiagnostics, { accountId: string; conversationId: string }>({
      query: ({ accountId, conversationId }) => {
        const search = new URLSearchParams({ accountId, conversationId });
        return `/operator/crm/diagnostics?${search.toString()}`;
      },
      providesTags: ['CrmDiagnostics'],
    }),
  }),
});

export const {
  useGetChannelCatalogQuery,
  useLoginMutation,
  useLogoutMutation,
  useGetSessionQuery,
  useGetWorkItemsQuery,
  useGetWorkItemQuery,
  useGetWorkItemMessagesQuery,
  useCreateSnapshotMutation,
  useClaimWorkItemMutation,
  useTransferWorkItemMutation,
  useReplyToWorkItemMutation,
  useResolveWorkItemMutation,
  useManualCoverageMutation,
  useGetSendOperationQuery,
  useGetConnectionsQuery,
  useGetConnectionSetupOptionsQuery,
  useGetConnectionHealthQuery,
  useUpdateConnectionLifecycleMutation,
  useGetPipelinesQuery,
  useRefreshPipelinesMutation,
  useGetConnectionRoutingQuery,
  useUpdateConnectionRoutingMutation,
  useRotateConnectionCredentialsMutation,
  useGetStaffAvailabilityQuery,
  useSetStaffAvailabilityMutation,
  useGetNotificationsQuery,
  useGetSystemStatusQuery,
  useGetCrmBindingsQuery,
  useGetWorkshopsQuery,
  useCreateWorkshopMutation,
  useGetWorkshopRoutesQuery,
  useSetWorkshopRouteMutation,
  useGetWorkshopGroupsQuery,
  useSetWorkshopGroupRuleMutation,
  useGetWorkshopPermissionsQuery,
  useGetCrmPolicyQuery,
  useUpdateCrmPolicyMutation,
  useGetCrmConflictsQuery,
  useResyncCrmMutation,
  useGetCrmDiagnosticsQuery,
  useGetCrmIntegrationStatusQuery,
  useGetCrmDirectoryQuery,
  useRefreshCrmDirectoryMutation,
  useGetChannelCrmAccessQuery,
  useSaveChannelCrmAccessMutation,
} = messengerApi;
