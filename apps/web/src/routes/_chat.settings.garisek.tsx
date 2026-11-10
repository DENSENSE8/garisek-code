import { createFileRoute } from "@tanstack/react-router";

import { GarisekSettingsPanel } from "../garisek/GarisekSettingsPanel";

export const Route = createFileRoute("/_chat/settings/garisek")({
  component: GarisekSettingsPanel,
});
