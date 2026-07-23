import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  useRouterState,
  redirect,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { AppShell } from "../components/AppShell";
import { Toaster } from "../components/ui/sonner";
import { fetchMe } from "../api/auth";
import { SessionProvider } from "../components/SessionContext";

/**
 * Routes reachable without a session. Everything else redirects to /login.
 *
 * An allowlist rather than a denylist, deliberately: a new route added to this
 * app is private by default, and forgetting to classify it fails safe.
 */
const PUBLIC_ROUTES = new Set(["/login", "/signup"]);

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">This page doesn't exist.</p>
        <Link
          to="/"
          className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    // Surface boundary-caught errors in the console; prod React swallows them.
    console.error("[root error boundary]", error);
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  /**
   * The single gate in front of the whole app.
   *
   * This is a convenience guard, not the security boundary — it stops signed-out
   * users seeing app chrome, but it runs on the client too, so it must never be
   * the only thing standing between someone and the data. Every server function
   * independently calls `requireAuth()`/`requirePermission()`; that is where
   * access is actually enforced.
   */
  beforeLoad: async ({ location }) => {
    const session = await fetchMe();
    const isPublic = PUBLIC_ROUTES.has(location.pathname);

    if (!session && !isPublic) {
      throw redirect({
        to: "/login",
        // Carry the intended destination so login can return them to it.
        search: { redirect: location.href },
      });
    }

    // Already signed in and sitting on the login page — send them inside.
    if (session && isPublic) {
      throw redirect({ to: "/" });
    }

    return { session };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Monarch ERP — Unified Accounting, Inventory & AI" },
      {
        name: "description",
        content:
          "Monarch ERP by IMB Labs — modern accounting, inventory, CRM, POS, banking, workflow automation, and an AI CFO in one platform.",
      },
      { property: "og:title", content: "Monarch ERP — Unified Business Platform" },
      {
        property: "og:description",
        content: "Accounting, inventory, CRM, POS, banking and AI-powered insights in one place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient, session } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isBare = PUBLIC_ROUTES.has(pathname);

  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider value={session ?? null}>
        {isBare ? (
          <Outlet />
        ) : (
          <AppShell>
            <Outlet />
          </AppShell>
        )}
      </SessionProvider>
      <Toaster />
    </QueryClientProvider>
  );
}
