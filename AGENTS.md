# AGENTS.md

## Repository at a glance

This repository is a compact browser extension that detects supported distributor part contexts and exports CAD assets in KiCad-friendly formats.

- `src/content_script.js`: page detection for EasyEDA/LCSC and SamacSys-backed Mouser/Farnell contexts
- `src/popup.js`: popup UI state, settings interaction, preview requests, and export requests
- `src/service_worker.js`: thin background entrypoint that registers the runtime
- `src/service_worker_runtime.js`: provider routing, runtime gating, response shaping, and worker dependency composition
- `src/core/`: shared worker helpers for settings, downloads, preview data, export artifacts, and storage-backed libraries
- `src/sources/`: EasyEDA and SamacSys source adapters and upstream fetch/archive helpers
- `src/kicad_converter.js` and `src/kicad/`: EasyEDA-to-KiCad conversion and OBJ-to-WRL conversion
- `tests`: regression suite for pure logic, implementation behavior, and repository hygiene

`systemDesign.md` is the design source of truth.

## Expected working method

- Make small, explicit changes.
- Prefer test-first or test-in-lockstep development.
- Preserve the current runtime split instead of inventing extra layers.
- Move code, tests, and documentation together. Do not leave design drift behind.
- Do not refactor production files unless behavior or repository rules require it.

## Comments and explainers

- Add comments only when logic or data-shape handling is non-obvious.
- Keep explainers for conversion rules, browser API boundaries, storage/download behavior, and preview-generation logic.
- Avoid narration comments and cosmetic rewrites.

## Testing expectations

- Install dev dependencies with `npm install`.
- Add or update tests with every substantive behavior change.
- Prefer regression tests for bug fixes.
- Use test-only harnesses, mocks, fixtures, and loaders instead of production refactors for testability.
- Run `npm run lint` for JavaScript source or test changes.
- For QA harness Python changes, install its pinned image/lint requirements and run `npm run qa:lint` plus `npm run qa:smoke` as described in `tests/headless-qa/README.md`.
- Run targeted tests while iterating.
- Run `npm run validate` before finalizing when Node/npm are available.

## Using `systemDesign.md`

- Treat `systemDesign.md` as authoritative for supported behavior and module boundaries.
- Update it whenever implemented architecture, supported workflows, output rules, or repository constraints change.
- If code and design disagree, fix the code or rewrite the design in the same change.

## Documentation expectations

- Update `README.md` when setup, testing, capabilities, or operator-visible behavior changes.
- Keep `docs/architecture-notes.md` short and implementation-focused.
- Use `docs/deviations.md` only for live temporary mismatches between code and design.
- Do not turn tracked docs into backlog, review scratch space, or speculative cleanup lists.

## Validation and self-review

- Verify the touched behavior directly.
- Run the relevant tests while iterating and the full suite before finalizing.
- Do a self-review for correctness, architecture fit, documentation drift, and test coverage gaps.
- Report assumptions, residual risks, and blocked work explicitly.

## Repository hygiene

- Keep generated archives, scratch artifacts, and disposable outputs out of the tracked tree.
- Remove obsolete references when files or behaviors change.
- Keep test harnesses and developer support code under `tests/` or other clearly developer-only locations.
- Let the repo-hygiene tests enforce governance files, footer coverage, and documentation discipline.
- Keep CI, linting, audit, and local validation scripts aligned.

## Source footer

- Applicable maintained source files in this repository are:
  - JavaScript source files under `src/`
  - JavaScript tests under `tests/`
  - JavaScript developer support scripts added for testing or repository support, if any
- Apply the canonical footer from `source-code-footer.txt` exactly when that file is available.
- Adapt only the comment syntax when a non-JavaScript applicable source file ever requires the same footer.
- Keep footer placement consistent across applicable files.
- Do not apply the footer to Markdown docs, assets, images, fixture data, `manifest.json`, HTML/CSS unless the supplied footer policy explicitly requires it, generated files, or lockfiles.
