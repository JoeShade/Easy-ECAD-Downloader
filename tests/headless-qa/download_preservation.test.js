/*
 * Regressions for preserving actual browser downloads outside long QA run paths.
 * Hash, containment and cleanup checks keep failed copies recoverable.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountDownloads, sha256 } from "./download_accounting.js";
import { downloadCleanupInventory, preserveDownloads } from "./download_preservation.js";

const temporary = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(files = { "library/part.step": "before" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ecad-preserve-"));
  temporary.push(root);
  const source = path.join(root, "browser"), evidence = path.join(root, "campaign-" + "x".repeat(70), "run-" + "y".repeat(60), "downloads");
  await fs.mkdir(source);
  await fs.mkdir(evidence, { recursive: true });
  const items = [];
  for (const [relativePath, bytes] of Object.entries(files)) {
    const filename = path.join(source, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    items.push({ id: items.length + 1, filename, state: "complete", bytesReceived: Buffer.byteLength(bytes) });
  }
  const accounting = await accountDownloads(items, source);
  return { root, source, evidence, accounting };
}

describe("browser download preservation", () => {
  it("preserves full basenames, relative model layout, bytes and raw browser destinations", async () => {
    const name = "QFN-32_L5.0-W5.0-P0.50-BL-EP3.4.kicad_mod";
    const model = "../ecad.3dshapes/QFN-32_L5.0-W5.0.step";
    const bytes = `(module part (model "${model}"))`;
    const data = await fixture({ [`ecad/ecad.pretty/${name}`]: bytes,
      "ecad/ecad.3dshapes/QFN-32_L5.0-W5.0.step": "model geometry" });
    const before = globalThis.structuredClone(data.accounting);
    const result = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect(result.preservation).toMatchObject({ outcome: "PASS", cleanupSafe: true, copiedFiles: 2, unpreservedPaths: [] });
    expect(result.events).toBe(data.accounting.events);
    expect(result.events[0].destination).toBe(path.join(data.source, "ecad/ecad.pretty", name));
    expect(result.assets.every(asset => asset.verified && asset.preserved && asset.preservedSha256 === asset.sha256)).toBe(true);
    const copiedFootprint = path.join(data.evidence, "ecad/ecad.pretty", name);
    expect(await fs.readFile(copiedFootprint, "utf8")).toBe(bytes);
    expect(await fs.readFile(path.resolve(path.dirname(copiedFootprint), model), "utf8")).toBe("model geometry");
    expect(data.accounting).toEqual(before);
    expect(await fs.readFile(path.join(data.source, "ecad/ecad.pretty", name), "utf8")).toBe(bytes);
  });

  it("preserves existing interrupted bytes without turning them into verified assets", async () => {
    const data = await fixture({ "failed.htm": "partial" });
    data.accounting = await accountDownloads([{ id: 1, filename: path.join(data.source, "failed.htm"),
      state: "interrupted", error: "SERVER_FAILED" }, { id: 2, filename: path.join(data.source, "missing.htm"),
      state: "interrupted", error: "SERVER_FORBIDDEN" }], data.source);
    const result = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect(result.assets[0]).toMatchObject({ verified: false, preserved: true, evidenceRelativePath: "failed.htm" });
    expect(result.assets[1]).toMatchObject({ verified: false, preserved: false });
    expect(result.events[0]).toMatchObject({ error: "SERVER_FAILED", state: "interrupted", outcome: "FAIL" });
    expect(result.preservation).toMatchObject({ outcome: "PASS", cleanupSafe: true, copiedFiles: 1 });
    expect(await fs.readFile(path.join(data.evidence, "failed.htm"), "utf8")).toBe("partial");
  });

  it("blocks evidence collisions without overwriting either original", async () => {
    const data = await fixture();
    await fs.mkdir(path.join(data.evidence, "library"));
    await fs.writeFile(path.join(data.evidence, "library/part.step"), "existing evidence");
    const result = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect(result.preservation).toMatchObject({ outcome: "BLOCKED", category: "harness", cleanupSafe: false });
    expect(result.assets[0]).toMatchObject({ verified: false, preserved: false, outcome: "BLOCKED", category: "harness" });
    expect(await fs.readFile(path.join(data.evidence, "library/part.step"), "utf8")).toBe("existing evidence");
    expect(await fs.readFile(path.join(data.source, "library/part.step"), "utf8")).toBe("before");
  });

  it("rejects source bytes that changed after download accounting", async () => {
    const data = await fixture();
    await fs.writeFile(path.join(data.source, "library/part.step"), "after!");
    const result = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect(result.assets[0]).toMatchObject({ preserved: false, verified: false });
    expect(result.assets[0].preservationError).toMatch(/accounted size\/SHA-256/);
    expect(result.preservation.cleanupSafe).toBe(false);
    await expect(fs.stat(path.join(data.evidence, "library/part.step"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["source", "evidence"])("detects a same-size %s change during the copy", async changed => {
    const data = await fixture(), sourceFile = path.join(data.source, "library/part.step");
    const destination = path.join(data.evidence, "library/part.step"), write = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (filename, ...args) => {
      await write(filename, ...args);
      if (filename === destination) await write(changed === "source" ? sourceFile : destination, "after!");
    });
    const result = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect(result.assets[0]).toMatchObject({ preserved: false, verified: false, outcome: "BLOCKED" });
    expect(result.assets[0].preservationError).toMatch(/changed during preservation/);
    expect(result.preservation).toMatchObject({ outcome: "BLOCKED", cleanupSafe: false });
  });

  it("retains unaccounted partial downloads and reports cleanup as unsafe", async () => {
    const data = await fixture();
    await fs.writeFile(path.join(data.source, "unfinished.step.crdownload"), "partial geometry");
    const result = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect(result.preservation).toMatchObject({ outcome: "PASS", copiedFiles: 1, cleanupSafe: false,
      unpreservedPaths: ["unfinished.step.crdownload"] });
    expect(await fs.readFile(path.join(data.source, "unfinished.step.crdownload"), "utf8")).toBe("partial geometry");
  });

  it("rechecks both acquisition and evidence bytes before authorizing cleanup", async () => {
    const data = await fixture();
    const preserved = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect((await downloadCleanupInventory(data.source, data.evidence, preserved.assets)).cleanupSafe).toBe(true);
    await fs.writeFile(path.join(data.evidence, "library/part.step"), "after!");
    const changed = await downloadCleanupInventory(data.source, data.evidence, preserved.assets);
    expect(changed).toMatchObject({ cleanupSafe: false, unpreservedPaths: ["library/part.step"] });
  });

  it("retains files that arrive after the preservation snapshot", async () => {
    const data = await fixture();
    const preserved = await preserveDownloads(data.accounting, data.source, data.evidence);
    await fs.writeFile(path.join(data.source, "late.step"), "late geometry");
    expect(await downloadCleanupInventory(data.source, data.evidence, preserved.assets))
      .toMatchObject({ cleanupSafe: false, unpreservedPaths: ["late.step"] });
  });

  it.each(["../outside.step", "C:\\outside.step", "/outside.step", "library//part.step"])("refuses unsafe relative path %s", async relativePath => {
    const data = await fixture();
    data.accounting.assets[0].relativePath = relativePath;
    const result = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect(result.assets[0]).toMatchObject({ preserved: false, verified: false, category: "harness" });
    expect(result.preservation).toMatchObject({ outcome: "BLOCKED", cleanupSafe: false });
    expect(await fs.readdir(data.evidence)).toEqual([]);
  });

  it("rejects overlapping roots before writing", async () => {
    const data = await fixture();
    for (const evidence of [data.source, path.join(data.source, "nested")]) {
      await expect(preserveDownloads(data.accounting, data.source, evidence)).rejects.toMatchObject({ outcome: "BLOCKED", category: "harness" });
    }
    expect(await fs.readdir(data.source)).toEqual(["library"]);
  });

  it.each(["source", "evidence"])("never follows a %s directory symlink", async side => {
    const data = await fixture({});
    const outside = path.join(data.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "part.step"), "outside");
    await fs.mkdir(path.join(data.source, "library"));
    await fs.writeFile(path.join(data.source, "library/part.step"), "before");
    if (side === "source") await fs.rename(path.join(data.source, "library"), path.join(data.source, "original"));
    await fs.symlink(outside, path.join(side === "source" ? data.source : data.evidence, "library"),
      process.platform === "win32" ? "junction" : "dir");
    data.accounting = { events: [], assets: [{ relativePath: "library/part.step", filename: "part.step", exists: true,
      size: 6, sha256: sha256(Buffer.from("before")), verified: true, outcome: "PASS" }] };
    const result = await preserveDownloads(data.accounting, data.source, data.evidence);
    expect(result.preservation).toMatchObject({ outcome: "BLOCKED", cleanupSafe: false });
    expect(result.assets[0].preservationError).toMatch(/symbolic links/);
    expect(await fs.readFile(path.join(outside, "part.step"), "utf8")).toBe("outside");
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
