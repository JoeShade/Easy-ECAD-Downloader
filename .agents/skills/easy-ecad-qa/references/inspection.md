# Visual inspection of extension-owned behaviour

Read [ownership.md](ownership.md) first. Every applicable visual observation uses the actual evidence from the identified run. A filename, JSON flag, parse success or image dimension is not a visual inspection.

## Evidence gate

Open the saved previews and KiCad PNGs with a local image tool. Confirm component, build, file/entry/unit/format and view identity. Keep originals. Crops and magnification may aid readability but cannot restore clipped or missing detail. A harness fixture or unreadable capture is a coverage limitation, not evidence of a component/extension defect by itself.

An ordinary visual check can PASS if it was performed and no scoped problem is observed. This means visual/integration acceptability only, not full source fidelity or manufacturing suitability. A missing source baseline alone need not turn every otherwise sound render into REVIEW; a specific attribution-dependent discrepancy does.

## Page, detection and popup

Compare the qualified catalogue ID and exact MPN with both the returned context and actual popup. Preserve meaningful suffixes, punctuation and leading zeros. Follow documented conflict handling rather than demanding an arbitrary ID. Compare manufacturer names only when the interface/context actually supplies them. The absence of an unimplemented manufacturer-name display is not a defect. `Mfr. Part #` means MPN; JLCPCB's documented source label is `LCSC part`.

Inspect both previews for correct association, local clipping, display distortion, omitted local graphics and unreadable rendering. EasyEDA creates previews locally; use identity/version-matched source or local converted-output evidence for a demonstrated inconsistency. SamacSys supplies PNG previews: wrong drawing content in that PNG is not a local display defect, and disagreement with a separately authored upstream KiCad symbol is not sufficient attribution.

No tests of generic popup positioning, repeated open/close mechanics, unrelated settings or toolbar behaviour are added.

## Symbols and footprints

View every available exported symbol entry/unit and the relevant footprint layer images, including back layers when present. Check local malformedness, omitted/changed source features, corruption, readable output and required library association. Where directly available source evidence shows a supported pin, pad, primitive or attribute, compare its transfer allowing documented normalisation. Do not demand pixel-identical appearance across valid formats.

Do not routinely compare the symbol pinout, electrical types, reference styling, pad pitch/size, courtyards, polarity convention, fabrication graphics or solder lands to manufacturer drawings. Do not require missing source features to be invented by the extension. Preserve a specific suspicious content discrepancy as ownership REVIEW when its origin is not established. Do not assert that it is upstream merely because the baseline is missing.

EasyEDA local output format validity is in scope, but a KiCad render command failing on a generated inspection board does not independently prove that the exported footprint is invalid. Establish the relevant file boundary from available evidence or keep the limitation explicit. Source-authored SamacSys file errors are not automatically extraction/conversion errors.

## 3D models

Account for every supplied STEP/STP/WRL and view its provided top/isometric/side images when usable. Verify that model geometry is actually visible. Preserve which format/view was inspected. Check delivered filenames against generated paths within the documented layout. Do not move files, rewrite paths, repair geometry or adjust transforms to force a pass.

An original assembly can support a reference/alignment observation. A derived identity-transform fixture supports importer/appearance observation only; it cannot establish original association or alignment. A clipped derived fixture is not proof of bad source scale. A successfully displayed STEP does not validate a different WRL file or vice versa.

EasyEDA's OBJ-to-WRL transformation is locally owned; imported STEP model design is not. SamacSys model design and source transforms are upstream, while local extraction and path rewriting remain in scope. Attribute changed geometry/placement only from directly available matched source evidence and documented transformations, or a self-contained local contract failure. Model-to-datasheet differences alone are outside acceptance scope.

## Datasheets and absent evidence

Routine datasheet research and dimensional certification are removed. Use a reference only when directly needed to resolve exact product identity or another specified local contract. Do not launch manufacturer searches to audit pad design, pinout correctness or 3D geometry.

Inspect data already available at the input/output boundary when attribution requires it. Do not inspect implementation code, probe alternate services or fabricate missing provider payloads. The existing harness is not assumed to save original EasyEDA/OBJ/SamacSys inputs. If it did not, record the narrow ownership limitation and continue; acquiring new instrumentation is a separate engineering task.

## Absence and errors

A clear source-unavailable or unsupported category is N/A with a reason. Access/refusal/environment limitations are BLOCKED on dependent checks. Generic failures may remain ownership REVIEW. The external event is not a defect finding; independently evidenced incorrect local handling may be. In particular, a raw HTTP 404 is not an automatic exclusion if the locally selected catalogue ID is demonstrably wrong.

Do not count false empty-preview/download symptoms separately from an already evidenced identity mismatch unless their own local contract violations are independently established. Preserve all observations as needed without inventing independent causes.
