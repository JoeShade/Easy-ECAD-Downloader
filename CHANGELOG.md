# Changelog

Notable changes are recorded here in reverse chronological order.

## Unreleased

This section summarizes the current `Development` branch and working-tree changes compared with `main`, reviewed on 2026-10-22.

### Added

- Added `qa:auth -- --terminal` to open a dedicated credential console and gate full-matrix startup on successful entry, preserving the existing cache after cancellation or invalid input.
- Added visible terminal entry and an encrypted Windows volatile-registry cache for headless QA SamacSys credentials, reused across runs until restart or user-hive unload, with `qa:auth` setup and clearing commands.
- Added Mouser SamacSys support for part detection, preview loading, upstream KiCad ZIP download, and KiCad library or loose-file export.
- Added Farnell SamacSys support through the shared SamacSys distributor flow.
- Added Firefox SamacSys relay support for preview and export requests through a user-managed relay URL.
- Added SamacSys authentication settings for relay auth and upstream username/password Basic auth generation.
- Added a configurable Downloads-relative KiCad library folder.
- Added runtime ZIP extraction for SamacSys archives, including KiCad symbols, footprints, STEP models, and WRL files already present in the archive.
- Added `systemDesign.md`, architecture notes, Firefox relay documentation, contribution guidance, and security reporting documentation.
- Added a Node/Vitest regression suite covering content-script detection, popup behavior, service-worker orchestration, EasyEDA conversion, and repository hygiene.
- Added CI, ESLint, dependency audit, `npm run validate`, `.nvmrc`, and `package-lock.json` for repeatable local and GitHub Actions validation.
- Added repository hygiene checks for source footers, governance docs, validation wiring, high-confidence secret patterns, generated archives, local environment files, logs, editor files, and temporary files.
- Added repository hygiene checks for conventional file naming, lower camelCase function declarations, and maintained-file line-count limits.

### Changed

- Switched browser QA to headed Chrome on a private Windows desktop, starting minimized and activating only within that desktop, with debugging-pipe continuity, owned process-tree cancellation and verified cleanup before temporary-profile deletion.
- Renamed the extension to Easy ECAD Downloader, including package metadata, UI labels, documentation links, generated KiCad metadata, and the default library folder name.
- Split the service worker into a thin Manifest V3 entrypoint plus a runtime/router module with source adapters and shared core helpers.
- Split the EasyEDA-to-KiCad converter into focused parser, emitter, shared conversion, and OBJ-to-WRL modules while keeping `src/kicad_converter.js` as the public facade.
- Split the oversized service-worker regression file into focused core, EasyEDA, direct SamacSys, and Firefox SamacSys test files backed by a shared harness.
- Reworked the popup into a provider-aware UI that shows fixed manufacturer metadata plus source-specific part metadata and advanced SamacSys/Firefox settings.
- Moved persistent download layout, Firefox relay, and SamacSys auth settings from the popup into a dedicated extension settings page.
- Grouped Firefox helper controls into a Firefox-only advanced settings menu.
- Added explicit `Save` and `Discard` controls to the settings page.
- Made helper tokens and SamacSys passwords session-only by default, with explicit remember-on-this-device opt-ins and warning copy.
- Removed hidden upstream `Authorization` capture, manual override handling, and automatic Firefox auth-refresh retry behavior.
- Updated the manifest for Chrome service-worker operation and Firefox background-document fallback on Firefox `121+`.
- Updated README and project docs to describe supported providers, setup, settings, auth behavior, browser support, validation, and repository layout.

### Fixed

- Preserved non-plated footprint holes, normalized custom-pad whitespace, kept independent symbol path subpaths separate, and accepted SVG signed/exponent numeric syntax.
- Corrected footprint model offsets to millimetres, independently verified with KiCad 10; WRL vertex scaling remains separate. Preserved OBJ faces with default materials and relative indices, and rejected malformed geometry.
- Kept settings saves and popup requests waiting for the initial stored snapshot, surfaced storage-read failures, and kept reload guidance accessible while the settings form is inert.
- Rejected control characters and portable-filename-invalid punctuation in library roots before browser downloads can rename or reject the requested layout.
- Merged compact and multi-symbol KiCad libraries structurally, preserving existing definitions and distinguishing nested units from root-symbol names.
- Rejected redirects from the configured Firefox relay endpoint to protect upstream credentials carried in its JSON body.
- Blocked browser QA assembly rendering when any referenced model is absent from the verified download inventory, retaining outstanding inspection evidence.
- Serialized pending popup exports and settings saves; restored remembered settings after failed session-secret migration and retained a clear partial-save error if restoration fails.
- Restricted authenticated SamacSys requests and relay redirect hops to approved HTTPS destinations; corrected the relay guide's secret name and Bearer-token setup.
- Serialized shared symbol-library updates, surfaced storage failures, preserved ZIP form queries and used one string-aware footprint model editor across providers.
- Validated ZIP structure, checksums and expanded sizes with a 256 MiB ceiling; malformed and unsupported archives now fail before CAD export.
- Escaped KiCad strings and SVG paths, normalized library identifiers, corrected footprint graphic layers/rectangle units, symbol polyline closure and circular-arc sweep/radius handling, and bounded large OBJ conversion with valid default materials.
- Restored compact and comma-separated absolute M/L/Z symbol paths through the shared parser; removed unused popup settings selectors after verifying the separate options-page stylesheet owns those controls.
- Rejected overflowing QA timer budgets, aligned Python secret redaction and preserved primary private-desktop startup errors during cleanup.
- Expanded explainer coverage to executable tooling and security scans to Python, PowerShell and module/configuration text.
- Extended hygiene coverage to local matrix scripts and additional workflow files, explained matrix publication/locking, and allowed live deviations with explicit requirements, observed behavior and closure conditions.
- Hardened QA evidence persistence, failure exits, popup-loss accounting, post-browser download cleanup, malformed CAD inspection records, and renderer inventory verification; added regression coverage and Python lint/smoke checks in CI.
- Fixed issue #16's missing EasyEDA symbol preview paths, restoring captured diode bodies and LED arrowheads while preserving filled and hollow `PT`/`PL`/`PG` graphics without changing CAD exports.
- Fixed issue #17's EasyEDA model-selection boundary: wait for ID-scoped browser completion, reference delivered STEP/WRL basenames after renames, fall back from failed WRL downloads, and omit references when model completion or the requested directory layout cannot be verified. Added bounded lifecycle handling and regression coverage for all eight reported names.
- Recognized the LCSC `MPN` label in supported product fields for issue #14, preserving exact manufacturer identifiers, catalogue association checks and exports when MPN metadata is unavailable.
- Fixed issue #13: resolve JLCPCB/LCSC product identity from supported product routes and complete labelled fields, including modern wrapped definition lists. Conflicting identities now disable previews and export; incidental page text and manufacturer-part substrings no longer drive EasyEDA lookups.
- Corrected headless QA download accounting for merged symbol-library overwrites, complete STEP/WRL inspection inventories, circle/arc bounds, back-side views, structured redaction, identifier comparisons, runtime diagnostics, and incomplete evidence coverage.
- Treated WRL-only SamacSys ZIP archives as valid 3D model exports.
- Preserved SamacSys library footprint model references when an archive provides only a WRL model.
- Replaced repeated KiCad footprint template fields so generated vias and text sizes no longer leave raw placeholders.
- Corrected EasyEDA WRL placement by centering OBJ geometry and bottom-aligning Z; footprint model offsets use millimetres independently of WRL vertex units.
- Rendered EasyEDA footprint previews for oval pads and solid-region geometry used by several LCSC footprints.
- Detected JLCPCB manufacturer part numbers when product pages use compact labels such as `MFR.Part #`.
- Improved provider-aware page detection for JLCPCB, LCSC, Mouser, and Farnell product pages.
- Reconciled EasyEDA footprint model references with exported STEP/WRL artifacts and removed stale model blocks when no 3D artifact is exported.
- Preserved SamacSys KiCad library relationships by rewriting symbol footprint properties and footprint model paths in library mode.
- Handled SamacSys ZIP structures where `KiCad/` and `3D/` folders appear either at the archive root or under a part-specific parent folder.
- Reworked SamacSys ZIP `401` handling into clearer sign-in-required errors and retry behavior.
- Kept relay auth separate from upstream SamacSys auth so relay credentials are not forwarded to upstream providers.
- Saved EasyEDA datasheets in the documented library-mode `datasheets/` folder and warned when selected export assets are unavailable.
- Removed real-looking SamacSys auth values from tests and fixtures.
- Removed a stale repository review plan from tracked docs so `systemDesign.md` remains the design source of truth.

### Security

- Documented credential storage, relay responsibility, vulnerability reporting, and stored credential clearing in `SECURITY.md`.
- Added automated checks for common secret/token formats and private-key material in text files.
- Added ignore rules and hygiene checks for local secret files, generated extension archives, logs, editor backups, OS metadata, and temporary files.
- Added full-history security hygiene validation for reachable Git commits.
