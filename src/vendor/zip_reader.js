/*
 * Minimal ZIP reader for pre-generated upstream archives. This supports the
 * stored and deflate methods used by the SamacSys KiCad download bundle, with
 * bounded expansion and integrity checks before extracted CAD reaches exports.
 */

const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

// ZIP stores the reflected CRC-32 of each uncompressed member. A lookup table
// applies its eight polynomial steps per byte, then restores the unsigned result.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// The end record sits before its declared comment, within the final 65557 bytes.
// Matching its comment length filters truncated tails and spurious signatures.
function findEndOfCentralDirectory(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06 &&
      offset + 22 + bytes[offset + 20] + (bytes[offset + 21] << 8) === bytes.length
    ) {
      return offset;
    }
  }
  throw new Error("ZIP end of central directory record was not found.");
}

async function inflateRaw(compressedBytes, uncompressedSize) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("ZIP deflate decompression is not available in this runtime.");
  }

  let expandedSize = 0;
  // Check every output chunk before Response collects it. A forged small size
  // stops expansion immediately; the archive-wide declared sizes are capped below.
  const stream = new Blob([compressedBytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .pipeThrough(new globalThis.TransformStream({
      transform(chunk, controller) {
        expandedSize += chunk.byteLength;
        if (expandedSize > uncompressedSize) {
          controller.error(new Error("ZIP entry exceeds its declared size."));
        } else {
          controller.enqueue(chunk);
        }
      }
    }));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

// Directory offsets point to little-endian local headers and compressed bytes.
// Check both boundaries, then verify the expanded size and checksum before
// returning a member. Flag mask 0x2041 covers encryption and masked headers.
async function readZipEntry(bytes, view, metadata) {
  const localHeaderOffset = metadata.localHeaderOffset;
  if (localHeaderOffset + 30 > metadata.centralDirectoryOffset ||
      view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
    throw new Error(`ZIP local header is invalid for ${metadata.name}.`);
  }

  const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
  const localExtraFieldLength = view.getUint16(localHeaderOffset + 28, true);
  const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
  if (dataOffset + metadata.compressedSize > metadata.centralDirectoryOffset) {
    throw new Error(`ZIP entry data is outside the local file area for ${metadata.name}.`);
  }
  if (view.getUint16(localHeaderOffset + 6, true) & 0x2041 ||
      view.getUint16(localHeaderOffset + 8, true) !== metadata.compressionMethod) {
    throw new Error("ZIP archive uses unsupported or inconsistent local file metadata.");
  }
  const compressedBytes = bytes.subarray(
    dataOffset,
    dataOffset + metadata.compressedSize
  );

  let data;
  if (metadata.compressionMethod === 0) data = new Uint8Array(compressedBytes);
  else if (metadata.compressionMethod === 8) data = await inflateRaw(compressedBytes, metadata.uncompressedSize);
  else throw new Error(`ZIP compression method ${metadata.compressionMethod} is not supported for ${metadata.name}.`);
  if (data.byteLength !== metadata.uncompressedSize || crc32(data) !== metadata.crc) {
    throw new Error(`ZIP entry integrity check failed for ${metadata.name}.`);
  }
  return { name: metadata.name, data };
}

// Validate the entire classic single-disk directory before expanding members.
// Declared sizes establish the archive budget; each member also checks its
// actual expanded bytes so dishonest length metadata fails during extraction.
export async function readZipEntries(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  if (view.getUint16(eocdOffset + 4, true) || view.getUint16(eocdOffset + 6, true) ||
      view.getUint16(eocdOffset + 8, true) !== totalEntries || totalEntries === 0xffff ||
      centralDirectoryOffset === 0xffffffff || centralDirectorySize === 0xffffffff) {
    throw new Error("ZIP archive uses unsupported multi-disk or ZIP64 metadata.");
  }
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd > eocdOffset) throw new Error("ZIP central directory is outside the archive.");
  const decoder = new TextDecoder();
  const metadata = [];
  let expandedSize = 0;

  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > centralDirectoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("ZIP central directory record is invalid.");
    }

    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const crc = view.getUint32(offset + 16, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const fileCommentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd + extraFieldLength + fileCommentLength > centralDirectoryEnd) {
      throw new Error("ZIP central directory member is outside its record area.");
    }
    if (view.getUint16(offset + 8, true) & 0x2041 || view.getUint16(offset + 34, true) ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("ZIP archive uses unsupported encrypted, multi-disk or ZIP64 metadata.");
    }
    expandedSize += uncompressedSize;
    if (expandedSize > MAX_EXPANDED_BYTES) throw new Error("ZIP expanded data exceeds 256 MiB.");
    const name = decoder.decode(bytes.subarray(fileNameStart, fileNameEnd));

    metadata.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      crc,
      localHeaderOffset,
      centralDirectoryOffset
    });

    offset = fileNameEnd + extraFieldLength + fileCommentLength;
  }
  if (offset !== centralDirectoryEnd) throw new Error("ZIP central directory length is inconsistent.");

  return Promise.all(metadata.map((entry) => readZipEntry(bytes, view, entry)));
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
