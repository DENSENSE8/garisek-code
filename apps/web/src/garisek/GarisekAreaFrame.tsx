import { useLocation, useRouter } from "@tanstack/react-router";
import { CodeXmlIcon, LayoutDashboardIcon, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";
import { cn } from "../lib/utils";

type AreaId = "code" | "garisek";

export const GARISEK_AREA_PATH = "/garisek";

const AREAS: ReadonlyArray<{
  readonly id: AreaId;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { id: "code", label: "Code", icon: CodeXmlIcon },
  { id: "garisek", label: "Garisek", icon: LayoutDashboardIcon },
];

function areaForPath(pathname: string): AreaId {
  return pathname === GARISEK_AREA_PATH || pathname.startsWith(`${GARISEK_AREA_PATH}/`)
    ? "garisek"
    : "code";
}

export function GarisekAreaFrame({ children }: { children: ReactNode }) {
  if (!isElectron) return children;
  return <AreaFrame>{children}</AreaFrame>;
}

function AreaFrame({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = useLocation({ select: (location) => location.href });
  const area = areaForPath(pathname);
  const [lastCodeHref, setLastCodeHref] = useState(href);
  if (area === "code" && lastCodeHref !== href) setLastCodeHref(href);
  // The Garisek page mounts on first visit and then stays mounted, so switching areas keeps its state.
  const [garisekVisited, setGarisekVisited] = useState(area === "garisek");
  if (area === "garisek" && !garisekVisited) setGarisekVisited(true);

  const openArea = (target: AreaId) => {
    if (target === area) return;
    router.history.push(target === "code" ? lastCodeHref : GARISEK_AREA_PATH);
  };

  return (
    <div className="flex h-dvh w-full" data-garisek-area={area}>
      <nav
        aria-label="Areas"
        className="drag-region flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar pt-2"
      >
        {AREAS.map(({ id, label, icon: Icon }) => (
          <Tooltip key={id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  aria-current={id === area ? "page" : undefined}
                  data-area={id}
                  onClick={() => openArea(id)}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md text-muted-foreground [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground",
                    id === area && "bg-accent text-foreground",
                  )}
                >
                  <Icon className="size-4.5" />
                </button>
              }
            />
            <TooltipPopup side="right">{label}</TooltipPopup>
          </Tooltip>
        ))}
      </nav>
      {/* Layout containment makes this box the containing block for the sidebar's fixed positioning. */}
      <div className="relative min-w-0 flex-1 [contain:layout]">
        <div className={area === "code" ? "contents" : "hidden"}>{children}</div>
        {garisekVisited ? (
          <div
            className={cn("absolute inset-0", area !== "garisek" && "invisible")}
            data-garisek-surface=""
          />
        ) : null}
      </div>
    </div>
  );
}
