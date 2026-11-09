# Garisek-OS — T3 Code Integration Scout

Scouting record for the Garisek fork of pingdotgg/t3code (upstream b07fdeb).
This document links to source rather than copying it; re-read the linked files
when upstream changes.

---

## (a) WebSocket RPC surface a client needs

The server speaks [Effect RPC](../../packages/contracts/src/rpc.ts) over a single
WebSocket at `/ws`. All wire methods are typed in
[`packages/contracts/src/rpc.ts`](../../packages/contracts/src/rpc.ts)
([`WS_METHODS`](../../packages/contracts/src/rpc.ts#415)) and
[`packages/contracts/src/orchestrationV2.ts`](../../packages/contracts/src/orchestrationV2.ts)
([`ORCHESTRATION_V2_WS_METHODS`](../../packages/contracts/src/orchestrationV2.ts#3606)).
Handlers live in [`apps/server/src/ws.ts`](../../apps/server/src/ws.ts).

### Key client operations

| Operation                      | Method (wire name)                                          | Schema                                 |
| ------------------------------ | ----------------------------------------------------------- | -------------------------------------- |
| List thread shells             | `orchestration.getArchivedShellSnapshot`                    | `OrchestrationV2ArchivedShellSnapshot` |
| Subscribe thread stream        | `orchestration.subscribeThread`                             | `OrchestrationV2ThreadStreamItem`      |
| Send a turn / dispatch command | `orchestration.dispatchCommand`                             | `OrchestrationV2Command`               |
| Interrupt active turn          | `orchestration.dispatchCommand` (with Stop command)         | `OrchestrationV2Command`               |
| Respond to approvals           | `orchestration.dispatchCommand` (approval-response command) | `OrchestrationV2Command`               |
| Read project file              | `projects.readFile`                                         | `ProjectReadFileError`                 |
| List project entries           | `projects.listEntries`                                      | `ProjectListEntriesError`              |
| Launch new thread              | `orchestration.launchThread`                                | `OrchestrationV2ThreadLaunchInput`     |
| Subscribe shell snapshot       | `orchestration.subscribeShell`                              | `OrchestrationV2ShellSnapshot`         |

The full `OrchestrationV2Command` discriminated union (all orchestration commands
including `start-turn`, `stop`, `runtime-request.respond`, etc.) is in
[`packages/contracts/src/orchestrationV2.ts`](../../packages/contracts/src/orchestrationV2.ts).

Clients must present a session credential in every upgrade (bearer token,
DPoP token, or browser cookie). Bearer/DPoP clients first obtain a short-lived
WebSocket ticket via authenticated HTTP (`GET /api/ws-ticket`).

---

## (b) Provider lifecycle and plug-in points

Reference: [`docs/internals/adding-a-provider.md`](../internals/adding-a-provider.md),
[`docs/internals/providers.md`](../internals/providers.md).

### Where a new `provider-omp` package plugs in

1. **Package** — `packages/provider-omp/` following the Pi layout:
   - `./settings` — settings schema built with `makeProviderSettingsSchema`
   - `./client` — `ProviderClientDefinition` (label, icon, settings schema); browser-safe
   - `./server` — `ProviderDriver` + adapter driver
   - `./testing` — internals for server-side replay testkits

2. **Server registration** — one line in
   [`apps/server/src/provider/builtInDrivers.ts`](../../apps/server/src/provider/builtInDrivers.ts#33)
   adds the driver to `BUILT_IN_DRIVERS`. Also add to `BUILT_IN_USAGE_DRIVERS` if
   the driver exposes usage data, to
   [`apps/server/src/provider/providerStatusCache.ts`](../../apps/server/src/provider/providerStatusCache.ts)
   for status-order position, and to
   [`apps/server/src/provider/model-manifest.json`](../../apps/server/src/provider/model-manifest.json).

3. **Client registration** — provider client definition in the web and mobile
   provider registries (search for `PiDriver` / `ProviderClientDefinition` in
   `apps/web/` and `apps/mobile/`).

4. **`PI_CODING_AGENT_SESSION_DIR` → `--session-dir`** —
   `AgentSessionScanner` ([`apps/server/src/project/AgentSessionScanner.ts`](../../apps/server/src/project/AgentSessionScanner.ts))
   looks for the `PI_CODING_AGENT_SESSION_DIR` env var on a provider instance to
   find session files for thread history import. For OMP, inject
   `PI_CODING_AGENT_SESSION_DIR: <session-dir>` in the launch environment and pass
   `--session-dir <path>` to `omp --mode rpc`. The `buildPiRpcLaunch` helper in
   [`packages/provider-pi/src/server/mcpInjection.ts`](../../packages/provider-pi/src/server/mcpInjection.ts)
   is the reference.

5. **AgentSessionScanner** does not need changes: it already reads
   `PI_CODING_AGENT_SESSION_DIR` from the provider instance's environment record
   and uses it to scan for `*.jsonl` session files.

---

## (c) Auth/pairing, remote, and headless service

Reference: [`docs/internals/environment-auth.md`](../internals/environment-auth.md),
[`docs/user/devices.md`](../user/devices.md), [`docs/internals/remote.md`](../internals/remote.md),
[`docs/user/background-service.md`](../user/background-service.md).

- **Pairing** — `t3 pair` mints a short-lived OTP that a browser or client
  exchanges for a bearer session. The returned credential is scoped;
  `access:write` scope is required to mint further pairing links.
- **Remote access** — the server binds an HTTP+WS port; clients connect directly
  over LAN/Tailscale or via T3 Connect (relay tunnel). No separate server type —
  the same `t3 serve` / service process handles all routes.
- **Headless service install** — `t3 service install` on Linux (systemd user
  service with lingering) and macOS (LaunchAgent). Managed via:
  - `t3 service install` / `t3 service uninstall`
  - `t3 service restart` / `t3 service status`
  - Environment variables in `~/.t3/service.env`
- **Port binding** — a background service with no configured host listens on
  every IPv4 interface but drops connections unless the peer is on loopback,
  LAN, or Tailscale. `T3CODE_PORT`, `T3CODE_HOST` in `service.env` override
  defaults.
- **MCP OAuth** — external agents sign in to `/mcp` via narrow OAuth; the
  authorization-code server in
  [`apps/server/src/auth/McpOAuth.ts`](../../apps/server/src/auth/McpOAuth.ts)
  handles approvals.

---

## (d) Persistence: T3 home and userdata layout

| Path                            | Contents                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `~/.t3/`                        | T3 home; default unless `T3CODE_HOME` or `--home-dir` overrides it                   |
| `~/.t3/userdata/statev2.sqlite` | Primary database (all projects, threads, settings, auth)                             |
| `~/.t3/userdata/state.sqlite`   | Legacy V1 database; kept for rollback; server copies it once if `statev2` is missing |
| `~/.t3/service.env`             | Env-file for the background service (KEY=VALUE, shell-unescaped)                     |
| `~/.t3/secrets`                 | Provider credentials store                                                           |
| `~/.t3/settings.json`           | Instance settings                                                                    |

Database engine: **SQLite** (accessed via Effect-based service layer).

Per-environment state: each dev worktree gets its own `<worktree>/.t3/userdata/`
so dev runs never land on the shared `~/.t3/userdata/` database. The server
copies a pruned snapshot of the real database on first start in a worktree
(projects + recent stopped threads, no tasks, no pairing tokens, no peer links).

---

## (e) OMP RPC command verdict table

Derived from the extended probe run; full receipt at
[`docs/garisek/receipts/omp-rpc-probe-2026-11-09T06-48-44.json`](receipts/omp-rpc-probe-2026-11-09T06-48-44.json).
Earlier receipts (initial full run, `--no-model` run) also in that directory.

Model used: `anthropic/claude-haiku-5-5` ($0.10/$0.50 per M tokens);
approximately **6 OMP model turns** total across all phases (Phase 1 prompt,
tool-call probe, abort probe, large-file probe). OMP binary: `omp/18.18.2`.

### Command derivation

Commands were derived by grepping `request({ type: "…" })` and `send({ type: "…" })`
in `packages/provider-pi/src/server/adapter.ts`, `status.ts`, and `textGeneration.ts`.

| Command                   | Verdict         | Notes                                                                                                                     |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `new_session`             | **supported**   | Returns success; OMP creates a new session file                                                                           |
| `get_state`               | **supported**   | Returns `model`, `sessionFile`, `isStreaming`, `pendingMessageCount`                                                      |
| `get_available_models`    | **supported**   | Returns `{ models: [...] }`                                                                                               |
| `get_commands`            | **unsupported** | "Unknown command: get_commands" — OMP does not implement this                                                             |
| `get_entries`             | **supported**   | Returns `{ leafId, entries: [...] }`                                                                                      |
| `get_messages`            | **supported**   | Returns `{ messages: [...] }`                                                                                             |
| `get_session_stats`       | **supported**   | Returns token usage                                                                                                       |
| `set_model`               | **supported**   | Accepts `{ provider, modelId }`                                                                                           |
| `set_session_name`        | **supported**   |                                                                                                                           |
| `set_thinking_level`      | **supported**   |                                                                                                                           |
| `fork`                    | **partial**     | Command understood; requires a non-empty session with valid entries; "Invalid entry ID for forking" on empty-session leaf |
| `switch_session`          | **supported**   | Returns success even for nonexistent path (creates new)                                                                   |
| `extension_ui_response`   | **send_only**   | Fire-and-forget in production; no ack observed                                                                            |
| `prompt`                  | **supported**   | Immediate ACK via `response` frame; model events follow asynchronously                                                    |
| `prompt` (steer)          | **supported**   | `streamingBehavior: "steer"` variant accepted                                                                             |
| `compact`                 | **partial**     | Command understood; "Nothing to compact (session too small)" on tiny session                                              |
| `abort`                   | **supported**   | ACK `success: true`; terminal frame is `session_settled`                                                                  |
| `clear_queue`             | **unsupported** | "Unknown command: clear_queue" — OMP does not implement this                                                              |
| `get_last_assistant_text` | **supported**   | Returns `{ text: "…" }`                                                                                                   |

### Settlement ordering (confirmed from tool-call probe)

A single-turn tool-call turn produces this exact sequence:

```
[prompt sent]
response (ACK, id-correlated)        ← prompt command acknowledged
agent_start                           ← OMP: same name as pi
turn_start                            ← OMP-only additional frame
message_start (role=user)
message_end   (role=user)
message_start (role=assistant)
message_update × N                    ← streaming deltas (see below)
message_end   (role=assistant)
tool_execution_start
tool_execution_end
message_start (role=user, tool result)
message_end   (role=user, tool result)
turn_end                              ← OMP-only; pi never emits this
turn_start                            ← second sub-turn for model reply
message_start (role=assistant)
message_update × N
message_end   (role=assistant)
turn_end
agent_end                             ← OMP-only; pi never emits this
extension_ui_request (optional)
prompt_result                         ← OMP-only; describes final outcome
session_settled                       ← OMP's `agent_settled` equivalent
```

The `session_settled` frame is the **sole reliable terminal signal**.
Pi's `agent_settled` is **never emitted** by OMP.

### `message_update.assistantMessageEvent.type` values

Observed across tool-call and large-file probes (from `assistantMsgEventTypes` field
in receipt):

| OMP `assistantMessageEvent.type` | pi adapter expects | Notes                                                              |
| -------------------------------- | ------------------ | ------------------------------------------------------------------ |
| `text_delta`                     | `text_delta`       | **same** — pi adapter handles this correctly                       |
| `text_end`                       | `text_end`         | **same** — pi adapter handles this correctly                       |
| `thinking_delta`                 | `thinking_delta`   | **same** — pi adapter handles this correctly                       |
| `thinking_end`                   | `thinking_end`     | **same** — pi adapter handles this correctly                       |
| `text_start`                     | (not in pi)        | New OMP frame; pi adapter `message_update` default case ignores it |
| `thinking_start`                 | (not in pi)        | New OMP frame; pi adapter ignores it                               |
| `toolcall_start`                 | (not in pi)        | Tool call argument streaming start; pi adapter ignores it          |
| `toolcall_delta`                 | (not in pi)        | Tool call argument streaming delta; pi adapter ignores it          |
| `toolcall_end`                   | (not in pi)        | Tool call argument streaming end; pi adapter ignores it            |

Pi's adapter `message_update` case reads `assistantMessageEvent.type` and falls
through to a no-op for unknown values, so the new OMP types are silently skipped
(correct behavior — the actual tool call surfaces via `tool_execution_start/end`).

### Full pi-event → OMP-event mapping

| pi adapter event                                      | OMP emits                                                 | Verdict for provider-omp                                                                |
| ----------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `agent_start`                                         | `agent_start` **+ `turn_start`**                          | **same name** ✓; also emit `turn_start` (OMP-only, can ignore)                          |
| `agent_settled`                                       | **never emitted**                                         | → handle `session_settled` instead                                                      |
| `message_start`                                       | `message_start`                                           | **same** ✓                                                                              |
| `message_end`                                         | `message_end`                                             | **same** ✓                                                                              |
| `message_update` (text_delta/end, thinking_delta/end) | `message_update` (same subtypes)                          | **same subtypes** ✓; new subtypes (text_start, thinking_start, toolcall_*) ignored      |
| `tool_execution_start`                                | `tool_execution_start`                                    | **same** ✓                                                                              |
| `tool_execution_end`                                  | `tool_execution_end`                                      | **same** ✓                                                                              |
| `tool_execution_update`                               | **never emitted**                                         | OMP emits start+end only; adapter code for `update` never fires                         |
| `compaction_start`                                    | `manual_compaction_start` **and** `auto_compaction_start` | **renamed** — two variants; pi adapter only knows one                                   |
| `compaction_end`                                      | `manual_compaction_end` **and** `auto_compaction_end`     | **renamed** — two variants                                                              |
| `extension_ui_request`                                | `extension_ui_request`                                    | **same** ✓                                                                              |
| `extension_error`                                     | (not observed)                                            | may appear; adapter handles it generically                                              |
| `response` (non-prompt)                               | `response`                                                | **same** ✓ for abort, set_model, etc.                                                   |
| `response` (command=prompt)                           | `response` (immediate ACK) + `prompt_result` (outcome)    | OMP adds an extra `prompt_result` unsolicited event; adapter should handle or ignore it |
| `auto_retry_start`                                    | (not observed)                                            | may appear in retry scenarios                                                           |
| `auto_retry_end`                                      | (not observed)                                            | may appear in retry scenarios                                                           |
| `t3.*` events                                         | **never emitted**                                         | T3-internal timer events; not applicable to OMP                                         |

### OMP-only frames (must be handled or ignored by provider-omp adapter)

| OMP event                   | When emitted                                         | Recommendation                                                       |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `ready`                     | Startup, before any command                          | Signal that OMP is ready to receive commands                         |
| `available_commands_update` | Startup; after context changes                       | Ignore or parse for `/` command palette                              |
| `model_changed`             | After `set_model` or model auto-switch               | Optionally update active model state                                 |
| `thinking_level_changed`    | After `set_thinking_level`                           | Optionally update active thinking level                              |
| `turn_start`                | With every `agent_start`                             | Signals sub-turn start; can be ignored or used for sub-turn tracking |
| `turn_end`                  | After each sub-turn completes                        | Intermediate; do NOT settle on this — wait for `session_settled`     |
| `agent_end`                 | After all sub-turns; before `session_settled`        | Contains full message history; precedes settlement                   |
| `prompt_result`             | After turn outcome (before `session_settled`)        | Contains `status: "completed"/"aborted"` and `sessionSettled` flag   |
| `queue_update`              | When queued prompt list changes                      | Replacement for `clear_queue` polling                                |
| `manual_compaction_start`   | Manual `/compact` triggered                          | Handle as `compaction_start`                                         |
| `manual_compaction_end`     | Manual compaction finished                           | Handle as `compaction_end`                                           |
| `auto_compaction_start`     | Automatic context threshold hit; `action: "handoff"` | Handle as `compaction_start`                                         |
| `auto_compaction_end`       | Automatic compaction finished; has `result.summary`  | Handle as `compaction_end`                                           |
| `advisor_yielded`           | Advisor finished evaluating the turn                 | Ignore                                                               |
| `notice`                    | Informational message from OMP                       | Optionally surface to user                                           |

### Advanced probe results

**Tool-call probe** (probe-input.txt with random token):

- Token found in final assistant text: **true** ✓
- `tool_execution_start` and `tool_execution_end` observed with `toolCallId`, `toolName`, `args`, `result`
- `tool_execution_update` **never emitted** — OMP tool execution has no streaming update frames
- Max JSONL frame size (over tool call): **4,172 bytes**

**Abort probe** (300-word essay prompt, aborted after first assistant `message_start`):

- Abort ACK: `{ success: true }` immediately
- Terminal frame sequence: `turn_end` → `agent_end` → `prompt_result { status: "aborted" }` → `session_settled`
- `prompt_result.sessionSettled: true` appears on the `prompt_result` frame before `session_settled`

**Large-file framing probe** (2,097,229-byte file, full read):

- Token found: **true** ✓
- Max JSONL frame size: **58,133 bytes** (tool_execution_end or message_end containing file content)
- `auto_compaction_start/end` triggered automatically (`reason: "threshold"`, `action: "handoff"`)
- OMP read the full 2MB file and provided a summary via `auto_compaction_end.result.summary`
- Context management via "handoff" strategy serializes the conversation for the next sub-turn

### Deltas `provider-omp` must handle vs `provider-pi`

| Delta                                                              | Location                                                                           | Approach                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Binary name: `pi` → `omp`                                          | `adapter.ts` driver settings; `binaryPath` default                                 | Change default binary to `"omp"`                                                                                                                                   |
| `--session-dir` already supported                                  | `mcpInjection.ts` `PI_ARGUMENTS_WITH_VALUES` set                                   | No change needed; already in allowed-with-values set                                                                                                               |
| `get_commands` absent                                              | `status.ts:176` — `request({type:"get_commands"}).pipe(Effect.orElseSucceed(...))` | Already safely wrapped with `orElseSucceed`; returns `undefined` gracefully                                                                                        |
| `clear_queue` absent                                               | `adapter.ts:1427` — `request({type:"clear_queue"}, 2_000)`                         | Needs `orElseSucceed(() => ({steering:[],followUp:[]}))` guard; not currently protected                                                                            |
| `agent_settled` absent                                             | `adapter.ts:2145` switch-case                                                      | Handle `session_settled` as `agent_settled` in OMP adapter                                                                                                         |
| `compaction_start/end` renamed                                     | `adapter.ts:1996–2063`                                                             | Handle `manual_compaction_start/end` and `auto_compaction_start/end` as `compaction_start/end`                                                                     |
| `response` → `prompt_result` for prompts                           | `adapter.ts:2167` response handler                                                 | `prompt_result` is a NEW supplemental unsolicited event; the correlated `response` ACK still arrives; handle `prompt_result` or add it to known-but-ignored events |
| `tool_execution_update` absent                                     | `adapter.ts:1990–1994`                                                             | The `update` case never fires; no issue                                                                                                                            |
| Event type remapping (`turn_start`, `turn_end`, `agent_end`, etc.) | `adapter.ts:1882` switch-case                                                      | These fall through to the `default: return` no-op; no active harm, but `session_settled` must be remapped to `agent_settled` logic                                 |
| Version gate: `compareSemverVersions(version, "0.80.5")`           | `status.ts:63,427`                                                                 | `parseGenericCliVersion("omp/18.18.2")` extracts `"18.18.2"` → passes both gates (18 > 0)                                                                          |
| `PI_AUTH_CHECK_VERSION = "0.84.1"`                                 | `status.ts:65,260`                                                                 | `"18.18.2" > "0.84.1"` → passes                                                                                                                                    |
| `fork` needs non-empty session entries                             | `adapter.ts:3189`                                                                  | No change needed; adapter handles fork failure                                                                                                                     |

**Upstreamable into `provider-pi` vs new package:**

- `clear_queue` guard (`orElseSucceed`) — upstreamable defensive fix in `provider-pi/adapter.ts`
- Event type remapping (`session_settled` → `agent_settled`, compaction renames, `prompt_result` handling) — must live in a new `provider-omp` adapter; pi-specific event names
- Binary default — must live in `provider-omp/settings.ts`

---

## (f) Desktop packaging

Reference: [`scripts/build-desktop-artifact.ts`](../../scripts/build-desktop-artifact.ts),
[`apps/desktop/package.json`](../../apps/desktop/package.json).

| Artifact               | Script target               | Notes                                                                      |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------- |
| Linux (AppImage / deb) | `vp run dist:desktop:linux` | Runs `scripts/build-desktop-artifact.ts` with `platform=linux`             |
| macOS (DMG + ZIP)      | `vp run dist:desktop:dmg`   | Runs `scripts/build-desktop-artifact.ts` with `platform=mac`, `target=dmg` |

**Key config values** (all in `scripts/build-desktop-artifact.ts`):

| Name             | Value                        | Source                                                                                              |
| ---------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `DESKTOP_APP_ID` | `"com.t3tools.t3code"`       | [`build-desktop-artifact.ts:65`](../../scripts/build-desktop-artifact.ts#65)                        |
| `productName`    | `"T3 Code (Beta)"`           | [`apps/desktop/package.json:43`](../../apps/desktop/package.json#43)                                |
| URL scheme       | `t3code://`                  | Registered in Electron; Linux `.desktop` file                                                       |
| Linux app ID     | `com.t3tools.T3Code.desktop` | [`DesktopEarlyElectronStartup.ts:34`](../../apps/desktop/src/app/DesktopEarlyElectronStartup.ts#34) |

**macOS signing env vars** (names only; values never committed):

| Variable               | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `T3CODE_APPLE_TEAM_ID` | 10-char Apple Developer Team ID                                  |
| `APPLE_API_KEY`        | App Store Connect API key file path                              |
| `APPLE_API_KEY_ID`     | API key ID (for notarization)                                    |
| `APPLE_API_ISSUER`     | API issuer ID                                                    |
| `CSC_LINK`             | macOS code-signing certificate (deleted for custom signing path) |
| `CSC_KEY_PASSWORD`     | Certificate password (deleted for custom signing path)           |

Build script: [`scripts/build-desktop-artifact.ts`](../../scripts/build-desktop-artifact.ts).

---

## (g) Branding surfaces

The product name "T3 Code" is rendered in four places; a fork that renames
the product needs to touch all of them:

| Surface                              | Location                                                                                                                           | How it renders                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Web page title / header              | [`apps/web/src/branding.ts:19`](../../apps/web/src/branding.ts#19) `APP_BASE_NAME = "T3 Code"`                                     | Used in `<title>`, welcome wizard, standalone page logo               |
| Desktop window title                 | [`apps/desktop/src/app/DesktopEnvironment.ts:88`](../../apps/desktop/src/app/DesktopEnvironment.ts#88) `APP_BASE_NAME = "T3 Code"` | Composed into `displayName = "T3 Code (Beta)"`                        |
| Desktop app display name / installer | [`apps/desktop/package.json:43`](../../apps/desktop/package.json#43) `productName: "T3 Code (Beta)"`                               | Shown in OS app launcher and DMG installer                            |
| Server CLI `--help` / messages       | Scattered in [`apps/server/src/cli/`](../../apps/server/src/cli/)                                                                  | "T3 Code" appears in error messages, `--help` text, MCP resource name |

The web branding reads `window.desktopBridge?.getAppBranding()?.baseName` first,
so the desktop app can override the web's hardcoded `"T3 Code"` string at runtime
via `DesktopEnvironment.ts`. A single branding module that exports `APP_BASE_NAME`
and `APP_DISPLAY_NAME` and is imported from `branding.ts`, `DesktopEnvironment.ts`,
and `cli/` would let one value own all surfaces.

---

## Baseline

Upstream b07fdeb on avion. `scripts/garisek/test-all.sh`; raw results are in `/tmp/garisek-baseline/tests.jsonl` (not committed). Typecheck: 41/41 packages pass.

| Package            | Exit | Tests                                     | Failing                                                                                                                           |
| ------------------ | ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@t3tools/desktop` | 1    | 1003 passed (1003)                        | `src/app/DesktopLinuxUrlHandler.test.ts`, `src/backend/DesktopBackendManager.test.ts`                                             |
| `t3`               | 1    | 1 failed · 6946 passed · 5 skipped (6952) | `src/storageCleanup.test.ts`                                                                                                      |
| `@t3tools/web`     | 1    | 3 failed · 5652 passed (5655)             | `src/components/files/AttachmentFilePreview.browser.test.tsx`, `src/components/settings/CloudVoiceConfiguration.browser.test.tsx` |
| `@t3tools/scripts` | 1    | 5 failed · 256 passed · 1 skipped (262)   | `install.test.ts`                                                                                                                 |

The other 32 packages pass (10841 tests). Known causes of the failures:

- desktop: two files fail to load because of a broken electron install race; all 1003 of the tests that ran pass.
- t3: `storageCleanup` fails on one checksum comparison.
- web: three Chromium browser tests fail.
- scripts: `install.test.ts` installer checksum, 5 tests.

None of these packages was touched by a Garisek change at baseline. A post-change failure is a regression only if it is not on this list.
