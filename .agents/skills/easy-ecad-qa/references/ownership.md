# Extension-only QA scope

## Objective

Find defects in **what Easy ECAD Downloader does with the product information and CAD assets it receives**, not defects in the upstream CAD library or the component's engineering design.

A reportable `FAIL` needs evidence of an extension-owned contract violation. Ownership is not the same as root cause: showing that a correct page ID becomes a different popup ID establishes the boundary failure without tracing implementation code.

Use the supplied fixed 300-case parts list and preserve its identities, website/provider distribution and row order. Use the current local headless harness and inspect the actual Chrome previews and KiCad CLI images. Computer Use and interactive KiCad are not part of this procedure.

## What to test

| Area | In scope: extension-owned behaviour | Not an extension defect by itself |
| --- | --- | --- |
| Product identity | Extract the qualified product's supported catalogue ID and exact MPN; display matching values and the documented source label; reject conflicting identities rather than export an arbitrary part. | A missing/ambiguous product listing, unavailable source metadata, or absent manufacturer-name display that the UI does not implement. |
| EasyEDA previews | Correctly generate and display the supported source graphics; no extension-introduced omissions, clipping, deformation or wrong-asset selection. | A flaw already present in upstream graphics; differences between legitimate drawing styles; an upstream preview/data refusal. |
| SamacSys previews | Load, associate and display the provided preview image correctly. | Provider-authored PNG content that is itself wrong, incomplete or inconsistent with the provider's ZIP. |
| Downloads and packaging | Honour the selected supported categories, preserve delivered files/entries, maintain grouped paths and symbol/footprint associations, and report the actual workflow state according to the documented contract. | Provider refusal, authentication requirements, network loss, absent upstream assets or an unsupported export category. |
| EasyEDA conversion | Valid local KiCad output and faithful transfer of supported source graphics, pins, pads and transforms, allowing documented normalisation. OBJ-to-WRL conversion and model-reference reconciliation are extension responsibilities. | Manufacturer-datasheet versus output disagreement without evidence that the extension introduced it. Imported STEP geometry is not locally authored by the extension. |
| SamacSys CAD | Preserve the provider's KiCad assets while correctly extracting, merging, naming and rewriting the supported library references. | Incorrect upstream pinouts, pad dimensions, text layout, component attributes, model geometry or placement retained from the provider. |
| 3D delivery and linkage | Refer to delivered model filenames in the documented layout; preserve required transforms; avoid dangling references after a failed optional model export; inspect generated WRL conversion when matched source evidence exists. | Missing or malformed upstream models, a derived fixture's identity placement, an inspection board error, clipping or an unsupported custom-pad fixture. |
| Failure handling | During the prescribed workflow, show documented warnings/errors, avoid misleading success claims, and preserve independent available exports when the contract requires it. | The external failure being handled. No deliberately induced outage, authentication or security-test campaign is added. |

The popup's documented **Download started** message is not a promise of completed disk writes. Verify actual files, but do not invent a completion guarantee. A source CAD button or enabled checkbox alone does not prove that an upstream file was obtainable.

A supported public page layout changing does not automatically make a detector failure an upstream problem: observable page-versus-detected mismatches remain in scope. Conversely, intentionally withholding a conflicting/unsupported identity is not a detection defect when that is the documented behaviour.

## Ownership evidence: two acceptable routes

**Direct boundary evidence:** Compare the independent product field with the detected/popup value; compare a generated reference with the actual delivered filename/inventory; or show another documented local output-contract contradiction. No upstream payload is necessary when the contradiction is established entirely at this boundary.

**Matched source/output evidence:** For a content or conversion discrepancy, use a source payload, source image, original provider ZIP, or OBJ already captured or directly available for the same qualified component/version and output. Identify the specific source feature and resulting changed or omitted output. Allow documented format, coordinate and display normalisation. Never use another part, package, mutable later provider version, or a guessed association as the reference.

A same-input inconsistency between the locally generated EasyEDA preview and converted KiCad output is a useful local-boundary observation when identity/version are established. It does not, without more evidence, identify which representation is correct. SamacSys independently supplied preview and CAD differences are not the same proof.

Use one bounded comparison of the directly relevant evidence. Do not reverse-engineer the converter, probe alternative provider endpoints, build capture tooling, debug the harness, or audit the upstream library. If an attribution-dependent discrepancy cannot be resolved from the permitted evidence, record `REVIEW — ownership unestablished` and move on. Do not invent input snapshots or require them for unrelated identity/linkage checks. No evidence of an extension defect is not proof that upstream caused it.

## What to stop doing

Do not routinely research manufacturer datasheets or measure every package dimension, pitch, pinout, electrical type, solder land, courtyard, polarity convention or manufacturing clearance. Those are upstream/engineering-quality checks, not this campaign's acceptance standard. A datasheet may resolve an exact ordering identity, but a datasheet discrepancy alone never attributes a CAD defect to the extension.

Do not open findings for source authentication, CAPTCHA, HTTP 401/403/404/429, unavailable CAD, upstream wrong datasheet content, missing source models, website navigation failures, or harness/KiCad fixture problems **without separate evidence of extension-owned behaviour**. These are coverage/context notes, not upstream bug reports. Do not repeatedly reproduce them.

Do not blanket-exclude every HTTP error either: a wrong locally detected ID followed by a 404 still has an in-scope ID defect. Report the ID mismatch with the failed lookup as a symptom; do not count a separate provider or converter defect without independent evidence. Likewise, a demonstrably broken extension error-handling contract can be a separate finding during an upstream refusal.

## Results and counting

Keep the existing 19-column table and helper. All eight check columns remain accounted for, with the narrowed meanings above.

- `PASS`: the applicable extension check was actually performed with no observed owned defect. State the scope; this is not upstream-quality or manufacturing approval.
- `FAIL`: evidence establishes an extension-owned defect. Each finding states `Ownership: EXTENSION`, the violated contract, and the evidence basis. An internal cause need not be known.
- `REVIEW`: the observation or its ownership remains uncertain, or required visual evidence is insufficient. It is not counted as an extension defect.
- `BLOCKED`: access, source availability uncertainty, environment or fixture prevents the applicable check. Record one short reason and retain independent results.
- `N/A`: a documented unsupported category or explicitly absent source asset; explain the limited scope. An opaque failure is not proof of absence.
- `—` / `NOT RUN`: no current-scope observation. Keep the case `PARTIAL` while an applicable check or the one permitted retest remains; once closed, use FAIL, otherwise REVIEW, otherwise BLOCKED, otherwise PASS.

If an image is sound and there is no observed transfer discrepancy, a scoped visual/readability check can pass without a manufacturer datasheet or source snapshot. Do not mark every such case REVIEW merely because upstream electrical correctness is unassessed. If actual output is suspicious and ownership matters to the verdict, keep that uncertainty explicit.

Use `Pxxx-EXT01`, etc. for confirmed findings; use short `Context:` or `Ownership review:` notes for everything else. Keep each affected case's owned finding independent. Several downstream symptoms of one demonstrated ID mismatch should not multiply the confirmed finding count.

Summary counts must distinguish confirmed extension-defect cases/findings, ownership-review cases, coverage blockers, and unfinished work. A raw harness FAIL/REVIEW, nonzero exit, or diagnostic from website analytics is not automatically a matrix defect. Do not rewrite raw harness evidence to fit the scoped summary.

## Fresh campaign and version boundaries

The supplied table is a clean campaign input. All 300 rows start NOT RUN; findings, resolved URLs and check results are unset. Start with a new campaign directory, baseline and checkpoint. Do not import outcomes, screenshots, known-issue classifications or completion counts from another campaign. Starting product/search URLs are selection inputs only and require current qualification.

Record the actual local repository commit, dirty-tree state and environment at execution. Use only that build's new evidence for this campaign. A documented fix does not substitute for testing. If the checkout changes during execution, stop and report the build boundary rather than silently mixing observations.

After execution starts, retain this campaign's raw evidence and append corrections to its findings. Resume only from this campaign's own baseline/checkpoint on explicit instruction. Do not reinterpret unrelated results as fresh observations.

## Local references

Read the current checkout's `README.md`, `systemDesign.md` (ownership, exports and error handling), and `tests/headless-qa/README.md` (commands and evidence schema). The procedure in this document defines acceptance scope; installed documentation defines the supported runtime interfaces. Do not modify those files during QA.
