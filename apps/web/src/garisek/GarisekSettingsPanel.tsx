import { useState, useSyncExternalStore } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { garisekOrigin } from "./garisekShell";

export function GarisekSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="garisek" title="Garisek">
        <OriginRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function OriginRow() {
  const origin = useSyncExternalStore(garisekOrigin.subscribe, garisekOrigin.get);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = (next: string | null) => {
    setError(null);
    garisekOrigin.set(next).then(
      () => setDraft(null),
      () => setError("Enter an http or https address, such as http://127.0.0.1:3060."),
    );
  };
  return (
    <SettingsRow
      {...searchableSetting("garisek-origin")}
      description="The Garisek server the Garisek areas load. Empty means Garisek on gex45. To build Garisek, point it at a dev server such as http://127.0.0.1:3060."
      status={error}
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = (draft ?? origin ?? "").trim();
            save(value === "" ? null : value);
          }}
        >
          <Input
            aria-label="Garisek origin"
            className="w-72"
            value={draft ?? origin ?? ""}
            onValueChange={(value) => setDraft(value)}
          />
          <Button type="submit" variant="outline" disabled={draft === null}>
            Save
          </Button>
        </form>
      }
    />
  );
}
