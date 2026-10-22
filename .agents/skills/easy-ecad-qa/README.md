# Easy ECAD QA skill

Repository-local, explicitly invoked instructions for executing the extension-only parts list through the existing headless QA harness. No server or extra browser controller is installed. The helper is bookkeeping only; it does not infer test verdicts.

## Folder layout

```text
<workspace>/
  Easy-ECAD-Downloader/
    .agents/skills/easy-ecad-qa/
      SKILL.md
      agents/openai.yaml
      references/
      scripts/matrix.py
      scripts/test_matrix.py
  qa-run/
    CODEX_QA_EXTENSION_ONLY_PROMPT.md
    QA_EXTENSION_ONLY_SCOPE.md
    easy_ecad_url_test_matrix_extension_only.md
```

Replace only `.agents/skills/easy-ecad-qa/` in an existing checkout. Do not replace other skills or repository files. This package changes no production source, manifest, harness or dependencies. Reload Codex if needed to see the updated instructions.

## Start

Open Codex in the repository and explicitly request:

```text
$easy-ecad-qa
Read and execute ../qa-run/CODEX_QA_EXTENSION_ONLY_PROMPT.md.
Start a fresh campaign using ../qa-run/easy_ecad_url_test_matrix_extension_only.md
from P001 in row order. Use the existing local headless harness.
Record only evidenced extension-owned defects. Do not import other results,
change code, diagnose causes or create GitHub issues.
```

Installation alone does not execute this request. All new evidence and bookkeeping belong under the sibling `qa-run/campaigns/<unique-id>/`. Baselines and checkpoints are created at execution, not packaged. Resume only this campaign after it has begun and on an explicit user instruction.

## Included helper

`scripts/matrix.py` guards the existing 19-column table using a fixed-definition baseline, a file hash, append-only findings and atomic updates. Read `references/records.md` for commands. Its revision backups preserve observations generated in this new campaign; they are not imported results.

Run its offline unit tests independently of live component QA:

```powershell
python -m unittest discover -s .agents/skills/easy-ecad-qa/scripts -p test_matrix.py
```

The helper establishes bookkeeping correctness only. It does not certify browser operation, KiCad rendering, upstream CAD quality or component correctness.
