/*
 * Shared security-hygiene scanners for current-tree and Git-history tests.
 * They keep secret-shape rules aligned while allowing documented source-footer
 * contact details and placeholder credential identities.
 */

import path from "node:path";

import { normalizeNewlines } from "./test_harness.js";

const FORBIDDEN_ARTIFACT_PATTERNS = [
  { label: "local environment file", pattern: /(^|\/)\.env(?:\..*)?$/ },
  { label: "generated extension archive", pattern: /\.(?:crx|xpi|zip)$/i },
  { label: "archive artifact", pattern: /\.(?:tar|tgz|tar\.gz|7z|rar)$/i },
  { label: "private key or certificate bundle", pattern: /\.(?:key|p12|pfx|pem)$/i },
  { label: "local log file", pattern: /\.log$/i },
  { label: "patch reject file", pattern: /\.rej$/i },
  { label: "merge backup file", pattern: /\.(?:orig|bak|backup|old)$/i },
  { label: "temporary file", pattern: /\.(?:tmp|temp)$/i },
  { label: "editor swap file", pattern: /\.(?:swp|swo)$/i },
  { label: "editor backup file", pattern: /~$/ },
  { label: "macOS metadata file", pattern: /(^|\/)\.DS_Store$/ },
  { label: "Windows metadata file", pattern: /(^|\/)(?:Thumbs\.db|desktop\.ini)$/i },
  { label: "SSH private key", pattern: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/ }
];

const TEXT_FILE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".toml",
  ".txt",
  ".yaml",
  ".yml"
]);

const TEXT_FILE_NAMES = new Set([".gitignore", "AGENTS.md", "LICENSE"]);

const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, grepTerm: "PRIVATE KEY" },
  { label: "AWS access key id", pattern: /AKIA[0-9A-Z]{16}/, grepTerm: "AKIA" },
  { label: "AWS temporary access key id", pattern: /ASIA[0-9A-Z]{16}/, grepTerm: "ASIA" },
  { label: "GitLab token", pattern: /glpat-[A-Za-z0-9_-]{20,}/, grepTerm: "glpat-" },
  { label: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/, grepTerm: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] },
  { label: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{22,}/, grepTerm: "github_pat_" },
  { label: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/, grepTerm: "AIza" },
  { label: "OpenAI project or service token", pattern: /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/, grepTerm: "sk-" },
  { label: "OpenAI legacy token", pattern: /sk-[A-Za-z0-9]{32,}/, grepTerm: "sk-" },
  { label: "Anthropic API token", pattern: /sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,}/, grepTerm: "sk-ant-api" },
  { label: "Stripe live secret key", pattern: /(?:sk|rk)_live_[A-Za-z0-9]{24,}/, grepTerm: "_live_" },
  { label: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/, grepTerm: "xox" },
  { label: "Slack webhook URL", pattern: /hooks\.slack\.com\/services\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{20,}/, grepTerm: "hooks.slack.com/services/" },
  { label: "npm token", pattern: /npm_[A-Za-z0-9]{36}/, grepTerm: "npm_" },
  { label: "SendGrid API token", pattern: /SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, grepTerm: "SG." },
  { label: "JWT bearer token", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, grepTerm: "eyJ" }
];

const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/gi;

const BASIC_AUTHORIZATION_PATTERN = /\bBasic\s+([A-Za-z0-9+/]+={0,2})\b/g;

const MINIMUM_ENCODED_BASIC_AUTH_LENGTH = 16;

const SOURCE_FOOTER_PATTERN = /\/\*\n#{20,}[\s\S]*?Copyright \(c\) JoeShade[\s\S]*?Licensed under the GNU Affero General Public License v3\.0[\s\S]*?\n\*\//g;

const SOURCE_FOOTER_CONTACT_LINE_PATTERN =
  /^\s*(?:"|'|`)?\s*\+44 \(0\) 7356 042702 \| joe@jshade\.co\.uk\s*(?:"|'|`)?,?\s*$/i;

const CANONICAL_FOOTER_CONSTANT_PATTERN =
  /const CANONICAL_FOOTER = normalizeNewlines\([\s\S]*?\n\);\n/g;

export function isTextFile(relativePath) {
  return (
    TEXT_FILE_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) ||
    TEXT_FILE_NAMES.has(path.basename(relativePath))
  );
}

export function artifactFindingsForPath(relativePath) {
  const match = FORBIDDEN_ARTIFACT_PATTERNS.find(({ pattern }) =>
    pattern.test(relativePath)
  );

  return match ? [`${relativePath} (${match.label})`] : [];
}

export function securityGrepTerms() {
  return [
    ...new Set([
      ...HIGH_CONFIDENCE_SECRET_PATTERNS.flatMap(({ grepTerm }) => grepTerm),
      "Basic "
    ])
  ];
}

export function highConfidenceSecretFindings(relativePath, text) {
  const findings = [];
  const normalizedText = normalizeNewlines(text);

  for (const { label, pattern } of HIGH_CONFIDENCE_SECRET_PATTERNS) {
    if (pattern.test(normalizedText)) {
      findings.push(`${relativePath} (${label})`);
    }
  }

  return findings;
}

export function fixtureEmailFindings(relativePath, text) {
  if (isDocumentationFile(relativePath)) {
    return [];
  }

  const findings = [];
  const normalizedText = normalizeNewlines(text);
  const ignoredRanges = ignoredEmailRanges(relativePath, normalizedText);

  for (const match of normalizedText.matchAll(EMAIL_ADDRESS_PATTERN)) {
    if (
      isPlaceholderEmail(match[0]) ||
      isOffsetInRanges(match.index, ignoredRanges)
    ) {
      continue;
    }
    findings.push(`${relativePath}:${lineNumberForOffset(normalizedText, match.index)}`);
  }

  return findings;
}

export function fixtureEmailLineFindings(relativePath, line, lineNumber) {
  if (isDocumentationFile(relativePath) || isFooterContactLine(line)) {
    return [];
  }

  const findings = [];
  for (const match of normalizeNewlines(line).matchAll(EMAIL_ADDRESS_PATTERN)) {
    if (!isPlaceholderEmail(match[0])) {
      findings.push(`${relativePath}:${lineNumber}`);
    }
  }

  return findings;
}

export function basicAuthorizationFindings(relativePath, text) {
  const findings = [];
  const normalizedText = normalizeNewlines(text);

  for (const match of normalizedText.matchAll(BASIC_AUTHORIZATION_PATTERN)) {
    const encodedPayload = match[1];
    if (encodedPayload.length < MINIMUM_ENCODED_BASIC_AUTH_LENGTH) {
      continue;
    }

    const decodedPayload = decodeBasicAuthorizationPayload(encodedPayload);
    const [username, password, ...extraParts] = decodedPayload
      ? decodedPayload.split(":")
      : [];
    if (
      decodedPayload &&
      username &&
      password &&
      extraParts.length === 0 &&
      isPlaceholderEmail(username)
    ) {
      continue;
    }

    findings.push(`${relativePath}:${lineNumberForOffset(normalizedText, match.index)}`);
  }

  return findings;
}

export function securityTextFindings(relativePath, text) {
  return [
    ...highConfidenceSecretFindings(relativePath, text),
    ...fixtureEmailFindings(relativePath, text),
    ...basicAuthorizationFindings(relativePath, text)
  ];
}

function isDocumentationFile(relativePath) {
  return path.extname(relativePath).toLowerCase() === ".md";
}

function isFooterContactLine(line) {
  return SOURCE_FOOTER_CONTACT_LINE_PATTERN.test(line);
}

function isPlaceholderEmail(emailAddress) {
  const domain = emailAddress.toLowerCase().split("@").at(-1);

  return (
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain === "example.test" ||
    domain.endsWith(".example.com") ||
    domain.endsWith(".example.net") ||
    domain.endsWith(".example.org") ||
    domain.endsWith(".example.test") ||
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".local")
  );
}

function ignoredEmailRanges(relativePath, text) {
  const ranges = [];
  for (const match of text.matchAll(SOURCE_FOOTER_PATTERN)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  if (relativePath === "tests/test_repo_hygiene.test.js") {
    for (const match of text.matchAll(CANONICAL_FOOTER_CONSTANT_PATTERN)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return ranges;
}

function isOffsetInRanges(offset, ranges) {
  return ranges.some(({ start, end }) => offset >= start && offset < end);
}

function lineNumberForOffset(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function decodeBasicAuthorizationPayload(encodedPayload) {
  const normalizedPayload = encodedPayload.replace(/=+$/, "");
  const paddingLength = (4 - (normalizedPayload.length % 4)) % 4;
  const paddedPayload = normalizedPayload + "=".repeat(paddingLength);
  const decodedBuffer = Buffer.from(paddedPayload, "base64");
  const reencodedPayload = decodedBuffer.toString("base64").replace(/=+$/, "");

  if (reencodedPayload !== normalizedPayload) {
    return null;
  }

  const decodedText = decodedBuffer.toString("utf8");
  if (decodedText.includes("\uFFFD")) {
    return null;
  }

  return decodedText;
}

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
