/*
 * These tests replay the repository security hygiene rules against every
 * reachable Git commit, including historical content removed from the tip tree.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  artifactFindingsForPath,
  basicAuthorizationFindings,
  fixtureEmailLineFindings,
  highConfidenceSecretFindings,
  isTextFile
} from "./helpers/security_hygiene.js";
import { REPO_ROOT } from "./helpers/test_harness.js";

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_HISTORY_TEST_TIMEOUT_MS = 60000;
const EMAIL_GREP_PATTERN = "[A-Z0-9._%+-]+@([A-Z0-9-]+\\.)+[A-Z]{2,}";

// Git checks all nonbinary files for email addresses, including formats outside the
// extension's source list. Bounded argument lists also fit the Windows process limit.
function emailHistoryFindings(commits, git) {
  const findings = [];
  for (let start = 0; start < commits.length; start += 100) {
    let matches;
    try {
      matches = git("grep", "-n", "-I", "-i", "-E", EMAIL_GREP_PATTERN,
        ...commits.slice(start, start + 100));
    } catch (error) {
      if (error.status === 1) continue; // Git reports an empty match set with status 1.
      throw error;
    }
    for (const line of matches.split("\n")) {
      const match = line.match(/^([0-9a-f]+):(.+?):([0-9]+):(.*)$/);
      if (match) {
        const [, commit, relativePath, number, text] = match;
        for (const finding of fixtureEmailLineFindings(relativePath, text, Number(number))) {
          findings.push(commit.slice(0, 12) + ":" + finding);
        }
      }
    }
  }
  return findings;
}

function gitHistorySecurityFindings(cwd = REPO_ROOT) {
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER_BYTES
  });
  const commits = git("rev-list", "--all").trim().split("\n").filter(Boolean);
  const findings = emailHistoryFindings(commits, git);
  const scannedEntries = new Map();
  for (const commit of commits) {
    // A tree entry contains its file mode, object type, content hash, and pathname.
    // Reusing that entire key preserves path-specific rules across renames and
    // attributes an unchanged finding to every reachable revision containing it.
    for (const entry of git("ls-tree", "-r", "-z", commit).split("\0").filter(Boolean)) {
      if (!scannedEntries.has(entry)) {
        const tab = entry.indexOf("\t");
        const [, type, objectId] = entry.slice(0, tab).split(" ");
        const relativePath = entry.slice(tab + 1);
        const issues = artifactFindingsForPath(relativePath);
        if (type === "blob" && isTextFile(relativePath)) {
          const text = git("cat-file", "blob", objectId);
          issues.push(...highConfidenceSecretFindings(relativePath, text),
            ...basicAuthorizationFindings(relativePath, text));
        }
        scannedEntries.set(entry, issues);
      }
      for (const finding of scannedEntries.get(entry)) {
        findings.push(commit.slice(0, 12) + ":" + finding);
      }
    }
  }
  return findings;
}

describe("git history security hygiene", () => {
  it("keeps a finding at each historical path and revision after a rename and deletion", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ecad-history-"));
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const commit = message => git("-c", "user.name=QA", "-c", "user.email=qa@example.test",
      "-c", "commit.gpgsign=false", "commit", "-qm", message);
    try {
      git("init", "-q");
      // This inert marker exercises the scanner's private-key heading rule.
      fs.writeFileSync(path.join(cwd, "before.txt"), ["-----BEGIN TEST", "PRIVATE KEY-----"].join(" "));
      git("add", "before.txt");
      commit("Add marker");
      const before = git("rev-parse", "HEAD").slice(0, 12);
      git("mv", "before.txt", "after.txt");
      commit("Rename marker");
      const after = git("rev-parse", "HEAD").slice(0, 12);
      git("rm", "-q", "after.txt");
      commit("Remove marker");
      expect(gitHistorySecurityFindings(cwd).sort()).toEqual([
        before + ":before.txt (private key block)",
        after + ":after.txt (private key block)"
      ].sort());
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, GIT_HISTORY_TEST_TIMEOUT_MS);

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
