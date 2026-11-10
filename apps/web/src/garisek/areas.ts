import {
  CodeXmlIcon,
  CreditCardIcon,
  HeartIcon,
  LayoutGridIcon,
  ListChecksIcon,
  PackageIcon,
  SunriseIcon,
  type LucideIcon,
} from "lucide-react";

// One row per rail item. Icons follow the SwiftUI app's SF Symbols (NavRouter.swift AppPlace):
// sun.horizon, creditcard, heart, square.grid.2x2. A Garisek area is a Garisek-OS route shown
// in the shared Garisek webview; Code is T3 Code itself. Paths are where Garisek-OS lands, not
// its aliases (it redirects /today to /execute and /reminders to /daily).
export type AreaTarget =
  | { readonly kind: "code" }
  | { readonly kind: "garisek"; readonly path: string };

export interface Area {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: "primary" | "secondary";
  readonly target: AreaTarget;
}

export const AREAS: ReadonlyArray<Area> = [
  {
    id: "today",
    label: "Today",
    icon: SunriseIcon,
    group: "primary",
    target: { kind: "garisek", path: "/execute" },
  },
  { id: "code", label: "Code", icon: CodeXmlIcon, group: "primary", target: { kind: "code" } },
  {
    id: "money",
    label: "Money",
    icon: CreditCardIcon,
    group: "primary",
    target: { kind: "garisek", path: "/finance" },
  },
  {
    id: "health",
    label: "Health",
    icon: HeartIcon,
    group: "primary",
    target: { kind: "garisek", path: "/self-improvement" },
  },
  {
    id: "reminders",
    label: "Reminders",
    icon: ListChecksIcon,
    group: "secondary",
    target: { kind: "garisek", path: "/daily" },
  },
  {
    id: "desk",
    label: "Desk",
    icon: LayoutGridIcon,
    group: "secondary",
    target: { kind: "garisek", path: "/hub" },
  },
  {
    id: "inventory",
    label: "Inventory",
    icon: PackageIcon,
    group: "secondary",
    target: { kind: "garisek", path: "/inventory" },
  },
];

export const GARISEK_AREA_PREFIX = "/garisek/";
const DESK_ID = "desk";

export interface GarisekArea extends Area {
  readonly target: { readonly kind: "garisek"; readonly path: string };
}

const isGarisekArea = (area: Area): area is GarisekArea => area.target.kind === "garisek";

const GARISEK_AREAS: ReadonlyArray<GarisekArea> = AREAS.filter(isGarisekArea);

export function garisekAreaById(id: string): GarisekArea {
  return (
    GARISEK_AREAS.find((area) => area.id === id) ??
    GARISEK_AREAS.find((area) => area.id === DESK_ID)!
  );
}

// The area whose page this Garisek-OS path is, or null for pages no area owns (sign-in,
// /process), which leave the rail where it is.
export function garisekAreaForPath(path: string): GarisekArea | null {
  const pathname = path.split(/[?#]/u, 1)[0] ?? "/";
  return (
    GARISEK_AREAS.find(
      ({ target }) => pathname === target.path || pathname.startsWith(`${target.path}/`),
    ) ?? null
  );
}

// What the rail highlights for a T3 location.
export type RailSelection =
  | { readonly kind: "code" }
  | { readonly kind: "settings" }
  | { readonly kind: "garisek"; readonly area: GarisekArea };

export function railSelectionFor(pathname: string): RailSelection {
  if (pathname.startsWith(GARISEK_AREA_PREFIX)) {
    return { kind: "garisek", area: garisekAreaById(pathname.slice(GARISEK_AREA_PREFIX.length)) };
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return { kind: "settings" };
  return { kind: "code" };
}
