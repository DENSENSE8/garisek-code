import { useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { AreaRail } from "./AreaRail";
import {
  GARISEK_AREA_PREFIX,
  garisekAreaById,
  garisekAreaForPath,
  railSelectionFor,
  type Area,
  type GarisekArea,
} from "./areas";
import { garisekShell, type GarisekShell } from "./garisekShell";
import { GarisekWebview, type GarisekOpenRequest } from "./GarisekWebview";

const GARISEK_SETTINGS_PATH = "/settings/garisek";

export function GarisekAreaFrame({ children }: { children: ReactNode }) {
  if (garisekShell === undefined) return children;
  return <AreaFrame shell={garisekShell}>{children}</AreaFrame>;
}

function AreaFrame({ shell, children }: { shell: GarisekShell; children: ReactNode }) {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = useLocation({ select: (location) => location.href });
  const selection = railSelectionFor(pathname);
  const garisekArea = selection.kind === "garisek" ? selection.area : null;
  const [lastCodeHref, setLastCodeHref] = useState(selection.kind === "code" ? href : "/");
  if (selection.kind === "code" && lastCodeHref !== href) setLastCodeHref(href);
  // The Garisek webview mounts on first visit and then stays mounted, so switching areas keeps its state.
  const [garisekVisited, setGarisekVisited] = useState(garisekArea !== null);
  if (garisekArea !== null && !garisekVisited) setGarisekVisited(true);
  const [openRequest, setOpenRequest] = useState<GarisekOpenRequest | null>(null);

  const showGarisekArea = (area: GarisekArea, mode: "push" | "replace") => {
    const current = railSelectionFor(router.state.location.pathname);
    if (current.kind === "garisek" && current.area.id === area.id) return;
    router.history[mode](`${GARISEK_AREA_PREFIX}${area.id}`);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop's requests to show a Garisek path (tray, shortcuts, deep links)
  useEffect(
    () =>
      shell.onOpen((path) => {
        setOpenRequest((previous) => ({ path, seq: (previous?.seq ?? 0) + 1 }));
        const current = railSelectionFor(router.state.location.pathname);
        // A page no area owns opens under the current Garisek area, else under Desk.
        const owner =
          garisekAreaForPath(path) ??
          (current.kind === "garisek" ? current.area : garisekAreaById("desk"));
        showGarisekArea(owner, "push");
      }),
    [router, shell, showGarisekArea],
  );

  const select = (area: Area) => {
    if (area.target.kind === "code") {
      if (selection.kind !== "code") router.history.push(lastCodeHref);
      return;
    }
    showGarisekArea(garisekAreaById(area.id), "push");
  };

  return (
    <div
      className="flex h-dvh w-full bg-sidebar"
      data-garisek-area={garisekArea?.id ?? selection.kind}
    >
      <AreaRail
        selection={selection}
        onSelect={select}
        onSettings={() => {
          if (selection.kind !== "settings") router.history.push(GARISEK_SETTINGS_PATH);
        }}
      />
      {/* Layout containment makes this box the containing block for the thread sidebar's fixed positioning. */}
      <div className="relative min-w-0 flex-1 [contain:layout]">
        <div className={garisekArea === null ? "contents" : "hidden"}>{children}</div>
        {garisekVisited ? (
          <GarisekWebview
            area={garisekArea}
            request={openRequest}
            onGuestArea={(area) => {
              if (railSelectionFor(router.state.location.pathname).kind === "garisek") {
                showGarisekArea(area, "replace");
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
