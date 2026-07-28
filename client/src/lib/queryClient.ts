import { QueryClient, QueryFunction } from "@tanstack/react-query";

const DEPLOY_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/**
 * Home Assistant serves add-ons under /api/hassio_ingress/<token>/ — API calls
 * must stay inside that prefix. Outside HA this resolves to "".
 */
function ingressBase(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^(.*\/api\/hassio_ingress\/[^/]+)(?:\/|$)/);
  return match ? match[1] : "";
}

const API_BASE = DEPLOY_BASE || ingressBase();

export { API_BASE };

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
