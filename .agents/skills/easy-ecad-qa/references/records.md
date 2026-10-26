# Extension-only records, reproduction and resuming

## Authority and mapping

Use the selected extension-only matrix. The packaged fresh start has 300 NOT RUN rows with unset checks, resolved URLs and findings. Initialise a new baseline in `qa-run/campaigns/`; no other results file is needed or to be imported. The Markdown table is the human-readable findings record. Harness JSON is immutable raw evidence; campaign JSON is bookkeeping, not a replacement bug database. Do not duplicate the entire table into a competing tracker.

The supplied `scripts/matrix.py` supports the existing 19-column matrix. Its first eight columns are fixed: `ID`, `Site`, `Backend/route`, `Manufacturer`, `Fixed MPN`, `Target package / geometry (verify)`, `Starting URL`, `Entry`.

Only `Resolved product URL`, the eight check columns, `Case status` and `Findings / reproduction / evidence` can change. The helper requires a full-file SHA-256 expectation, validates the fixed rows/order against a baseline, takes a backup, and atomically replaces the table after a guarded update. It never infers a test verdict. Unsupported schemas fail closed; do not recreate or reformat the user's matrix to force compatibility.

| Matrix result | Evidence and required interpretation |
| --- | --- |
| Source # detection | Page reference versus detected source code and popup value. |
| Manufacturer/MPN detection | Supported exact MPN/manufacturer comparisons; missing unimplemented manufacturer-name display is not a defect. |
| Symbol preview / Footprint preview | Actual visual examination of local generation/display, with source-content ownership kept separate. |
| Download | Normal export, final files and explicit availability/warnings. |
| KiCad symbol | Exported entries/units inspected for local transfer/format integrity, not datasheet electrical correctness. |
| KiCad footprint | Relevant front/back images checked for local transfer/format integrity, not a manufacturer land-pattern audit. |
| KiCad 3D | Every supplied model accounted for; local conversion/linkage inspected, with upstream geometry and derived-fixture limits separate. |

## Verdicts and completion

Use `—` for unattempted work. All eight checks are mandatory to account for; only evidence-backed absence or unsupported functionality permits `N/A`.

- `PASS`: the required observation was performed and no issue was found within its stated scope.
- `FAIL`: an evidenced extension-owned contract violation, not merely an observed discrepancy. Record Ownership: EXTENSION and the boundary evidence. Unknown internal cause is acceptable; unknown ownership is not. Do not erase it when a single retest passes.
- `REVIEW`: suspicious/ambiguous, unreadable in part, conflicting reference or unresolved ownership/judgment. Exclude it from confirmed extension-defect counts. Upstream engineering correctness is not routinely reviewed.
- `BLOCKED`: the check could not execute because of a documented prerequisite, qualification, environment, access or fixture limit.
- `N/A`: documented unsupported feature or demonstrably absent source asset. Unknown availability is not `N/A`.

Use `PARTIAL` while any check or one permitted retest still needs work. When no work remains within the procedure, final `Case status` follows: `FAIL` if any check failed; otherwise `REVIEW` if any is uncertain; otherwise `BLOCKED` if any is blocked; otherwise `PASS` (all checks PASS/N/A). `NOT RUN` is only for untouched rows.

A final `FAIL` can include blocked checks: that row is closed but not fully inspected. A final `REVIEW` is closed pending manual judgment, not an instruction to investigate indefinitely. A row labelled `FAIL` with blank checks is incomplete and must not be skipped when resuming this campaign.

Report three separate quantities: work disposition (closed/partial/unstarted), cases with confirmed extension-owned failures, and outstanding blocked/manual-review coverage. Never sum overlapping failure and review counts as though they were disjoint completion totals. A fully inspected case has no blank, BLOCKED or REVIEW check; it may still contain an observed FAIL.

## Finding text

Append independently to the relevant row, using `<br>` within the cell and relative Markdown links for evidence. Use the format:

`P001-EXT01 | Ownership: EXTENSION | Check: <area> | Expected/actual: <contract discrepancy> | Ownership basis: <direct boundary or matched source/output evidence> | Build/run(s): <IDs> | Reproduction: <scope and outcome> | Evidence: <links>`

The helper escapes literal pipe characters. Include exact error messages only after redaction. Avoid theories, proposed fixes, severity speculation and duplication of entire console logs. Multiple confirmed owned issues in a row receive EXT01, EXT02, etc. Non-reportable upstream/harness facts receive brief Context notes; unresolved ownership receives Ownership review notes, not extension issue IDs. Each affected row gets its own self-contained description even when the issue repeats elsewhere.

The starting findings cells are empty. Once execution begins, preserve this campaign's findings. On an authorised resume or rerun, append a dated correction/supplement instead of replacing an earlier observation. Keep both initial and retest evidence. The original unexpected behaviour remains recorded as intermittent when not reproduced once.

## Bookkeeping commands

Run from the repository root. Supply the actual matrix and a new campaign directory on first use:

```powershell
$Tool = '.agents/skills/easy-ecad-qa/scripts/matrix.py'
$QaRoot = (Resolve-Path '../qa-run').Path
$Matrix = Join-Path $QaRoot 'easy_ecad_url_test_matrix_extension_only.md'
$Stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$Campaign = Join-Path (Join-Path $QaRoot 'campaigns') ('extension-only-' + $Stamp)
python $Tool init --matrix $Matrix --campaign $Campaign
python $Tool inspect --matrix $Matrix --campaign $Campaign --id P001
```

`inspect` returns the full-file `matrix_sha256`, the fixed identity and current row. Read these immediately before editing. Save a UTF-8 patch JSON in the campaign directory. Example, with placeholders replaced by real observations:

```json
{
  "set": {
    "Symbol preview": "REVIEW",
    "Case status": "PARTIAL"
  },
  "append_finding": "P001 ownership review — Symbol preview: <specific discrepancy with unresolved ownership>. Not a confirmed extension defect. Evidence: [preview](<relative-path>)."
}
```

```powershell
python $Tool update --matrix $Matrix --campaign $Campaign --id P001 `
  --expected-sha '<matrix_sha256 from inspect>' --patch "$Campaign/P001-patch.json"
python $Tool inspect --matrix $Matrix --campaign $Campaign --id P001
```

Never place an unevaluated placeholder or example finding in the real table. If a stale-hash, lock or fixed-definition error occurs, stop writing, reread current files and reconcile. Do not force overwrite. Keep one matrix writer; the helper's lock does not lock editors outside this helper.

Checkpoint before a long command, after each significant observation, after each completed row and on pause/session end:

```powershell
python $Tool checkpoint --matrix $Matrix --campaign $Campaign `
  --state RUNNING --id P001 --step 'inspect footprint and all 3D models' `
  --run-id 'P001-a1-<timestamp>'
```

Use `PAUSED`, `BLOCKED` or `COMPLETE` when appropriate. Checkpoints contain no secrets and do not schedule work. Save active tool/process identifiers separately in a short campaign note when needed to reconnect; never include credentials.

## Resume and interruption

After this campaign begins, read its own `checkpoint.json`, `baseline.json`, matrix row and linked run evidence. No checkpoint or baseline is supplied in the fresh-start package. Do not look outside the selected campaign for a continuation point. Validate the baseline fingerprint; a user's changed selection requires deliberate reconciliation, not a new baseline that conceals the change.

If the row update was saved but the checkpoint is stale, the saved table and matching evidence take precedence. If a harness result is still RUNNING, establish whether its owned process is actually alive before retrying. Do not launch a concurrent duplicate. If evidence already exists, inspect it first. Do not count duplicated run IDs as additional components.

`PAUSED` requires a fresh user resume request. Do not create scheduled tasks or background auto-resume loops. After a hard interruption, disclose unsaved/unverifiable work and resume from the last evidenced step, not memory. Leave rows outside the requested scope untouched.

## Evidence retention

The harness generates images even for passes because those images are needed for visual inspection. Retain its outputs; do not modify it to suppress them. The matrix needs detailed screenshot links for FAIL/REVIEW and relevant blockers, not a gallery of every successful render. No routine datasheet collection is required. Record successful scoped view coverage briefly and link the run's evidence index. Keep downloads, inspection fixtures, datasheets and raw JSON local; do not upload or commit them without authorisation.

## Ownership summary

Apply [ownership.md](ownership.md) before every FAIL. Raw harness FAIL/REVIEW labels are not automatically table outcomes. Count confirmed extension-owned findings/cases separately from ownership reviews and coverage blockers. Keep upstream/harness notes short and out of the defect report. A documented code fix is not a passing test; only observations made in this campaign count. Existing helper summary names are mechanical counts; in this matrix their failure sets mean extension-owned failures only.
