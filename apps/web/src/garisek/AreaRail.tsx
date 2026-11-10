import { SettingsIcon, type LucideIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";
import { cn, isMacPlatform } from "../lib/utils";
import { AREAS, type Area, type RailSelection } from "./areas";

function RailButton(props: {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-current={props.active ? "page" : undefined}
            data-area={props.id}
            onClick={props.onClick}
            className={cn(
              "flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors [corner-shape:squircle] [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground",
              props.active && "bg-foreground/10 text-foreground hover:bg-foreground/10",
            )}
          >
            <Icon className="size-5" strokeWidth={1.75} />
          </button>
        }
      />
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const isSelected = (area: Area, selection: RailSelection) =>
  area.target.kind === "code"
    ? selection.kind === "code"
    : selection.kind === "garisek" && selection.area.id === area.id;

export function AreaRail(props: {
  readonly selection: RailSelection;
  readonly onSelect: (area: Area) => void;
  readonly onSettings: () => void;
}) {
  const renderArea = (area: Area) => (
    <RailButton
      key={area.id}
      id={area.id}
      label={area.label}
      icon={area.icon}
      active={isSelected(area, props.selection)}
      onClick={() => props.onSelect(area)}
    />
  );
  return (
    <nav
      aria-label="Areas"
      className={cn(
        "drag-region flex w-16 shrink-0 flex-col items-center gap-2 bg-sidebar pb-3",
        isElectron && isMacPlatform(navigator.platform) ? "pt-11" : "pt-3",
      )}
    >
      <div className="flex flex-col gap-1 rounded-2xl bg-foreground/[0.04] p-1 [corner-shape:squircle] ring-1 ring-border/60">
        {AREAS.filter((area) => area.group === "primary").map(renderArea)}
      </div>
      <div aria-hidden className="h-px w-8 bg-border" />
      <div className="flex flex-col gap-1">
        {AREAS.filter((area) => area.group === "secondary").map(renderArea)}
      </div>
      <div className="mt-auto">
        <RailButton
          id="settings"
          label="Settings"
          icon={SettingsIcon}
          active={props.selection.kind === "settings"}
          onClick={props.onSettings}
        />
      </div>
    </nav>
  );
}
