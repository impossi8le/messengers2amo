import { configureStore } from '@reduxjs/toolkit';
import { messengerApi } from '@/api/baseApi';

export function createAppStore() {
  return configureStore({
    reducer: {
      [messengerApi.reducerPath]: messengerApi.reducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(messengerApi.middleware),
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
