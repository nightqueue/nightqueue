import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Navigate, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./components/Shell";
import { JobPage } from "./routes/JobPage";
import { QueuePage } from "./routes/QueuePage";
import { SettingsPage } from "./routes/SettingsPage";
import { TerminalPage } from "./routes/TerminalPage";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: () => <Navigate to="/" /> });

const queueRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: QueuePage });

const jobRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/$ref",
  component: function JobRoute() {
    const { ref } = jobRoute.useParams();
    return <JobPage jobRef={ref} />;
  },
});

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terminal/$id",
  component: function TerminalRoute() {
    const { id } = terminalRoute.useParams();
    return <TerminalPage id={id} />;
  },
});

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

const router = createRouter({ routeTree: rootRoute.addChildren([queueRoute, jobRoute, terminalRoute, settingsRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Mounts the studio into the page.
function mount() {
  const root = document.getElementById("root");
  if (!root) throw new Error("the studio page has no #root element");
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

mount();
