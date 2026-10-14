/*
 * Deterministic harness checks for evidence durability, download accounting,
 * exclusive run isolation and bounded polling. No live services are contacted.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { accountDownloads, atomicJson, createRun, issue, poll, redact, retryObservation } from "./common.js";
import { identifierChecks } from "./identifiers.js";
import { attachDiagnostics, classifyFailure, diagnosticCollector, diagnosticRecord } from "./diagnostics.js";
import { coverageSummary } from "./coverage.js";

const temporary = [];
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headless-qa-"));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("headless QA evidence", () => {
  it("redacts nested evidence without changing its structure or input", async () => {
    const original = { metadata: { url: 'https://example.test/?token=covered-secret', authorization: 'Bearer covered-auth' },
      nested: [null, 42, true, { quoted: 'a "quote" \\ path', mpn: 'RC0603FR-0710KL/TR' }] };
    const before = globalThis.structuredClone(original);
    const safe = redact(original);
    expect(safe).toMatchObject({ nested: original.nested });
    expect(JSON.stringify(safe)).not.toMatch(/covered-secret|covered-auth/);
    expect(original).toEqual(before);
    const filename = path.join(await tempDir(), "nested.json");
    await atomicJson(filename, original);
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual(safe);
  });
  it("accepts intentional merged symbol-library writes and preserves both events", async () => {
    const root = await tempDir(), directory = path.join(root, "ecad");
    await fs.mkdir(directory);
    const filename = path.join(directory, "ecad.kicad_sym");
    const first = '(kicad_symbol_lib (version 20231120) (symbol "one"))';
    const final = '(kicad_symbol_lib (version 20231120) (symbol "one") (symbol "two"))';
    await fs.writeFile(filename, final);
    const items = [
      { id: 2, filename, state: "complete", bytesReceived: Buffer.byteLength(final), startTime: "2026-10-13T10:00:02Z", endTime: "2026-10-13T10:00:03Z", symbolLibraryText: final },
      { id: 1, filename, state: "complete", bytesReceived: Buffer.byteLength(first), startTime: "2026-10-13T10:00:00Z", endTime: "2026-10-13T10:00:01Z", symbolLibraryText: first }
    ];
    const accounting = await accountDownloads(items, root, {
      settings: { downloadIndividually: false, libraryDownloadRoot: "ecad" }, expectedEntries: ["one", "two"]
    });
    expect(accounting.assets).toHaveLength(1);
    expect(accounting.assets[0]).toMatchObject({ verified: true, finalEventId: 2, symbolEntries: ["one", "two"], completeness: "PASS" });
    expect(accounting.events.find(event => event.id === 1)).toMatchObject({ disposition: "SUPERSEDED", outcome: "PASS" });
    expect(accounting.events).toHaveLength(2);
  });
  it("writes atomic JSON without leftover temporary files", async () => {
    const dir = await tempDir();
    const filename = path.join(dir, "result.json");
    await atomicJson(filename, { value: 1 });
    await atomicJson(filename, { value: 2 });
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual({ value: 2 });
    expect(await fs.readdir(dir)).toEqual(["result.json"]);
  });
  it("rejects reused IDs and path traversal while isolating downloads", async () => {
    const root = await tempDir();
    const first = await createRun(root, "first");
    const second = await createRun(root, "second");
    await fs.writeFile(path.join(first.dir, "downloads", "one.step"), "first");
    expect(await fs.readdir(path.join(second.dir, "downloads"))).toEqual([]);
    await expect(createRun(root, "first")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(createRun(root, "../escape")).rejects.toThrow("Invalid run ID");
  });
  it("persists failed checks without inventing completed downstream stages", async () => {
    const run = await createRun(await tempDir(), "states");
    await run.stage("navigation", () => run.check("navigation", "FAIL", "Reference mismatch"));
    expect(run.result.stages.navigation.execution).toBe("COMPLETED");
    await expect(run.stage("popup", async () => { throw issue("Popup blocked"); })).rejects.toThrow("Popup blocked");
    const saved = JSON.parse(await fs.readFile(path.join(run.dir, "result.json"), "utf8"));
    expect(saved.stages.popup.execution).toBe("FAILED");
    expect(saved.stages.downloads.execution).toBe("NOT_RUN");
    expect(saved.stages.popup.checks[0].outcome).toBe("BLOCKED");
  });
  it("requires terminal completion, existence, size and run containment", async () => {
    const root = await tempDir();
    const dir = path.join(root, "downloads");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "good.step"), "model");
    await fs.writeFile(path.join(dir, "empty.step"), "");
    await fs.writeFile(path.join(root, "outside.step"), "model");
    const accounting = await accountDownloads([
      { id: 1, filename: path.join(dir, "good.step"), state: "complete" },
      { id: 2, filename: path.join(dir, "pending.step"), state: "in_progress" },
      { id: 3, filename: path.join(dir, "empty.step"), state: "complete" },
      { id: 4, filename: path.join(dir, "missing.step"), state: "complete" },
      { id: 5, filename: path.join(root, "outside.step"), state: "complete" },
      { id: 6, filename: path.join(dir, "interrupted.step"), state: "interrupted", error: "NETWORK_FAILED" }
    ], dir);
    const rows = accounting.assets;
    expect(rows.map(row => row.verified)).toEqual([true, false, false, false, false, false]);
    expect(rows[4].relativePath).toBeNull();
    expect(accounting.events[5].error).toBe("NETWORK_FAILED");
    const duplicate = await accountDownloads([
      { id: 7, filename: path.join(dir, "good.step"), state: "complete", bytesReceived: 5 },
      { id: 8, filename: path.join(dir, "good.step"), state: "complete", bytesReceived: 50 }
    ], dir);
    expect(duplicate.assets.every(row => row.unexpectedCollision && !row.verified)).toBe(true);
    const wrongSize = await accountDownloads([
      { id: 9, filename: path.join(dir, "good.step"), state: "complete", bytesReceived: 50 }
    ], dir);
    expect(wrongSize.assets[0].verified).toBe(false);
  });
  it("retains interrupted overwrite events and fails a merged library missing an expected entry", async () => {
    const root = await tempDir(), directory = path.join(root, "ecad");
    await fs.mkdir(directory);
    const filename = path.join(directory, "ecad.kicad_sym");
    const text = '(kicad_symbol_lib (symbol "one"))';
    await fs.writeFile(filename, text);
    const accounting = await accountDownloads([
      { id: 1, filename, state: "complete", symbolLibraryText: text },
      { id: 2, filename, state: "interrupted", error: "NETWORK_FAILED" }
    ], root, { settings: { downloadIndividually: false, libraryDownloadRoot: "ecad" }, expectedEntries: ["one", "two"] });
    expect(accounting.events.find(event => event.id === 2)).toMatchObject({ disposition: "INCOMPLETE", outcome: "FAIL", error: "NETWORK_FAILED" });
    expect(accounting.assets[0]).toMatchObject({ verified: false, completeness: "FAIL", missingExpectedEntries: ["two"] });
    const partial = await accountDownloads([
      { id: 1, filename, state: "complete", symbolLibraryText: text },
      { id: 2, filename, state: "interrupted", error: "NETWORK_FAILED" }
    ], root, { settings: { downloadIndividually: false, libraryDownloadRoot: "ecad" }, expectedEntries: ["one"] });
    expect(partial.assets[0].verified).toBe(true);
    expect(partial.events[1].outcome).toBe("FAIL");
  });
  it("rejects a completed final merged library that loses an earlier known symbol", async () => {
    const root = await tempDir(), directory = path.join(root, "ecad");
    await fs.mkdir(directory);
    const filename = path.join(directory, "ecad.kicad_sym");
    const before = '(kicad_symbol_lib (symbol "one") (symbol "two"))';
    const final = '(kicad_symbol_lib (symbol "one"))';
    await fs.writeFile(filename, final);
    const result = await accountDownloads([
      { id: 2, filename, state: "complete", symbolLibraryText: final },
      { id: 1, filename, state: "complete", symbolLibraryText: before }
    ], root, { settings: { downloadIndividually: false, libraryDownloadRoot: "ecad" }, expectedEntries: ["one", "two"] });
    expect(result.assets[0]).toMatchObject({ verified: false, finalEventId: 2, completeness: "FAIL", missingExpectedEntries: ["two"] });
  });
  it("reports uncertain overwrite ordering and unavailable entry completeness", async () => {
    const root = await tempDir(), directory = path.join(root, "ecad");
    await fs.mkdir(directory);
    const filename = path.join(directory, "ecad.kicad_sym");
    await fs.writeFile(filename, '(kicad_symbol_lib (symbol "one"))');
    const settings = { downloadIndividually: false, libraryDownloadRoot: "ecad" };
    const result = await accountDownloads([1, 2].map(id => ({ id, filename, state: "complete" })), root, { settings });
    expect(result.assets[0]).toMatchObject({ verified: false, outcome: "REVIEW", finalEventId: null, completeness: "REVIEW" });
    const single = await accountDownloads([{ id: 1, filename, state: "complete" }], root, { settings });
    expect(single.assets[0]).toMatchObject({ verified: true, completeness: "REVIEW" });
    const text = await fs.readFile(filename, "utf8");
    const equivalent = await accountDownloads([2, 1].map(id => ({ id, filename, state: "complete", symbolLibraryText: text })), root, { settings });
    expect(equivalent.assets[0]).toMatchObject({ verified: true, finalEventId: null, ordering: "EQUIVALENT_CONTENT; event order unknown" });
    expect(equivalent.events.every(event => event.disposition === "COMPLETED_EQUIVALENT_WRITE")).toBe(true);
  });
  it("round-trips quoted, escaped and nested token URLs safely", async () => {
    const input = { token: "private-token", username: "private-username", cookieText: 'Cookie: PHPSESSID=private-cookie',
      sessionUrl: 'https://example.test/?PHPSESSID=private-session&part=ABC/TR', other: ['quoted "text"', 'path \\ folder',
      { url: 'https://user:private-password@example.test/p?session=private-session&part=ABC-1/TR', mpn: 'ABC-1/TR', auth: 'private-auth',
        description: 'Bearer private-bearer, "https://example.test/?token=private-query"' }] };
    const before = JSON.stringify(input);
    const filename = path.join(await tempDir(), "redacted.json");
    await atomicJson(filename, input);
    const saved = JSON.parse(await fs.readFile(filename, "utf8"));
    expect(saved.other[2].mpn).toBe("ABC-1/TR");
    expect(saved.other.slice(0, 2)).toEqual(input.other.slice(0, 2));
    expect(JSON.stringify(saved)).not.toContain("private-");
    expect(JSON.stringify(input)).toBe(before);
    const params = new URL(redact('https://example.test/?token=private-value&part=ABC-1%2FTR')).searchParams;
    expect(params.get('part')).toBe('ABC-1/TR');
    expect(params.get('token')).not.toContain('private-');
    expect(redact({ mpn: 'DATA:ABC-1/TR' })).toEqual({ mpn: 'DATA:ABC-1/TR' });
    expect(redact({ imagePayload: 'A'.repeat(10000), url: 'data:image/svg+xml,<svg key="covered-value">payload</svg>' }))
      .toEqual({ imagePayload: '[image/blob omitted]', url: '[image/blob omitted]' });
  });
  it("compares page, detected and popup identifiers without conflating popup activation", () => {
    const context = { provider: "mouserSamacsys", sourcePartNumber: "123-ABC/TR", manufacturerPartNumber: "ABC-1/TR",
      sourcePartLabel: "Mouser part", lookup: { manufacturerName: "Vendor Inc." } };
    const reference = { products: [{ mpn: "ABC-1/TR", brand: "VENDOR INC." }], fields: [{ label: "Mouser No:", value: "123-ABC/TR" }] };
    const popup = { manufacturerPartNumber: "ABC-1/TR", partNumber: "123-ABC/TR", sourcePartLabel: "Mouser part" };
    expect(identifierChecks(context, reference, popup).every(check => check.outcome === "PASS")).toBe(true);
    const wrong = identifierChecks(context, reference, { ...popup, manufacturerPartNumber: "ABC-1", partNumber: "other", sourcePartLabel: "Farnell part" });
    expect(wrong.filter(check => check.name.startsWith("detected.")).every(check => check.outcome === "PASS")).toBe(true);
    for (const name of ["popup.mpn.detected", "popup.distributor.detected", "popup.sourceLabel.detected", "popup.sourceLabel.convention"]) {
      expect(wrong.find(check => check.name === name).outcome).toBe("FAIL");
    }
    expect(identifierChecks({ ...context, lookup: { manufacturerName: "Other Vendor" } }, reference)
      .find(check => check.name === "detected.manufacturer.page").outcome).toBe("FAIL");
  });
  it("reviews unavailable/conflicting references and respects the JLCPCB LCSC source-label convention", () => {
    const context = { provider: "easyedaLcsc", sourcePartLabel: "LCSC part", sourcePartNumber: "C25804", manufacturerPartNumber: "ABC/TR" };
    const reference = { products: [{ mpn: "ABC/TR", sku: "C25804" }, { mpn: "OTHER" }], fields: [] };
    const checks = identifierChecks(context, reference, { sourcePartLabel: "LCSC part", partNumber: "C25804", manufacturerPartNumber: "ABC/TR" }, "jlcpcb.com");
    expect(checks.find(check => check.name === "detected.mpn.page").outcome).toBe("REVIEW");
    expect(checks.find(check => check.name === "detected.manufacturer.page").outcome).toBe("REVIEW");
    expect(checks.find(check => check.name === "popup.sourceLabel.convention").outcome).toBe("PASS");
    expect(identifierChecks(context, { fields: [], products: [] }).every(check => check.outcome === "REVIEW")).toBe(true);
    for (const [website, sourcePartLabel] of [["uk.farnell.com", "Farnell part"], ["au.element14.com", "element14 part"], ["www.newark.com", "Newark part"]]) {
      const family = { ...context, provider: "farnellSamacsys", sourcePartLabel };
      expect(identifierChecks(family, reference, { sourcePartLabel }, website)
        .find(check => check.name === "popup.sourceLabel.convention").outcome).toBe("PASS");
    }
  });
  it("classifies generic failures without guessing while retaining explicit blockers and harness timeouts", () => {
    expect(classifyFailure("Failed to fetch; network failed")).toMatchObject({ outcome: "FAIL", cause: "unknown", category: "runtime-observation" });
    expect(classifyFailure("SamacSys ZIP requires sign-in; HTTP 401")).toMatchObject({ outcome: "BLOCKED", category: "external-access" });
    expect(classifyFailure("Timed out", { category: "harness" })).toMatchObject({ outcome: "BLOCKED", category: "harness" });
  });
  it("persists bounded runtime warnings/exceptions with safe source context", async () => {
    const run = await createRun(await tempDir(), "diagnostics");
    const collector = diagnosticCollector(run, 2);
    const source = { type: "service_worker", url: "https://example.test/?token=private-source" };
    collector.record(diagnosticRecord(source, "Runtime.consoleAPICalled", { type: "warning", args: [{ value: "Bearer private-warning" }] }));
    collector.record(diagnosticRecord(source, "Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "Failed to fetch https://example.test/?token=private-query" } } }));
    collector.record(diagnosticRecord(source, "Log.entryAdded", { entry: { level: "error", text: "extra" } }));
    await collector.flush();
    const saved = JSON.parse(await fs.readFile(path.join(run.dir, "browser/diagnostics.json"), "utf8"));
    expect(saved).toMatchObject({ dropped: 1, records: [{ severity: "warning" }, { finding: { cause: "unknown", outcome: "FAIL" } }] });
    expect(JSON.stringify(saved)).not.toContain("private-");
    expect(await fs.readFile(path.join(run.dir, "execution.log"), "utf8")).toContain("runtime-diagnostic");
  });
  it("captures startup diagnostics for Chrome's other-type action popup and removes listeners", async () => {
    const run = await createRun(await tempDir(), "popup-diagnostics");
    const root = new EventEmitter(), popup = new EventEmitter();
    popup.send = async method => {
      if (method === "Runtime.enable") popup.emit("Runtime.exceptionThrown", {
        exceptionDetails: { text: "Uncaught popup startup failure" }
      });
    };
    popup.detach = async () => {};
    root.connection = () => ({ session: () => popup });
    root.detach = async () => {};
    root.send = async (method, params) => {
      if (method === "Target.setAutoAttach" && params.autoAttach && params.filter.some(filter => filter.type === "other" && !filter.exclude)) {
        root.emit("Target.attachedToTarget", { sessionId: "popup-session", targetInfo: {
          targetId: "popup-target", type: "other", url: "chrome-extension://example/src/popup.html"
        } });
      }
    };
    const controller = await attachDiagnostics({ target: () => ({ createCDPSession: async () => root }), targets: () => [] }, run);
    await controller.close();
    expect(controller.records[0]).toMatchObject({ source: { role: "extension-popup", type: "other" }, finding: { cause: "unknown" } });
    expect(popup.listenerCount("Runtime.exceptionThrown")).toBe(0);
    expect(root.listenerCount("Target.attachedToTarget")).toBe(0);
    expect(controller.summary()).toMatchObject({ count: 1, errors: 1, unknownFailures: 1, contexts: ["extension-popup"] });
  });
  it("retains the first content-message failure when a bounded retry later succeeds", async () => {
    let count = 0;
    const result = await retryObservation(async () => ++count === 1 ? { error: "first failure" } : { error: null, response: { provider: "easyedaLcsc" } }, 500, 1);
    expect(result.attempts[0].firstFailure.message).toBe("first failure");
    expect(result.response.provider).toBe("easyedaLcsc");
    count = 0;
    const recovered = await retryObservation(async () => {
      if (++count === 1) throw new Error("first thrown failure");
      return { error: null, response: { provider: "easyedaLcsc" } };
    }, 100, 1);
    expect(recovered.attempts).toMatchObject([{ outcome: "FAIL", firstFailure: { message: "first thrown failure" } }, { outcome: "PASS" }]);
  });
  it("keeps partial downloads and blocked rendering outstanding in coverage", async () => {
    const run = await createRun(await tempDir(), "partial");
    run.result.stages.downloads.execution = "COMPLETED";
    run.result.stages.downloads.selected = ["downloadSymbol", "downloadFootprint", "downloadModel"];
    run.result.stages.downloads.assets = [{ filename: "one.kicad_sym", relativePath: "one.kicad_sym", verified: true }];
    const coverage = coverageSummary(run.result);
    expect(coverage.produced.assetCategories).toEqual(["downloadSymbol"]);
    expect(coverage.outstanding.assetCategories).toEqual(["downloadFootprint", "downloadModel"]);
    expect(coverage.outstanding.stages).toContain("rendering");
    expect(coverage.fullyInspected).toBe(false);
    run.result.stages.rendering.execution = "FAILED";
    run.result.stages.rendering.checks.push({ outcome: "BLOCKED" });
    expect(coverageSummary(run.result).liveEndToEndDemonstrated).toBe(false);
    expect(coverageSummary(run.result).expected.inspections).toBeNull();
    expect(coverageSummary(run.result).outstanding.inspections).toHaveLength(1);
  });
  it("terminates a bounded poll and retains the last observation", async () => {
    await expect(poll(async () => ({ pending: true }), () => false, 15, 2))
      .rejects.toMatchObject({ outcome: "BLOCKED", last: { pending: true } });
    let count = 0;
    expect(await poll(async () => ++count, value => value === 2, 200, 1)).toBe(2);
    await expect(poll(() => new Promise(() => {}), () => true, 15)).rejects.toThrow("Timed out");
  });
  it("omits common credentials and image data from diagnostic text", () => {
    expect(redact("Bearer placeholder_token https://example.test/?token=placeholder data:image/png;base64,abc user@example.test"))
      .not.toMatch(/placeholder|base64|user@/);
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
