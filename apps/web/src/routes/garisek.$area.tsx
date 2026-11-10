import { createFileRoute, redirect } from "@tanstack/react-router";

import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";

// On desktop, GarisekAreaFrame paints this area; the route only selects it.
function GarisekRoute() {
  if (isElectron) return null;
  return (
    <SidebarInset className="h-dvh items-center justify-center">
      <p className="text-sm text-muted-foreground">The Garisek area runs in the desktop app.</p>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/garisek/$area")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: GarisekRoute,
});
