import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { httpServices } from './api/http';
import '../styles.css';
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 30000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <HashRouter>
      <App services={httpServices} />
    </HashRouter>
  </QueryClientProvider>,
);
