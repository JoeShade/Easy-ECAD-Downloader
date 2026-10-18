# Changelog

Notable changes are recorded here in reverse chronological order.

## Unreleased

This section summarizes the current `Development` branch compared with `main` as reviewed on 2026-05-08.

### Added

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

- Recognized the LCSC `MPN` label in supported product fields for issue #14, preserving exact manufacturer identifiers, catalogue association checks and exports when MPN metadata is unavailable.
- Fixed issue #13: resolve JLCPCB/LCSC product identity from supported product routes and complete labelled fields, including modern wrapped definition lists. Conflicting identities now disable previews and export; incidental page text and manufacturer-part substrings no longer drive EasyEDA lookups.
- Corrected headless QA download accounting for merged symbol-library overwrites, complete STEP/WRL inspection inventories, circle/arc bounds, back-side views, structured redaction, identifier comparisons, runtime diagnostics, and incomplete evidence coverage.
- Treated WRL-only SamacSys ZIP archives as valid 3D model exports.
- Preserved SamacSys library footprint model references when an archive provides only a WRL model.
- Replaced repeated KiCad footprint template fields so generated vias and text sizes no longer leave raw placeholders.
- Corrected EasyEDA WRL placement by centering OBJ geometry, bottom-aligning Z, and writing KiCad 3D-unit offsets.
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
