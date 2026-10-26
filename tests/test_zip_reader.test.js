/*
 * @vitest-environment node
 *
 * ZIP extraction regressions use a tiny archive with a known CRC-32 checksum.
 * Byte-level corruptions exercise runtime validation before any CAD is exported.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readZipEntries } from "../src/vendor/zip_reader.js";

// Build one classic ZIP member using the standard CRC-32 check string. Tests
// mutate declared lengths and offsets independently from the actual file bytes.
function createZip({ deflate = false, comment = "" } = {}) {
  const name = new TextEncoder().encode("3D/check.step");
  const data = new TextEncoder().encode("123456789");
  const compressed = deflate ? deflateRawSync(data) : data;
  const encodedComment = new TextEncoder().encode(comment);
  const centralOffset = 30 + name.length + compressed.length;
  const endOffset = centralOffset + 46 + name.length;
  const bytes = new Uint8Array(endOffset + 22 + encodedComment.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, deflate ? 8 : 0, true);
  view.setUint32(14, 0xcbf43926, true);
  view.setUint32(18, compressed.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, name.length, true);
  bytes.set(name, 30);
  bytes.set(compressed, 30 + name.length);
  view.setUint32(centralOffset, 0x02014b50, true);
  view.setUint16(centralOffset + 10, deflate ? 8 : 0, true);
  view.setUint32(centralOffset + 16, 0xcbf43926, true);
  view.setUint32(centralOffset + 20, compressed.length, true);
  view.setUint32(centralOffset + 24, data.length, true);
  view.setUint16(centralOffset + 28, name.length, true);
  bytes.set(name, centralOffset + 46);
  view.setUint32(endOffset, 0x06054b50, true);
  view.setUint16(endOffset + 8, 1, true);
  view.setUint16(endOffset + 10, 1, true);
  view.setUint32(endOffset + 12, 46 + name.length, true);
  view.setUint32(endOffset + 16, centralOffset, true);
  view.setUint16(endOffset + 20, encodedComment.length, true);
  bytes.set(encodedComment, endOffset + 22);
  return { bytes, view, centralOffset, endOffset, dataOffset: 30 + name.length };
}

// Node 20's native decompressor accepts fewer formats than supported browsers.
// The stream shim still exercises production output-size checking around deflate.
function installDecompressor() {
  vi.stubGlobal("DecompressionStream", class {
    constructor(format) {
      expect(format).toBe("deflate-raw");
      const chunks = [];
      return new globalThis.TransformStream({
        transform(chunk) { chunks.push(Buffer.from(chunk)); },
        flush(controller) { controller.enqueue(inflateRawSync(Buffer.concat(chunks))); }
      });
    }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("ZIP archive validation", () => {
  it.each([false, true])("extracts an intact archive (deflate=%s)", async deflate => {
    installDecompressor();
    const { bytes } = createZip({ deflate, comment: "CAD bundle" });
    expect(await readZipEntries(bytes)).toEqual([{
      name: "3D/check.step", data: new TextEncoder().encode("123456789")
    }]);
  });

  it("honors a Uint8Array's offset and length", async () => {
    const { bytes } = createZip();
    const wrapper = new Uint8Array(bytes.length + 10);
    wrapper.set(bytes, 5);
    expect((await readZipEntries(wrapper.subarray(5, -5)))[0].name).toBe("3D/check.step");
  });

  it("rejects corrupt stored file bytes", async () => {
    const h = createZip();
    h.bytes[h.dataOffset] ^= 1;
    await expect(readZipEntries(h.bytes)).rejects.toThrow("ZIP entry integrity check failed");
  });

  it("rejects file data that overlaps the central directory", async () => {
    const h = createZip();
    h.view.setUint32(h.centralOffset + 20, 1000, true);
    await expect(readZipEntries(h.bytes)).rejects.toThrow("ZIP entry data is outside");
  });

  it("rejects a central-directory filename extending outside its record area", async () => {
    const h = createZip();
    h.view.setUint16(h.centralOffset + 28, 1000, true);
    await expect(readZipEntries(h.bytes)).rejects.toThrow("ZIP central directory");
  });

  it("rejects inconsistent uncompressed lengths", async () => {
    const h = createZip();
    h.view.setUint32(h.centralOffset + 24, 5, true);
    await expect(readZipEntries(h.bytes)).rejects.toThrow("ZIP entry integrity check failed");
  });

  it("bounds inflated data by the declared size", async () => {
    installDecompressor();
    const h = createZip({ deflate: true });
    h.view.setUint32(h.centralOffset + 24, 4, true);
    await expect(readZipEntries(h.bytes)).rejects.toThrow("ZIP entry exceeds its declared size");
  });

  it("rejects archives exceeding the 256 MiB expansion budget before decompression", async () => {
    const h = createZip({ deflate: true });
    h.view.setUint32(h.centralOffset + 24, 256 * 1024 * 1024 + 1, true);
    await expect(readZipEntries(h.bytes)).rejects.toThrow("ZIP expanded data exceeds 256 MiB");
  });

  it.each(["encrypted", "multi-disk", "zip64"])("rejects unsupported %s archives explicitly", async kind => {
    const h = createZip();
    if (kind === "encrypted") h.view.setUint16(h.centralOffset + 8, 1, true);
    if (kind === "multi-disk") h.view.setUint16(h.endOffset + 4, 1, true);
    if (kind === "zip64") h.view.setUint32(h.endOffset + 16, 0xffffffff, true);
    await expect(readZipEntries(h.bytes)).rejects.toThrow("ZIP archive uses unsupported");
  });

  it("rejects a truncated ZIP comment", async () => {
    const { bytes } = createZip({ comment: "unfinished" });
    await expect(readZipEntries(bytes.subarray(0, -2))).rejects.toThrow("ZIP end of central directory");
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
