# Architecture Notes

This file records short implementation notes that supplement, but do not replace, [systemDesign.md](../systemDesign.md).

## Layer boundaries

- `src/content_script.js`: DOM inspection and provider-aware part-context detection only
- `src/popup.js`: popup UI state, preview requests, Firefox SamacSys relay gating, settings-page launch, and export requests
- `src/settings_page.js`: persistent download layout plus session-first SamacSys auth settings and Firefox-only advanced helper settings
- `src/service_worker.js`: thin runtime entrypoint only
- `src/service_worker_runtime.js`: provider routing, runtime gating, response shaping, and composition of worker dependencies
- `src/core/*.js`: shared worker business logic for settings, downloads, storage-backed symbol-library handling, shared export artifact writing, and common normalization
- `src/sources/*.js`: source adapters plus source-specific fetch/parse/export helpers
  - `src/sources/samacsys_distributor_adapter.js` is the shared backend adapter for Mouser, Farnell, element14, and Newark
- `src/sources/samacsys_common.js` holds the shared SamacSys preview, ZIP, relay-cookie, relay-auth, upstream-auth, direct-request ZIP-auth fallback, and asset-rewrite helpers
- `src/kicad_converter.js`: stable public converter facade
- `src/kicad/*.js`: EasyEDA parsing, KiCad text generation, shared conversion math, and OBJ-to-WRL conversion
- `src/vendor/zip_reader.js`: minimal runtime ZIP extraction for SamacSys archives

## Testability notes

- `src/kicad_converter.js` should stay the stable facade for converter tests, while pure conversion details live under `src/kicad/`.
- `src/content_script.js` should stay small and DOM-driven so it can be exercised with markup fixtures.
- `src/popup.js` should keep browser messaging and DOM updates visible enough to test with mocked `chrome.*` APIs.
- `src/service_worker_runtime.js` should hold browser-dependent orchestration, with tests using mocks instead of browser-run end-to-end flows.
- Source-specific helpers should be testable directly without exposing router internals just for test coverage.

## Optional QA harness

- `tests/headless-qa/` keeps browser acquisition, evidence preservation and KiCad inspection in developer-only modules. Browser-run rendering checks current file sizes and SHA-256 hashes against the verified final-asset inventory.
- Headed Chrome starts minimized on a private Win32 desktop, then restores there for genuine popup/screenshot checks without switching the user's input desktop. A Python launcher forwards the CDP pipes, owns the Chrome process job, and confirms process/desktop cleanup before profile deletion; isolation failure has no foreground fallback.
- Full-matrix startup first waits for `qa:auth -- --terminal`: a separate visible credential console with unredirected streams, a parent cancellation pipe and exit-status gating. New credentials replace the volatile cache only after valid entry; SamacSys rows then opt into the existing session provisioning path.
- Concurrent JSON saves publish snapshots in call order. Download accounting survives popup closure; temporary acquisition cleanup rechecks preserved bytes after confirmed Chrome exit and retains uncertain files for recovery.
- `npm run qa:lint` and `npm run qa:smoke` share their Python pins and commands with the offline QA CI job. Native browser/KiCad runs remain opt-in evidence gathering.

## Current implementation caveats worth preserving

- The popup does not fetch, extract, or convert CAD assets directly; it only requests that work.
- The runtime/router owns provider branching, while source adapters own source-specific preview and export behavior.
- Farnell, element14, and Newark do not have their own backend adapter files because they intentionally reuse the shared SamacSys distributor backend.
- Symbol library append behavior depends on `chrome.storage.local`, not on local filesystem reads.
- Library-mode download paths remain relative to Downloads and are resolved from extension settings, not absolute filesystem paths.
- EasyEDA model writes opt into bounded ID-scoped terminal receipts in `src/core/download_receipts.js`; ordinary artifact writers and `downloadCount` keep their started-only semantics. Event-triggered queries plus polling recover fast or missed completion, and cancellation/terminal state governs Blob cleanup. Worker termination abandons pending exports without persistent recovery.
- EasyEDA footprints select a completed WRL, falling back to completed STEP, using the observed basename only within the validated requested model layout. Optional model failures warn and strip stale references if neither model is usable. Portable output assumes grouped directories are retained or loose files are co-located in the project; arbitrary per-file Save As overrides and final footprint destinations are not independently verified.
- EasyEDA WRL conversion keeps OBJ geometry centered in X/Y and bottom-aligned in Z; the footprint model offset is emitted in KiCad 3D units rather than footprint millimetres.
- SamacSys distributor support is still Chrome-first, but Firefox can opt into a user-managed relay through the advanced Firefox settings menu.
- Chrome direct SamacSys ZIP export now retries once with configured upstream auth after a `401`, but preview requests still use the normal direct browser session without preemptive auth headers.
- Firefox relay mode forwards matching `componentsearchengine.com` cookies so authenticated SamacSys ZIP downloads can reuse the browser session instead of teaching the relay to log in.
- Firefox relay mode can also generate the upstream SamacSys HTTP Basic auth header locally from optional username/password credentials.
- Optional helper tokens and SamacSys passwords are session-only by default; the settings page requires explicit opt-in before remembering them in browser local storage.
- Relay auth and upstream SamacSys auth are separate: relay auth is sent only on the Worker POST, while upstream auth is forwarded inside the relay payload.
- SamacSys ZIP-export `401` responses are mapped to a sign-in-required error because upstream authentication can be stricter for downloads than for previews.
- SamacSys ZIP extraction treats `KiCad/` and `3D/` directories as valid whether they appear at the archive root or under a part-specific parent folder.
- The current repository is intentionally compact; add new sources through focused adapters or distributor detection changes rather than introducing a broader application framework.
- The manifest intentionally declares both `background.service_worker` and `background.scripts` so Chrome can run the service worker while Firefox falls back to a background document on Firefox 121+.
