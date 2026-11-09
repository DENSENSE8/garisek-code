# Garisek delta vs pingdotgg/t3code

This is the merge checklist. `scripts/garisek/sync-upstream.sh` fails if `git diff --name-only upstream/main HEAD` lists a file that this page doesn't name. Parent contract: check F2 in `~/agent-reviews/progress/Garisek-OS-01a1b86b-a075/contracts/acceptance-manifest.json`.

Rules: no `@t3tools/*` scope is renamed. New code goes in new files. An upstream file gets only the lines a surface needs.

## Fork-owned files (no upstream counterpart)

| File                                           | Why                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/shared/src/garisekBrand.ts`          | One product identity: name `Garisek`, app id `com.garisek.code`, default data home `~/.garisek` |
| `packages/provider-omp/package.json`           | OMP provider package (check O1)                                                                 |
| `packages/provider-omp/tsconfig.json`          | Turns off the Effect diagnostics that don't apply to a standalone stdio process                 |
| `packages/provider-omp/bin/garisek-omp-rpc.ts` | Executable the Pi driver spawns in place of `pi`                                                |
| `packages/provider-omp/src/dialect.ts`         | Translates the OMP RPC dialect into Pi's (settle, commands, queue, compaction, v2 chunking)     |
| `packages/provider-omp/src/shim.ts`            | Spawns `omp` and pipes the translated JSONL in both directions                                  |
| `packages/provider-omp/src/dialect.test.ts`    | Dialect behavior tests                                                                          |
| `packages/provider-omp/src/shim.test.ts`       | End-to-end subprocess test against a stand-in OMP                                               |
| `scripts/garisek/test-all.sh`                  | Per-package test runner that keeps going past a failure, for baselines                          |
| `scripts/garisek/identity.mjs`                 | Input identity used to bind receipts (ID1)                                                      |
| `scripts/garisek/acceptance-gate.mjs`          | Parent acceptance gate (GATE1)                                                                  |
| `scripts/garisek/omp-rpc-probe.mjs`            | OMP RPC conformance probe (O1)                                                                  |
| `scripts/garisek/inventory.mjs`                | Independent first-party inventory (INV1)                                                        |
| `scripts/garisek/sync-upstream.sh`             | This merge procedure                                                                            |
| `docs/garisek/SCOUT.md`                        | Scouting record                                                                                 |
| `docs/garisek/DELTA.md`                        | This file                                                                                       |
| `docs/garisek/receipts/`                       | Probe and smoke receipts                                                                        |

## Upstream files changed

| File                                                     | Change                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/package.json`                           | Adds the `./garisekBrand` export                                                                                                                                                            |
| `knip.jsonc`                                             | Entries for `scripts/garisek/*.mjs` and the provider-omp executable                                                                                                                         |
| `pnpm-lock.yaml`                                         | Workspace entry for `@t3tools/provider-omp`                                                                                                                                                 |
| `apps/web/index.html`                                    | `<title>`, splash label and logo alt say Garisek                                                                                                                                            |
| `apps/web/src/branding.ts`                               | Base name from the brand module; production stage `Latest`, so the display name is just "Garisek"                                                                                           |
| `apps/web/src/components/chat/TimelineAssistantRows.tsx` | Assistant author heading uses `APP_BASE_NAME`                                                                                                                                               |
| `apps/desktop/package.json`                              | `productName: "Garisek"`                                                                                                                                                                    |
| `apps/desktop/scripts/electron-launcher.mjs`             | Dev launcher name and bundle id                                                                                                                                                             |
| `apps/desktop/src/app/DesktopEnvironment.ts`             | Base name from the brand module; production window title has no stage suffix                                                                                                                |
| `apps/desktop/src/app/DesktopPreReadyPlatform.test.ts`   | Expects `Name=Garisek` in the Linux desktop entry                                                                                                                                           |
| `scripts/build-desktop-artifact.ts`                      | App id and product name from the brand module; macOS usage strings and protocol names; artifact files named `Garisek-<version>-<arch>.<ext>`                                                |
| `scripts/build-desktop-artifact.test.ts`                 | Expects the Garisek app id in passkey entitlements                                                                                                                                          |
| `apps/desktop/src/app/DesktopStatePaths.ts`              | Default base dir `~/.garisek`, so the desktop never writes into an installed T3 Code's `~/.t3`                                                                                              |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`        | Expects state under `~/.garisek`                                                                                                                                                            |
| `apps/desktop/src/app/DesktopAppIdentity.test.ts`        | Expects the Garisek runtime and About-panel names                                                                                                                                           |
| `apps/server/src/os-jank.ts`                             | `resolveBaseDir` defaults to `~/.garisek`                                                                                                                                                   |
| `apps/server/src/cli/browser.ts`                         | `sudo` browser setup resolves the invoking user's `~/.garisek`                                                                                                                              |
| `apps/server/src/cli/app.test.ts`                        | Desktop socket fixtures under `.garisek`                                                                                                                                                    |
| `packages/provider-pi/src/server/adapter.ts`             | A `switch_session` refused with `{code: "session_in_use"}` becomes `ProviderAdapterThreadInUseError`, so the server shows the refusal and does not fall back to a fresh native session (O3) |
| `packages/provider-pi/src/server/adapter.test.ts`        | Refused switch maps to ThreadInUse; an ordinary switch failure still maps to ResumeThread                                                                                                   |
| `apps/server/src/binCli.ts`                              | `--help` description                                                                                                                                                                        |
| `apps/server/src/cli/acpMcpBridge.ts`                    | Command descriptions                                                                                                                                                                        |
| `apps/server/src/cli/app.ts`                             | Command description                                                                                                                                                                         |
| `apps/server/src/cli/config.ts`                          | `--base-dir` flag description                                                                                                                                                               |
| `apps/server/src/cli/doctor.ts`                          | Command description                                                                                                                                                                         |
| `apps/server/src/cli/environment.ts`                     | Command descriptions                                                                                                                                                                        |
| `apps/server/src/cli/pair.ts`                            | Command description                                                                                                                                                                         |
| `apps/server/src/cli/server.ts`                          | `serve` description                                                                                                                                                                         |
| `apps/server/src/cli/service.ts`                         | Command descriptions                                                                                                                                                                        |
| `apps/server/src/cli/triage.ts`                          | Command description                                                                                                                                                                         |
| `apps/server/src/cli/up.ts`                              | Command description                                                                                                                                                                         |

## Deliberately unchanged

- **No `provider-omp` driver in `builtInDrivers.ts`.** OMP runs as a `pi` driver instance whose `binaryPath` is `garisek-omp-rpc`. The adapter refers to its driver kind in 76 places in `provider-pi/src/server/adapter.ts`. A second driver kind would mean forking that file, and upstream changes it constantly. The shim gets the same result; the only Pi adapter edit is the one-function `session_in_use` mapping listed above. The instance comes from deploy configuration (`providerInstances.omp` in the server's settings), not from code.
- The `t3` CLI name, the `T3CODE_*` environment variables (`T3CODE_HOME` still overrides the base dir), the `t3code://` URL scheme, the `t3code-v2` Electron userData name, the `~/.t3` paths that the SSH launcher creates on remote hosts, and the Linux window class (`com.t3tools.T3Code`). Renaming them would break upgrade paths and touch hundreds of files, and none of them shows a product name to the user. The local data home is the exception: it moved to `~/.garisek`, because sharing `~/.t3` with an installed T3 Code would mix the two apps' databases.
- **In-app prose that still says "T3 Code"** (about 99 web/desktop files: onboarding copy, error messages, update dialogs). This is a known F1 residual. Primary chrome (window title, web title, splash, assistant heading, app/bundle name, `--help`) says Garisek; deeper strings are not yet rebranded.
