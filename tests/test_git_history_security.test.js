/*
 * These tests replay the repository security hygiene rules against every
 * reachable Git commit, including historical content removed from the tip tree.
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  artifactFindingsForPath,
  basicAuthorizationFindings,
  fixtureEmailLineFindings,
  highConfidenceSecretFindings,
  isTextFile,
  securityGrepTerms
} from "./helpers/security_hygiene.js";
import { REPO_ROOT } from "./helpers/test_harness.js";

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_HISTORY_TEST_TIMEOUT_MS = 60000;
const EMAIL_GREP_PATTERN = "[A-Z0-9._%+-]+@([A-Z0-9-]+\\.)+[A-Z]{2,}";

function gitText(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES
  });
}

function gitBuffer(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    maxBuffer: GIT_MAX_BUFFER_BYTES
  });
}

function reachableCommits() {
  return gitText(["rev-list", "--all"])
    .trim()
    .split("\n")
    .filter(Boolean);
}

function treePathsForCommit(commit) {
  return gitBuffer(["ls-tree", "-r", "--name-only", "-z", commit])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function gitGrepText(args) {
  try {
    return gitText(["grep", ...args]);
  } catch (error) {
    if (error.status === 1) {
      return "";
    }
    throw error;
  }
}

function fileTextAtCommit(commit, relativePath) {
  return gitBuffer(["show", `${commit}:${relativePath}`]).toString("utf8");
}

function artifactHistoryFindings(commits) {
  const findings = [];

  for (const commit of commits) {
    const commitPrefix = commit.slice(0, 12);
    for (const relativePath of treePathsForCommit(commit)) {
      for (const finding of artifactFindingsForPath(relativePath)) {
        findings.push(`${commitPrefix}:${finding}`);
      }
    }
  }

  return findings;
}

function parseGrepLine(line) {
  const match = line.match(/^([0-9a-f]{40}):(.+?):([0-9]+):(.*)$/);
  if (!match) {
    return null;
  }

  return {
    commit: match[1],
    relativePath: match[2],
    lineNumber: Number(match[3]),
    text: match[4]
  };
}

function parseGrepPath(line) {
  const match = line.match(/^([0-9a-f]{40}):(.+)$/);
  if (!match) {
    return null;
  }

  return { commit: match[1], relativePath: match[2] };
}

function emailHistoryFindings(commits) {
  const findings = [];
  const grepText = gitGrepText([
    "-n",
    "-I",
    "-i",
    "-E",
    EMAIL_GREP_PATTERN,
    ...commits
  ]);

  for (const line of grepText.split("\n").filter(Boolean)) {
    const match = parseGrepLine(line);
    if (!match) {
      continue;
    }
    for (const finding of fixtureEmailLineFindings(
      match.relativePath,
      match.text,
      match.lineNumber
    )) {
      findings.push(`${match.commit.slice(0, 12)}:${finding}`);
    }
  }

  return findings;
}

function securityCandidatePaths(commits) {
  const grepArgs = ["-I", "-l"];
  for (const term of securityGrepTerms()) {
    grepArgs.push("-e", term);
  }
  grepArgs.push(...commits);

  return gitGrepText(grepArgs)
    .split("\n")
    .filter(Boolean)
    .map(parseGrepPath)
    .filter(Boolean)
    .filter(({ relativePath }) => isTextFile(relativePath));
}

function triggeredTextHistoryFindings(commits) {
  const findings = [];

  for (const { commit, relativePath } of securityCandidatePaths(commits)) {
    const text = fileTextAtCommit(commit, relativePath);
    for (const finding of highConfidenceSecretFindings(relativePath, text)) {
      findings.push(`${commit.slice(0, 12)}:${finding}`);
    }
    for (const finding of basicAuthorizationFindings(relativePath, text)) {
      findings.push(`${commit.slice(0, 12)}:${finding}`);
    }
  }

  return findings;
}

function gitHistorySecurityFindings() {
  const commits = reachableCommits();

  return [
    ...artifactHistoryFindings(commits),
    ...emailHistoryFindings(commits),
    ...triggeredTextHistoryFindings(commits)
  ];
}

describe("git history security hygiene", () => {
  it("allows canonical footer contact lines stored in historical JS constants", () => {
    const footerContactLine =
      '    "                                        +44 (0) 7356 042702 | ' +
      'joe@' +
      'jshade.co.uk",';

    expect(
      fixtureEmailLineFindings(
        "tests/test_repo_hygiene.test.js",
        footerContactLine,
        55
      )
    ).toEqual([]);
  });

  it("keeps security checks clean across all reachable commits", () => {
    expect(gitHistorySecurityFindings()).toEqual([]);
  }, GIT_HISTORY_TEST_TIMEOUT_MS);
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
