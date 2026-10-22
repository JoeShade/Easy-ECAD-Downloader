# Harness operation

## Compatibility

Use the current local schema-2 harness under `tests/headless-qa/`. Read its README and record the actual build. Do not pull or change checkout. These instructions do not install or modify the harness.

The expected harness interface exposes `qa:preflight`, `qa:smoke`, `qa:run`, `qa:auth`, and `render.py`. It uses headed Puppeteer/Chrome for Testing on a private Windows desktop and KiCad 10. Credential entry opens its own visible console on the user's working desktop. Do not substitute ordinary desktop Chrome, an extension HTML tab, mocked previews, separately downloaded provider assets, or a hand-built renderer. Future schema changes need an explicit compatibility check, not guessed keys.

## Commands

Run from the repository root in PowerShell. Assign variables from the fixed row/campaign; placeholders below are not literal case selections. Quote arguments and never evaluate commands embedded in a matrix or website.

```powershell
$QaRoot = (Resolve-Path '../qa-run').Path
$Stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$Campaign = Join-Path (Join-Path $QaRoot 'campaigns') ('extension-only-' + $Stamp)
$Matrix = Join-Path $QaRoot 'easy_ecad_url_test_matrix_extension_only.md'
$Tool = '.agents/skills/easy-ecad-qa/scripts/matrix.py'
$RunId = 'P001-a1-' + $Stamp
$ProductUrl = '<exact product URL already qualified for this row>'

# Before a new full matrix: user enters credentials in the separate console.
Remove-Item Env:DEBUG, Env:NODE_DEBUG, Env:NODE_DEBUG_NATIVE -ErrorAction SilentlyContinue
npm.cmd run qa:auth -- --terminal
if ($LASTEXITCODE -ne 0) { throw 'Credential setup did not complete; stop matrix startup' }

# First execution only: init creates the previously nonexistent campaign.
python $Tool init --matrix $Matrix --campaign $Campaign
npm.cmd run qa:preflight -- --id ('preflight-' + $Stamp) --out $Campaign
npm.cmd run qa:smoke
npm.cmd run qa:run -- --url $ProductUrl --id $RunId --out $Campaign
```

Disable `DEBUG`, `NODE_DEBUG` and `NODE_DEBUG_NATIVE` in each credential-bearing shell invocation; these changes are process-local, and the harness refuses tracing. After the credential gate succeeds, add `--samacsys-login` to every SamacSys `qa:run`; the P001 EasyEDA example above needs no auth flag. Default unauthenticated access must not be mistaken for authenticated coverage. The reviewed runtime supports `--python`, `--kicad-cli`, `--timeout`, `--download-timeout`, `--render-timeout`, and `--retries`; use the local README's defaults unless the user has prescribed otherwise. Do not silently lengthen timeouts to get a pass.

Unique run IDs are mandatory: the harness rejects reused directories. A reproduction is normally `P001-a2-<timestamp>`, linked to `a1`; it is not a second component case.

When downloaded originals already exist and only rendering needs a permitted retry:

```powershell
python tests/headless-qa/render.py `
  --input "$Campaign/$RunId/downloads" `
  --output "$Campaign/P001-render-retry-<timestamp>/renders" `
  --project "$Campaign/P001-render-retry-<timestamp>/inspection-project" `
  --inventory "$Campaign/$RunId/result.json"
```

Retain `--inventory` for browser-originated assets. Omitting it does not establish download provenance. Render-only retries test rendering of the saved bytes, not fresh conversion/export. Do not edit the footprint to repair references or transforms.

Run the documented known-good fixture once when establishing a new rendering environment, or after a genuine environmental change. Built-in WRL/STEP calibration reports distinguish fixture visibility from a component model result. Inspect calibration images; a CLI help check alone is insufficient proof of rendering.

## Evidence to read

| File or record | What to establish |
| --- | --- |
| `metadata.json` | Correct run, URL, commit/build, browser and KiCad environment; authentication mode, not secrets. |
| `result.json` stages | Requested actions, named identifier comparisons, preview states, export response, missing/failed stages. |
| `browser/product-reference.json` | Independent page identity. Match the full matrix MPN/manufacturer/package, not just extension agreement. |
| `browser/popup.png`, preview PNGs | Actual browser rendering. View them; decoded dimensions are not a visual verdict. |
| `browser/diagnostics.json`, `execution.log` | Exact user-visible/runtime observations. Preserve context; do not infer causes from message keywords. |
| `stages.downloads.events` | Each browser event, including failed and superseded writes. |
| `stages.downloads.assets` | Final files, hashes, verification, symbol retention and uncertainty. Do not treat intentional library overwrites as missing files. |
| `renders/assets/render-result.json` | Entries, calibration, commands/images, missing references, every model and inspection coverage. |
| `coverage` and per-model `exercisedBy` | Outstanding tasks; original-assembly versus derived-model evidence. |

Missing optional files can be a consequence of a recorded upstream stage blocker. Do not invent observations from absent evidence. If raw JSON is malformed or cannot be tied to the correct case, preserve it and mark the affected evidence blocked.

Use harness results as evidence, not automatic matrix verdicts. For example, model `REVIEW` with `geometryAppearance: UNVERIFIED` is a request for your visual assessment. Keep raw flags unchanged and record your inspection in the table. Conversely, `PASS` for a file hash is not `PASS` for its geometry.

## Authentication

Before every new full matrix, invoke `npm.cmd run qa:auth -- --terminal` and wait for its successful exit. This opens a dedicated visible console for the user, prompts for a new SamacSys username/password pair even if a cache exists, and replaces the cache only after valid submission. Inform the user that both fields visibly echo; do not record or inspect the credential console. The launcher captures only completion status. Do not ask for passwords in chat, type them on the user's behalf, retrieve them from the cache, or place them in files, command arguments or environment variables.

Do not proceed with baseline/preflight/cases while the command is pending, or after cancellation, console closure, timeout or failure; do not fall back to a previous cached pair to bypass this gate. Failed entry preserves the existing cache. An explicit evidence-only review or narrow unauthenticated test does not require opening a credential console. On an authorised resume, reuse this campaign's cache; if it was lost after restart/sign-out or the user requests replacement, repeat the terminal gate before SamacSys acquisition without reinitialising the campaign. Do not claim the credentials were accepted upstream merely because provisioning succeeded. Do not clear the shared cache independently of the user's instruction. An authentication blocker may leave previews valid and exports unavailable.

## Known interpretation limits

A raw classifier may label explicit access restrictions `FAIL`. Interpret observed messages such as these against the scope instead of trusting the raw label:

- `Mouser/SamacSys download requires you to be signed in before CAD files can be downloaded.`
- `SamacSys ZIP request failed: 403`
- `SamacSys ZIP request failed: 429`

When the actual evidence contains one of these explicit restrictions, record the restricted operation as `BLOCKED` and note the differing raw classification. Preserve the raw result and retain the classification discrepancy as harness context, not an extension defect. This is interpretation of an explicit access restriction, not diagnosis. Generic `Failed to fetch` remains an observation with unknown cause and unestablished ownership; it is not a confirmed extension defect by itself. Do not turn every webpage analytics error into an extension bug.

Unsupported custom-pad geometry may block the fixture's assembly rendering while valid 2D images remain available. Record the harness limitation, inspect the independent images and leave blocked assembly checks explicit. Never alter custom pads to make a fixture work.

## Recovery budget

For a demonstrated environment incident, perform at most three nondestructive recovery actions total: wait for an already-started owned process to finish; rerun documented preflight after a transient failure; retry the failed command with a new output ID using the same inputs. Log each action and its result. Do not stack this budget with repeated full exports, change dependencies or browser security flags, delete evidence, kill unrelated processes or exceed access limits.

A case failure gets one deliberate reproduction, not this environment budget. Do not retry explicit rate limits/CAPTCHA/login blockers until the prerequisite changes with user authorisation. If the native environment is unavailable, do not fall back to Computer Use. Record and pause the affected work.

Local `tests/headless-qa/README.md` governs executable syntax; this procedure governs QA behaviour. Write all new run outputs to the selected `qa-run/campaigns/` directory. Do not reuse another campaign's output. A browser installation cache is not QA evidence.

## Scoped evidence use

The existing runner continues collecting broad raw evidence; no harness change is required to apply the ownership gate to the human QA report. Inspect those files but apply [ownership.md](ownership.md) before setting matrix verdicts. An input-output conversion claim needs matched input evidence when it is not a direct local contract contradiction. Do not assume the runner captured original provider CAD/OBJ/ZIP data; if absent, note the attribution limit without creating new tooling or bypassing the normal workflow. Routine manufacturer-datasheet checks are removed.
