/*
 * These tests cover repository-level governance rules. They inspect tracked
 * docs, manifest shape, source footers, and reviewer explainers so convention
 * drift is caught mechanically rather than by memory.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, normalizeNewlines } from "./helpers/test_harness.js";
import {
  artifactFindingsForPath,
  basicAuthorizationFindings,
  fixtureEmailFindings,
  highConfidenceSecretFindings,
  isTextFile
} from "./helpers/security_hygiene.js";

const GOVERNANCE_FILES = [
  "README.md",
  "contributing.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "systemDesign.md",
  "docs/architecture-notes.md",
  "docs/deviations.md"
];

const SKIPPED_REPOSITORY_DIRS = new Set([".git", "coverage", "dist", "node_modules", ".qa-output", "__pycache__"]);

const CONVENTIONAL_ROOT_FILES = new Set([
  ".gitignore",
  ".nvmrc",
  "AGENTS.md",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "contributing.md",
  "eslint.config.js",
  "manifest.json",
  "package-lock.json",
  "package.json",
  "systemDesign.md",
  "vitest.config.js"
]);

const FILE_LENGTH_EXCEPTIONS = new Set(["LICENSE", "package-lock.json"]);

const BINARY_EXTENSIONS = new Set([".png"]);

const CAMEL_CASE_FUNCTION_NAME = /^[a-z][A-Za-z0-9]*$/;

const githubSlugForPlainHeading = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-");

const readmeHeadingText = (line) =>
  line
    .slice(3)
    .trim()
    .replace(/<img\s+[^>]*>\s*/g, "")
    .trim();

const CANONICAL_FOOTER = normalizeNewlines(
  [
    "/*",
    "######################################################################################################################",
    "",
    "",
    "                                        AAAAAAAA",
    "                                      AAAA    AAAAA              AAAAAAAA",
    "                                    AAA          AAA           AAAA    AAA",
    "                                    AA            AA          AAA       AAA",
    "                                    AA            AAAAAAAAAA  AAA       AAAAAAAAAA",
    "                                    AAA                  AAA  AAA               AA",
    "                                     AAA                AAA    AAAAA            AA",
    "                                      AAAAA            AAA        AAA           AA",
    "                                         AAA          AAA                       AA",
    "                                         AAA         AAA                        AA",
    "                                         AA         AAA                         AA",
    "                                         AA        AAA                          AA",
    "                                        AAA       AAAAAAAAA                     AA",
    "                                        AAA       AAAAAAAAA                     AA",
    "                                        AA                   AAAAAAAAAAAAAA     AA",
    "                                        AA  AAAAAAAAAAAAAAAAAAAAAAAA    AAAAAAA AA",
    "                                       AAAAAAAAAAA                           AA AA",
    "                                                                           AAA  AA",
    "                                                                         AAAA   AA",
    "                                                                      AAAA      AA",
    "                                                                   AAAAA        AA",
    "                                                               AAAAA            AA",
    "                                                            AAAAA               AA",
    "                                                        AAAAAA                  AA",
    "                                                    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "",
    "",
    "######################################################################################################################",
    "",
    "                                                Copyright (c) JoeShade",
    "                              Licensed under the GNU Affero General Public License v3.0",
    "",
    "######################################################################################################################",
    "",
    "                                        +44 (0) 7356 042702 | joe@jshade.co.uk",
    "",
    "######################################################################################################################",
    "*/"
  ].join("\n")
);

function applicableSourceFiles() {
  const files = [];

  for (const root of ["src", "tests"]) {
    const basePath = path.join(REPO_ROOT, root);
    if (!fs.existsSync(basePath)) {
      continue;
    }
    for (const entry of fs.readdirSync(basePath, { recursive: true })) {
      const fullPath = path.join(basePath, entry);
      if (fs.statSync(fullPath).isFile() && fullPath.endsWith(".js") &&
          !isLocalQaArtifact(repoRelativePath(fullPath))) {
        files.push(fullPath);
      }
    }
  }

  const supportFiles = [
    path.join(REPO_ROOT, ".puppeteerrc.cjs"),
    path.join(REPO_ROOT, "eslint.config.js"),
    path.join(REPO_ROOT, "vitest.config.js")
  ];
  for (const fullPath of supportFiles) {
    if (fs.existsSync(fullPath)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

// Local campaign inputs and evidence are developer data. Scan maintained files
// separately, and check Git's tracked paths below so forced additions still fail.
function isLocalQaArtifact(relativePath) {
  const filename = path.posix.basename(relativePath);
  return relativePath.split("/").includes("qa-run") ||
    /^test[-_]matrix.*\.md$/i.test(filename) ||
    /^easy_ecad_url_test_matrix.*\.md$/.test(filename);
}

function repositoryFiles() {
  const files = [];

  function walk(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const fullPath = path.join(directoryPath, entry.name);
      if (isLocalQaArtifact(repoRelativePath(fullPath))) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_REPOSITORY_DIRS.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(REPO_ROOT);
  return files.sort();
}

function repoRelativePath(fullPath) {
  return path.relative(REPO_ROOT, fullPath).replaceAll(path.sep, "/");
}

function isLowerSnakeFileName(filename) {
  return /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.test)?\.js$/.test(filename);
}

function isLowerKebabFileName(filename, extensionPattern) {
  return new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*\\.${extensionPattern}$`).test(
    filename
  );
}

function expectedFileNameStyle(relativePath) {
  const filename = path.basename(relativePath);
  const directoryName = path.dirname(relativePath).replaceAll(path.sep, "/");
  const extension = path.extname(filename).toLowerCase();

  if (CONVENTIONAL_ROOT_FILES.has(relativePath)) {
    return null;
  }
  if (relativePath === ".github/workflows/ci.yml") {
    return null;
  }
  if (directoryName === "icons" && /^\d+x\d+\.png$/.test(filename)) {
    return null;
  }
  if (directoryName === "docs" && extension === ".md") {
    return { label: "docs Markdown should use lower kebab-case", isValid: isLowerKebabFileName(filename, "md") };
  }
  if ((directoryName.startsWith("src") || directoryName.startsWith("tests")) && extension === ".js") {
    return { label: "JavaScript should use lower snake_case", isValid: isLowerSnakeFileName(filename) };
  }
  if (directoryName.startsWith("src") && [".css", ".html"].includes(extension)) {
    return {
      label: "source assets should use lower kebab-case or lower snake_case",
      isValid: /^[a-z0-9]+(?:[_-][a-z0-9]+)*\.(?:css|html)$/.test(filename)
    };
  }
  if (directoryName === "src/assets" && extension === ".png") {
    return { label: "source image assets should use lower kebab-case", isValid: isLowerKebabFileName(filename, "png") };
  }

  return null;
}

function lineLimitFor(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();

  if (FILE_LENGTH_EXCEPTIONS.has(relativePath) || BINARY_EXTENSIONS.has(extension)) {
    return null;
  }
  if (relativePath.startsWith("src/") && extension === ".js") {
    return 700;
  }
  if (relativePath.startsWith("tests/") && extension === ".js") {
    return 750;
  }
  if (extension === ".md") {
    return 450;
  }
  if ([".css", ".html", ".json", ".yml"].includes(extension)) {
    return 450;
  }

  return null;
}

function functionDeclarationNames(text) {
  return [...text.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((match) => match[1]);
}

// Interpreter/runner declarations precede documentation; each maintained
// language then uses its native opening comment or module docstring syntax.
function hasTopLevelExplainer(text, relativePath = "file.js") {
  const normalized = normalizeNewlines(text)
    .trimStart()
    .replace(/^\/\/ .+work in this file: .+\n/, "")
    .replace(/^\/\/ @vitest-environment [^\n]+\n/, "");
  if (relativePath.endsWith(".py")) return /^"""[\s\S]+?"""/.test(normalized);
  if (/\.(ps1|ya?ml)$/.test(relativePath)) return /^# \S[^\n]+/.test(normalized);
  if (relativePath.endsWith(".html")) return /^(?:<!doctype html>\n)?<!--[\s\S]+?-->/i.test(normalized);
  return /^\/\*\n \* [\s\S]*?\n \*\//.test(normalized);
}

function isMaintainedCodeFile(relativePath) {
  if (relativePath.startsWith("tests/fixtures/")) return false;
  return /^(src|tests|scripts)\/.*\.(?:[cm]?js|py|ps1|html|css)$/.test(relativePath) ||
    /^\.agents\/skills\/[^/]+\/scripts\/.*\.(?:[cm]?js|py|ps1)$/.test(relativePath) ||
    /^\.github\/workflows\/.*\.ya?ml$/.test(relativePath) ||
    [".puppeteerrc.cjs", "eslint.config.js", "vitest.config.js"].includes(relativePath);
}

describe("repository hygiene", () => {
  it("keeps local QA matrices and campaign evidence untracked while retaining the harness", () => {
    const trackedPaths = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT, encoding: "utf8"
    }).split("\0").filter(Boolean);
    expect(trackedPaths.filter(isLocalQaArtifact)).toEqual([]);
    const toolingPaths = [
      "tests/headless-qa/run.js",
      ".agents/skills/easy-ecad-qa/scripts/matrix.py",
      ".agents/skills/easy-ecad-qa/scripts/test_matrix.py"
    ];
    expect(trackedPaths).toEqual(expect.arrayContaining(toolingPaths));
    const localPaths = [
      "TEST-MATRIX.MD", "TEST-MATRIX-50-EASYEDA-20261022.MD", "test_matrix.md",
      "easy_ecad_url_test_matrix_extension_only.md", "qa-run/campaigns/example/result.json"
    ];
    const ignoredPaths = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: REPO_ROOT, encoding: "utf8", input: [...localPaths, ...toolingPaths].join("\n") + "\n"
    }).trim().split(/\r?\n/);
    expect(ignoredPaths).toEqual(localPaths);
  });

  it.each([".github/workflows/release.yml", ".agents/skills/example/scripts/check.py", "tests/helper.mjs"])(
    "includes maintained support code in explainer coverage: %s", relativePath => {
      expect(isMaintainedCodeFile(relativePath)).toBe(true);
    }
  );
  it.each(["helper.py", "helper.ps1", "config.cjs", "config.mjs", "config.toml"])(
    "includes maintained tooling in secret scans: %s", relativePath => {
      expect(isTextFile(relativePath)).toBe(true);
    }
  );
  it("requires the governance files", () => {
    for (const relativePath of GOVERNANCE_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, relativePath))).toBe(true);
    }
  });

  it("keeps the manifest aligned for Chrome service workers and Firefox background documents", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8")
    );

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({
      service_worker: "src/service_worker.js",
      scripts: ["src/service_worker.js"],
      preferred_environment: ["document", "service_worker"],
      type: "module"
    });
    expect(manifest.options_ui).toEqual({
      page: "src/settings.html",
      open_in_tab: true
    });
    expect(manifest.browser_specific_settings?.gecko?.strict_min_version).toBe(
      "121.0"
    );
  });

  it("keeps README sections in the documented review order", () => {
    const readmeText = normalizeNewlines(
      fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")
    );
    const headingLines = readmeText
      .split("\n")
      .filter((line) => line.startsWith("## "));
    const expectedOrder = [
      "Contents",
      "Installation",
      "Quick start",
      "Usage walkthrough",
      "Supported sources and outputs",
      "Contributing",
      "Supporting docs"
    ];

    let previousIndex = -1;
    for (const heading of expectedOrder) {
      const currentIndex = headingLines.findIndex((line) =>
        line.includes(heading)
      );
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
  });

  it("keeps README contents links aligned with GitHub heading anchors", () => {
    const readmeText = normalizeNewlines(
      fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")
    );
    const contentsMatch = readmeText.match(
      /^## (?:<img\s+[^>]*>\s*)?Contents\n\n((?:- \[[^\]]+\]\(#[^)]+\)\n)+)/m
    );

    expect(contentsMatch).not.toBeNull();

    const contentsBlock = contentsMatch[1];
    const linkedFragments = Array.from(
      contentsBlock.matchAll(/^- \[[^\]]+\]\(#([^)]+)\)$/gm),
      ([, fragment]) => fragment
    );
    const headingFragments = new Set(
      readmeText
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map(readmeHeadingText)
        .map(githubSlugForPlainHeading)
    );

    expect(linkedFragments).toEqual([...new Set(linkedFragments)]);
    for (const fragment of linkedFragments) {
      expect(headingFragments).toContain(fragment);
    }
  });

  it("keeps the local and CI validation gates wired together", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );
    const workflowText = normalizeNewlines(
      fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")
    );

    expect(fs.existsSync(path.join(REPO_ROOT, "package-lock.json"))).toBe(true);
    expect(packageJson.scripts.lint).toBe("eslint .");
    expect(packageJson.scripts.audit).toBe("npm audit --audit-level=moderate");
    expect(packageJson.scripts.validate).toContain("npm run lint");
    expect(packageJson.scripts.validate).toContain("npm test");
    expect(packageJson.scripts.validate).toContain("npm run audit");
    expect(packageJson.scripts.validate).toContain("git diff --check");
    expect(workflowText).toContain("npm ci");
    expect(workflowText).toContain("npm run validate");
  });

  it("keeps secrets, generated archives, and disposable files out of the repository tree", () => {
    const forbiddenFiles = [];

    for (const fullPath of repositoryFiles()) {
      const relativePath = repoRelativePath(fullPath);
      forbiddenFiles.push(...artifactFindingsForPath(relativePath));
    }

    expect(forbiddenFiles).toEqual([]);
  });

  it("does not contain high-confidence secret material in text files", () => {
    const findings = [];

    for (const fullPath of repositoryFiles()) {
      const relativePath = repoRelativePath(fullPath);
      if (!isTextFile(relativePath)) {
        continue;
      }

      const text = fs.readFileSync(fullPath, "utf8");
      findings.push(...highConfidenceSecretFindings(relativePath, text));
    }

    expect(findings).toEqual([]);
  });

  it("keeps fixture email addresses on placeholder domains", () => {
    const findings = [];

    for (const fullPath of repositoryFiles()) {
      const relativePath = repoRelativePath(fullPath);
      if (!isTextFile(relativePath)) {
        continue;
      }

      const text = fs.readFileSync(fullPath, "utf8");
      findings.push(...fixtureEmailFindings(relativePath, text));
    }

    expect(findings).toEqual([]);
  });

  it("keeps encoded HTTP Basic auth fixtures on placeholder identities", () => {
    const findings = [];

    for (const fullPath of repositoryFiles()) {
      const relativePath = repoRelativePath(fullPath);
      if (!isTextFile(relativePath)) {
        continue;
      }

      const text = normalizeNewlines(fs.readFileSync(fullPath, "utf8"));
      findings.push(...basicAuthorizationFindings(relativePath, text));
    }

    expect(findings).toEqual([]);
  });

  it("keeps file names in the repository's conventional styles", () => {
    const violations = [];

    for (const fullPath of repositoryFiles()) {
      const relativePath = repoRelativePath(fullPath);
      const expectation = expectedFileNameStyle(relativePath);
      if (expectation && !expectation.isValid) {
        violations.push(`${relativePath} (${expectation.label})`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps function declaration names in lower camelCase", () => {
    const violations = [];

    for (const fullPath of applicableSourceFiles()) {
      const relativePath = repoRelativePath(fullPath);
      const text = fs.readFileSync(fullPath, "utf8");
      for (const name of functionDeclarationNames(text)) {
        if (!CAMEL_CASE_FUNCTION_NAME.test(name)) {
          violations.push(`${relativePath}: ${name}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps maintained text files below the repository line-count limits", () => {
    const oversizedFiles = [];

    for (const fullPath of repositoryFiles()) {
      const relativePath = repoRelativePath(fullPath);
      const limit = lineLimitFor(relativePath);
      if (!limit) {
        continue;
      }
      const lineCount = normalizeNewlines(fs.readFileSync(fullPath, "utf8")).split("\n").length;
      if (lineCount > limit) {
        oversizedFiles.push(`${relativePath} (${lineCount}/${limit} lines)`);
      }
    }

    expect(oversizedFiles).toEqual([]);
  });

  it("keeps the canonical footer on applicable maintained JS files exactly once", () => {
    const missingOrDuplicated = [];

    for (const fullPath of applicableSourceFiles()) {
      const text = normalizeNewlines(fs.readFileSync(fullPath, "utf8"));
      const occurrences = text.split(CANONICAL_FOOTER).length - 1;
      if (occurrences !== 1) {
        missingOrDuplicated.push(path.relative(REPO_ROOT, fullPath));
      }
    }

    expect(missingOrDuplicated).toEqual([]);
  });

  it("keeps a top-level explainer on maintained source, tests and executable tooling", () => {
    const missingExplainers = [];

    for (const fullPath of repositoryFiles().filter(file => isMaintainedCodeFile(repoRelativePath(file)))) {
      const text = fs.readFileSync(fullPath, "utf8");
      if (!hasTopLevelExplainer(text, repoRelativePath(fullPath))) {
        missingExplainers.push(path.relative(REPO_ROOT, fullPath));
      }
    }

    expect(missingExplainers).toEqual([]);
  });

  it("keeps deviations focused on live mismatches rather than backlog or history", () => {
    const deviationsText = normalizeNewlines(
      fs.readFileSync(path.join(REPO_ROOT, "docs/deviations.md"), "utf8")
    );

    expect(deviationsText).toMatch(/^# Current Deviations/);
    expect(deviationsText).not.toMatch(/^#{1,6}\s+.*(?:backlog|history|resolved)/im);
    const entries = deviationsText.split(/^## /m).slice(1);
    if (!entries.length) {
      expect(deviationsText.trim().split("\n").at(-1)).toBe("No current deviations.");
    } else {
      expect(deviationsText).not.toContain("No current deviations.");
      // Each entry ties current behavior to its design requirement and an
      // observable closure condition, keeping this file useful during repair.
      for (const entry of entries) {
        for (const field of ["Expected:", "Observed:", "Closure:"]) {
          expect(entry).toContain(field);
        }
      }
    }
  });

  it("does not keep stale footer migration language in governance docs", () => {
    const governanceText = GOVERNANCE_FILES.map((relativePath) =>
      normalizeNewlines(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"))
    ).join("\n");

    expect(governanceText).not.toContain("removed `source-code-footer.txt`");
    expect(governanceText).not.toContain("copy an existing source file");
    expect(governanceText.toLowerCase()).not.toContain("footer migration");
  });
});

/*
######################################################################################################################


                                        AAAAAAAA
                                      AAAA    AAAAA              AAAAAAAA
                                    AAA          AAA           AAAA    AAA
                                    AA            AA          AAA       AAA
                                    AA            AAAAAAAAAA  AAA       AAAAAAAAAA
                                    AAA                  AAA  AAA               AA
                                     AAA                AAA    AAAAA            AA
                                      AAAAA            AAA        AAA           AA
                                         AAA          AAA                       AA
                                         AAA         AAA                        AA
                                         AA         AAA                         AA
                                         AA        AAA                          AA
                                        AAA       AAAAAAAAA                     AA
                                        AAA       AAAAAAAAA                     AA
                                        AA                   AAAAAAAAAAAAAA     AA
                                        AA  AAAAAAAAAAAAAAAAAAAAAAAA    AAAAAAA AA
                                       AAAAAAAAAAA                           AA AA
                                                                           AAA  AA
                                                                         AAAA   AA
                                                                      AAAA      AA
                                                                   AAAAA        AA
                                                               AAAAA            AA
                                                            AAAAA               AA
                                                        AAAAAA                  AA
                                                    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA


######################################################################################################################

                                                Copyright (c) JoeShade
                              Licensed under the GNU Affero General Public License v3.0

######################################################################################################################

                                        +44 (0) 7356 042702 | joe@jshade.co.uk

######################################################################################################################
*/
