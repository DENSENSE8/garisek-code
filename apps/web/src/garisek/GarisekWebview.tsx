import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { garisekAreaForPath, type GarisekArea } from "./areas";
import { garisekOrigin } from "./garisekShell";

const GARISEK_PARTITION = "persist:garisek";

export interface GarisekOpenRequest {
  readonly path: string;
  readonly seq: number;
}

interface GuestElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
}

interface Props {
  // The area to show, or null while another area has the screen.
  readonly area: GarisekArea | null;
  readonly request: GarisekOpenRequest | null;
  readonly onGuestArea: (area: GarisekArea) => void;
}

export function GarisekWebview(props: Props) {
  const origin = useSyncExternalStore(garisekOrigin.subscribe, garisekOrigin.get);
  if (origin === null) return null;
  // A new origin is a new page: remount instead of navigating the old guest.
  return <GarisekGuest key={origin} origin={origin} {...props} />;
}

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

// One guest serves every Garisek area, so sign-in and page state carry across areas. The rail
// moves the guest to an area's page; navigating inside the guest moves the rail.
function GarisekGuest({ origin, area, request, onGuestArea }: Props & { readonly origin: string }) {
  const guestRef = useRef<GuestElement | null>(null);
  const [initialPath] = useState(() => request?.path ?? area?.target.path ?? "/");
  const shownSeq = useRef(request?.seq ?? 0);
  // The area the guest's current page is shown under: its owner, or for a page no area owns
  // (sign-in, /process), the area that was selected when it loaded.
  const guestAreaId = useRef<string | null>(null);
  const selectedAreaId = useRef<string | null>(area?.id ?? null);
  // What the guest is loading until it commits: a requested path, or an area's page.
  const inFlight = useRef<"request" | string | null>(request ? "request" : (area?.id ?? null));
  const [failure, setFailure] = useState<string | null>(null);

  const load = (path: string, reason: "request" | string) => {
    inFlight.current = reason;
    void guestRef.current?.loadURL(`${origin}${path}`);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to the webview element's load and navigation events
  useEffect(() => {
    const guest = guestRef.current;
    if (!guest) return;
    const onFail = (event: Event) => {
      const detail = event as Event & {
        readonly errorCode: number;
        readonly errorDescription: string;
        readonly isMainFrame: boolean;
      };
      // -3 is an aborted load, which a newer navigation causes.
      if (detail.isMainFrame && detail.errorCode !== -3) setFailure(detail.errorDescription);
    };
    const onNavigate = (event: Event) => {
      const detail = event as Event & { readonly url: string; readonly isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      setFailure(null);
      const guestArea = garisekAreaForPath(pathOf(detail.url));
      guestAreaId.current = guestArea?.id ?? selectedAreaId.current;
      inFlight.current = null;
      if (guestArea !== null) onGuestArea(guestArea);
    };
    guest.addEventListener("did-fail-load", onFail);
    guest.addEventListener("did-navigate", onNavigate);
    guest.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      guest.removeEventListener("did-fail-load", onFail);
      guest.removeEventListener("did-navigate", onNavigate);
      guest.removeEventListener("did-navigate-in-page", onNavigate);
    };
  }, [onGuestArea]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the webview element to a path the desktop asked for
  useEffect(() => {
    if (request === null || request.seq === shownSeq.current) return;
    shownSeq.current = request.seq;
    load(request.path, "request");
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- load reads the current origin and ref
  }, [request]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the webview element to the area the rail selected
  useEffect(() => {
    if (area === null) return;
    selectedAreaId.current = area.id;
    const pending = inFlight.current;
    if (pending === "request" || pending === area.id || guestAreaId.current === area.id) return;
    load(area.target.path, area.id);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- load reads the current origin and ref
  }, [area]);

  const visible = area !== null;
  return (
    <div
      className={cn(
        "absolute inset-0 bg-background",
        !visible && "pointer-events-none -z-10 opacity-0",
      )}
      aria-hidden={!visible}
      data-garisek-surface=""
    >
      <webview
        ref={(node) => {
          guestRef.current = node as GuestElement | null;
        }}
        // Electron reads allowpopups at attachment. React drops boolean values for unknown attributes.
        {...({ allowpopups: "true" } as unknown as { readonly allowpopups?: boolean })}
        className="size-full"
        partition={GARISEK_PARTITION}
        src={`${origin}${initialPath}`}
      />
      {failure !== null ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          <p className="font-medium">Garisek is not reachable at {origin}</p>
          <p className="text-sm text-muted-foreground">{failure}</p>
          <div className="flex gap-2">
            <Button onClick={() => guestRef.current?.reload()}>Retry</Button>
            <Button variant="outline" render={<Link to="/settings/garisek" />}>
              Change origin
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
