import { loadSiteConfig } from '@workbench/siteConfig';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpServices } from '@workbench/api/http';
import { App } from './App';
import './site.css';

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 30000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});
const router = createBrowserRouter([{ path: '*', element: <App services={httpServices} /> }]);
void loadSiteConfig().then(() =>
  createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  ),
);
