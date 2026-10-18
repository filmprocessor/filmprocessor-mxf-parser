/**
 * MXF Parser — Shared module for parsing SMPTE MXF (Material eXchange Format) files
 *
 * Provides KLV scanning, metadata extraction, frame indexing, and audio extraction
 * for DCP (Digital Cinema Package) MXF files. Used by both the media player and transcoder.
 *
 * Standards: SMPTE ST 377-1 (MXF), ST 379-1 (GC), ST 382M (AES3 audio),
 *            ST 377-4 (MCA), ST 429-2/3 (DCP picture/audio), ST 429-10 (stereoscopic picture)
 */

// ─── SMPTE Universal Labels ─────────────────────────────────────────────────

const UL_RGBA_DESC = [0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x29];
const UL_CDCI_DESC = [0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x28];
const UL_WAVE_DESC = [0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x48];
const UL_MCA_CHANNEL_SUBDESC = [0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x6b];
// Primer Pack — maps this file's dynamic local tags to the ULs they stand for.
const UL_PRIMER_PACK = [0x06,0x0e,0x2b,0x34,0x02,0x05,0x01,0x01,0x0d,0x01,0x02,0x01,0x01,0x05,0x01];
// The MCA item ULs, resolved through the Primer Pack rather than by guessing a
// local tag — local tags are per-file, and only the primer says what they mean.
const UL_MCA_LABEL_DICT_ID = '060e2b340101010e0103070101000000';
const UL_MCA_CHANNEL_ID    = '060e2b340101010e0103040a00000000';
const UL_STEREO_SUBDESC = [0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x01,0x01,0x01,0x01,0x63];
// SMPTE ST 429-6 CryptographicContext set — its presence in header metadata
// marks the file as encrypted (essence is EncryptedTriplet KLVs, not plaintext
// picture/sound elements, so the frame index and codestream reads cannot work
// without the content key).
const UL_CRYPTO_CONTEXT = [0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x04,0x01,0x02,0x02,0x00];
// EncryptedTriplet essence element key (ST 429-6).
const UL_CRYPT_ESSENCE = [0x06,0x0e,0x2b,0x34,0x02,0x04,0x01,0x01,0x0d,0x01,0x03,0x01,0x02,0x7e,0x01];

// SMPTE ST 429-2 well-known channel label UL suffixes (last 4 bytes)
// SMPTE DC audio channel labels, keyed on UL bytes 8-11 — the discriminating
// bytes. (Bytes 12-15 are 00000000 for every DC audio label, so keying on those
// matched nothing and this table returned null for every real DCP.)
// Values mirror tools/fixtures/smpte-mca-registry.json (asdcplib MDD.cpp).
const CHANNEL_LABELS = {
  '03020101': 'L',
  '03020102': 'R',
  '03020103': 'C',
  '03020104': 'LFE',
  '03020105': 'Ls',
  '03020106': 'Rs',
  '03020107': 'Lss',
  '03020108': 'Rss',
  '03020109': 'Lrs',
  '0302010a': 'Rrs',
  '0302010b': 'Lc',
  '0302010c': 'Rc',
  '0302010d': 'Cs',
  '0302010e': 'HI',
  '0302010f': 'VIN',
  '03020110': 'FSKSync',
};

// ─── Low-Level Helpers ───────────────────────────────────────────────────────

/**
 * Decode a BER (Basic Encoding Rules) length from MXF KLV triplet
 * @param {Uint8Array} data - Buffer to read from
 * @param {number} offset - Position of the BER length byte
 * @returns {{length: number, bytesRead: number}}
 */
export function decodeBER(data, offset) {
  const b = data[offset];
  if (b < 0x80) return { length: b, bytesRead: 1 };
  const n = b & 0x7f;
  if (n > 8 || offset + 1 + n > data.length) return { length: 0, bytesRead: 1 };
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + data[offset + 1 + i];
  return { length: len, bytesRead: 1 + n };
}

/**
 * Check if bytes at offset match a SMPTE UL prefix
 * @param {Uint8Array} data
 * @param {number} offset
 * @param {number[]} ul - Expected UL bytes
 * @returns {boolean}
 */
export function matchUL(data, offset, ul) {
  for (let i = 0; i < ul.length; i++) {
    if (data[offset + i] !== ul[i]) return false;
  }
  return true;
}

/**
 * Check for SMPTE Picture Element KLV key with flexible version byte matching.
 * Matches GC JPEG2000 (0x15) and CP frame-wrapped picture (0x05).
 * Byte 7 (version) is intentionally skipped — varies between MXF implementations.
 */
export function isPictureElement(data, offset) {
  return data[offset]    === 0x06 && data[offset+1]  === 0x0e &&
         data[offset+2]  === 0x2b && data[offset+3]  === 0x34 &&
         data[offset+4]  === 0x01 && data[offset+5]  === 0x02 &&
         data[offset+6]  === 0x01 && // skip byte 7 (version)
         data[offset+8]  === 0x0d && data[offset+9]  === 0x01 &&
         data[offset+10] === 0x03 && data[offset+11] === 0x01 &&
         (data[offset+12] === 0x15 || data[offset+12] === 0x05);
}

/**
 * Check for SMPTE Sound Element KLV key with flexible version byte matching.
 * Byte 7 (version) is intentionally skipped — some MXFs use 0x01, others 0x02.
 */
export function isSoundElement(data, offset) {
  return data[offset]    === 0x06 && data[offset+1]  === 0x0e &&
         data[offset+2]  === 0x2b && data[offset+3]  === 0x34 &&
         data[offset+4]  === 0x01 && data[offset+5]  === 0x02 &&
         data[offset+6]  === 0x01 &&
         // byte 7 (offset+7) intentionally skipped — version varies (0x01 or 0x02)
         data[offset+8]  === 0x0d && data[offset+9]  === 0x01 &&
         data[offset+10] === 0x03 && data[offset+11] === 0x01 &&
         data[offset+12] === 0x16;
}

/**
 * Check for Body Partition Pack — marks start of essence data, skipping header metadata.
 * Version byte flexible.
 */
export function isBodyPartition(data, offset) {
  return data[offset]    === 0x06 && data[offset+1]  === 0x0e &&
         data[offset+2]  === 0x2b && data[offset+3]  === 0x34 &&
         data[offset+4]  === 0x02 && data[offset+5]  === 0x05 &&
         data[offset+6]  === 0x01 && // skip byte 7
         data[offset+8]  === 0x0d && data[offset+9]  === 0x01 &&
         data[offset+10] === 0x02 && data[offset+11] === 0x01 &&
         data[offset+12] === 0x01 && data[offset+13] === 0x03;
}

/**
 * Check for SMPTE UL prefix (first 4 bytes: 06.0e.2b.34)
 */
export function isSMPTEKey(data, offset) {
  return data[offset] === 0x06 && data[offset+1] === 0x0e &&
         data[offset+2] === 0x2b && data[offset+3] === 0x34;
}

/**
 * Parse local set tag-length-value properties from a metadata set
 * @param {Uint8Array} data
 * @param {number} offset - Start of the local set value area
 * @param {number} end - End boundary
 * @returns {Object.<number, Uint8Array>} Map of tag → value bytes
 */
export function parseLocalSet(data, offset, end) {
  const props = {};
  let pos = offset;
  while (pos + 4 <= end) {
    const tag = (data[pos] << 8) | data[pos + 1];
    const pLen = (data[pos + 2] << 8) | data[pos + 3];
    pos += 4;
    if (pos + pLen > end) break;
    props[tag] = data.slice(pos, pos + pLen);
    pos += pLen;
  }
  return props;
}

// ─── High-Level Functions ────────────────────────────────────────────────────

/**
 * Probe an MXF file's header to determine if it contains video or audio essence.
 * @param {File} mxfFile
 * @returns {Promise<"video"|"audio"|"unknown">}
 */
export async function probeMXFType(mxfFile) {
  const headerSize = Math.min(mxfFile.size, 2 * 1024 * 1024);
  const hdr = new Uint8Array(await mxfFile.slice(0, headerSize).arrayBuffer());

  if (hdr.length < 16 || !isSMPTEKey(hdr, 0)) return 'unknown';

  let hasVideo = false, hasAudio = false;
  let pos = 0;

  while (pos + 16 < hdr.length) {
    if (!isSMPTEKey(hdr, pos)) { pos++; continue; }

    if (matchUL(hdr, pos, UL_RGBA_DESC) || matchUL(hdr, pos, UL_CDCI_DESC)) {
      hasVideo = true;
    }
    if (matchUL(hdr, pos, UL_WAVE_DESC)) {
      hasAudio = true;
    }

    if (hasVideo && hasAudio) break;

    pos += 16;
    if (pos >= hdr.length) break;
    const ber = decodeBER(hdr, pos);
    pos += ber.bytesRead;
    if (ber.length > 0) pos += ber.length;
  }

  if (hasVideo) return 'video';
  if (hasAudio) return 'audio';
  return 'unknown';
}

/**
 * Parse MXF header to extract video and audio metadata via KLV scanning.
 * @param {File} mxfFile
 * @returns {Promise<Object>} Parsed metadata
 */
export async function parseMXFMetadata(mxfFile) {
  const headerSize = Math.min(mxfFile.size, 2 * 1024 * 1024);
  const hdr = new Uint8Array(await mxfFile.slice(0, headerSize).arrayBuffer());

  if (!isSMPTEKey(hdr, 0)) {
    throw new Error(`Invalid MXF file: ${mxfFile.name}`);
  }

  let width = 0, height = 0, frameRate = 24, bitDepth = 12;
  let pictureRateNumerator = null, pictureRateDenominator = null;
  let audioSampleRate = 0, audioBitDepth = 0, audioChannels = 0;
  let foundVideo = false, foundAudio = false, stereoscopic = false, encrypted = false;

  let pos = 0;
  while (pos + 16 < hdr.length) {
    if (!isSMPTEKey(hdr, pos)) { pos++; continue; }
    const keyStart = pos;
    pos += 16;
    if (pos >= hdr.length) break;
    const ber = decodeBER(hdr, pos);
    pos += ber.bytesRead;
    const valEnd = Math.min(pos + ber.length, hdr.length);

    // ST 429-6 CryptographicContext — the file is encrypted.
    if (matchUL(hdr, keyStart, UL_CRYPTO_CONTEXT)) {
      encrypted = true;
    }

    // RGBA or CDCI Essence Descriptor
    if (matchUL(hdr, keyStart, UL_RGBA_DESC) || matchUL(hdr, keyStart, UL_CDCI_DESC)) {
      foundVideo = true;
      const props = parseLocalSet(hdr, pos, valEnd);
      if (props[0x3203]?.length >= 4) width = new DataView(props[0x3203].buffer, props[0x3203].byteOffset).getUint32(0, false);
      if (props[0x3202]?.length >= 4) height = new DataView(props[0x3202].buffer, props[0x3202].byteOffset).getUint32(0, false);
      if (props[0x3001]?.length >= 8) {
        const dv = new DataView(props[0x3001].buffer, props[0x3001].byteOffset);
        const num = dv.getUint32(0, false);
        const denom = dv.getUint32(4, false);
        if (num > 0 && denom > 0) {
          pictureRateNumerator = num;
          pictureRateDenominator = denom;
        }
      }
      if (props[0x3301]?.length >= 4) bitDepth = new DataView(props[0x3301].buffer, props[0x3301].byteOffset).getUint32(0, false);
    }

    // Wave Audio Descriptor
    if (matchUL(hdr, keyStart, UL_WAVE_DESC)) {
      foundAudio = true;
      const props = parseLocalSet(hdr, pos, valEnd);
      if (props[0x3D03]?.length >= 8) audioSampleRate = new DataView(props[0x3D03].buffer, props[0x3D03].byteOffset).getUint32(0, false);
      if (props[0x3D01]?.length >= 4) audioBitDepth = new DataView(props[0x3D01].buffer, props[0x3D01].byteOffset).getUint32(0, false);
      if (props[0x3D07]?.length >= 4) audioChannels = new DataView(props[0x3D07].buffer, props[0x3D07].byteOffset).getUint32(0, false);
    }

    // StereoscopicPictureSubDescriptor (SMPTE ST 429-10)
    if (matchUL(hdr, keyStart, UL_STEREO_SUBDESC)) {
      stereoscopic = true;
    }
    pos = valEnd;
  }

  if (!foundVideo) { width = 2048; height = 1080; }
  if (width === 0) width = 2048;
  if (height === 0) height = 1080;

  // ST 429-10: the picture descriptor SampleRate is twice the track edit rate
  // (left + right eye per edit unit). Keep the parsed rational as proof of the
  // exact edit rate; `frameRate` remains the compatibility scalar used by older
  // consumers. A missing/invalid SampleRate retains the legacy display fallback
  // but carries no edit-rate proof, so cadence-sensitive consumers can fail
  // closed instead of mistaking the fallback for package metadata.
  let editRate = null;
  if (foundVideo && pictureRateNumerator !== null && pictureRateDenominator !== null) {
    let numerator = pictureRateNumerator;
    let denominator = pictureRateDenominator * (stereoscopic ? 2 : 1);
    let a = numerator;
    let b = denominator;
    while (b !== 0) [a, b] = [b, a % b];
    numerator /= a;
    denominator /= a;
    editRate = { numerator, denominator };
    frameRate = numerator / denominator;
  }

  return {
    video: foundVideo ? { width, height, frameRate, editRate, bitDepth, stereoscopic } : null,
    audio: foundAudio ? { sampleRate: audioSampleRate, bitDepth: audioBitDepth, channelCount: audioChannels } : null,
    stereoscopic,
    encrypted,
  };
}

/**
 * Fast check for SMPTE ST 429-6 encrypted essence. Encrypted MXFs keep their
 * plaintext RGBA/Wave descriptor (so probeMXFType still reports video/audio) but
 * carry a CryptographicContext set and EncryptedTriplet essence — the frame
 * index and codestream reads cannot work without the content key, so consumers
 * must branch on this instead of silently producing a zero-frame index.
 * @param {File} mxfFile
 * @returns {Promise<boolean>}
 */
export async function isEncryptedMXF(mxfFile) {
  const headerSize = Math.min(mxfFile.size, 2 * 1024 * 1024);
  const hdr = new Uint8Array(await mxfFile.slice(0, headerSize).arrayBuffer());
  if (hdr.length < 16 || !isSMPTEKey(hdr, 0)) return false;

  let pos = 0;
  while (pos + 16 < hdr.length) {
    if (!isSMPTEKey(hdr, pos)) { pos++; continue; }
    if (matchUL(hdr, pos, UL_CRYPTO_CONTEXT)) return true;
    pos += 16;
    if (pos >= hdr.length) break;
    const ber = decodeBER(hdr, pos);
    pos += ber.bytesRead;
    if (ber.length > 0) pos += ber.length;
  }
  return false;
}

/**
 * Build frame index — scan MXF for PICTURE_ELEMENT KLV entries.
 * Returns [{offset, size}] for O(1) random access to J2K codestreams.
 *
 * Two-pass approach:
 *   Pass 1: KLV scan for SMPTE picture element ULs
 *   Pass 2: Fallback J2K SOC marker scan if Pass 1 finds nothing
 *
 * Stereoscopic MXFs (SMPTE ST 429-10) interleave two picture elements per
 * edit unit (left eye, then right eye) under the same picture element key.
 * When the header carries a StereoscopicPictureSubDescriptor, the returned
 * index is edit-unit-based: one entry per edit unit pointing at the left-eye
 * codestream, with the right eye attached as `rightEye: {offset, size}` —
 * so 2D consumers play the left eye at the correct cadence.
 *
 * @param {File} mxfFile
 * @param {function(number):void} [progressCallback] - Called with frame count periodically
 * @param {function(...any):void} [log] - Optional logger
 * @returns {Promise<Array<{offset: number, size: number, rightEye?: {offset: number, size: number}}>>}
 */
export async function buildMXFFrameIndex(mxfFile, progressCallback = null, log = null) {
  const _log = log || (() => {});

  // ST 429-6: encrypted essence is EncryptedTriplet KLVs, not plaintext picture
  // elements — indexing/decoding is impossible without the content key. Fail
  // with a clear signal instead of returning a silent zero-frame index that
  // downstream consumers would misread as a corrupt or empty file.
  if (await isEncryptedMXF(mxfFile)) {
    const error = new Error('This MXF is encrypted (SMPTE ST 429-6). Playback and transcoding require the content key / KDM, which this tool does not decrypt.');
    error.code = 'ENCRYPTED_MXF';
    throw error;
  }

  const frameIndex = [];
  const chunkSize = 4 * 1024 * 1024;
  const overlap = 32;
  let fileOffset = 0;
  const t0 = performance.now();
  let firstKLVLogged = false;
  let stereoscopic = false;

  // Pass 1: KLV-based scan for PICTURE_ELEMENT keys
  while (fileOffset < mxfFile.size) {
    const readStart = fileOffset;
    const readEnd = Math.min(fileOffset + chunkSize, mxfFile.size);
    const chunk = new Uint8Array(await mxfFile.slice(readStart, readEnd).arrayBuffer());
    let p = 0;

    while (p + 20 < chunk.length) {
      if (!isSMPTEKey(chunk, p)) { p++; continue; }
      if (p + 17 >= chunk.length) break;

      if (!firstKLVLogged && readStart + p > 32768) {
        const keyHex = Array.from(chunk.slice(p, p + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const isPic = isPictureElement(chunk, p);
        _log(`First body KLV @${readStart + p}: ${keyHex} (picture=${isPic})`);
        firstKLVLogged = true;
      }

      // StereoscopicPictureSubDescriptor (SMPTE ST 429-10) in header metadata
      if (!stereoscopic && matchUL(chunk, p, UL_STEREO_SUBDESC)) {
        stereoscopic = true;
        _log(`StereoscopicPictureSubDescriptor @${readStart + p} — ST 429-10 left/right interleaved essence`);
      }

      if (isPictureElement(chunk, p)) {
        const ber = decodeBER(chunk, p + 16);
        if (ber.length > 0) {
          const klvHdr = 16 + ber.bytesRead;
          const absOffset = readStart + p + klvHdr;
          frameIndex.push({ offset: absOffset, size: ber.length });

          if (frameIndex.length <= 3) {
            _log(`Frame ${frameIndex.length}: offset=${absOffset}, size=${ber.length}`);
          }

          if (progressCallback && frameIndex.length % 100 === 0) {
            progressCallback(stereoscopic ? frameIndex.length / 2 : frameIndex.length);
          }

          const totalKLV = klvHdr + ber.length;
          if (totalKLV > 0 && p + totalKLV <= chunk.length) {
            p += totalKLV;
          } else {
            fileOffset = readStart + p + totalKLV;
            break;
          }
          continue;
        }
      }

      // Non-picture KLV: skip via BER length
      const ber = decodeBER(chunk, p + 16);
      if (ber.length > 0) {
        const totalKLV = 16 + ber.bytesRead + ber.length;
        if (totalKLV > 0 && p + totalKLV <= chunk.length) {
          p += totalKLV;
        } else {
          fileOffset = readStart + p + totalKLV;
          break;
        }
      } else {
        p += 16;
      }
      continue;
    }

    // At EOF the complete final window has already been scanned. Re-reading
    // its overlap can append the final picture element a second time.
    if (readEnd === mxfFile.size) break;
    if (fileOffset <= readStart) {
      const nextOffset = Math.max(readStart + p, readEnd > overlap ? readEnd - overlap : readEnd);
      if (nextOffset <= readStart) break;
      fileOffset = nextOffset;
    }
  }
  _log(`Pass 1 (KLV scan): ${frameIndex.length} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  // Pass 2 fallback: J2K SOC marker scan
  if (frameIndex.length === 0) {
    console.warn('KLV scan found 0 picture elements — falling back to J2K SOC marker scan');
    fileOffset = 0;

    while (fileOffset < mxfFile.size) {
      const readEnd = Math.min(fileOffset + chunkSize, mxfFile.size);
      const chunk = new Uint8Array(await mxfFile.slice(fileOffset, readEnd).arrayBuffer());

      for (let p = 0; p + 4 < chunk.length; p++) {
        if (chunk[p] === 0xFF && chunk[p+1] === 0x4F &&
            chunk[p+2] === 0xFF && chunk[p+3] === 0x51) {
          if (p + 6 < chunk.length) {
            const sizLen = (chunk[p+4] << 8) | chunk[p+5];
            let frameEnd = p + 1;
            let foundEnd = false;

            for (let q = p + sizLen + 4; q + 1 < chunk.length; q++) {
              if (chunk[q] === 0xFF && chunk[q+1] === 0x4F && q + 3 < chunk.length && chunk[q+2] === 0xFF && chunk[q+3] === 0x51) {
                frameEnd = q;
                foundEnd = true;
                break;
              }
              if (chunk[q] === 0xFF && chunk[q+1] === 0xD9) {
                frameEnd = q + 2;
                foundEnd = true;
                break;
              }
            }

            if (!foundEnd) continue;

            const frameSize = frameEnd - p;
            if (frameSize > 1000) {
              frameIndex.push({ offset: fileOffset + p, size: frameSize });
              if (progressCallback && frameIndex.length % 100 === 0) {
                progressCallback(stereoscopic ? frameIndex.length / 2 : frameIndex.length);
              }
              p = frameEnd - 1;
            }
          }
        }
      }
      const nextOffset = readEnd > overlap ? readEnd - overlap : readEnd;
      if (nextOffset <= fileOffset) break;
      fileOffset = nextOffset;
    }
    _log(`Pass 2 (J2K SOC fallback): ${frameIndex.length} frames`);
  }

  // ST 429-10 stereoscopic: fold interleaved left/right picture elements into
  // one edit-unit entry each — left eye as the primary {offset, size}, right
  // eye attached — so consumers see edit units, not doubled eye-frames.
  if (stereoscopic && frameIndex.length > 0) {
    if (frameIndex.length % 2 !== 0) {
      console.warn(`Stereoscopic MXF has odd picture element count (${frameIndex.length}) — dropping unpaired trailing element`);
    }
    const editUnits = Math.floor(frameIndex.length / 2);
    for (let i = 0; i < editUnits; i++) {
      const left = frameIndex[i * 2];
      const right = frameIndex[i * 2 + 1];
      frameIndex[i] = { offset: left.offset, size: left.size, rightEye: { offset: right.offset, size: right.size } };
    }
    frameIndex.length = editUnits;
    _log(`Stereoscopic fold: ${editUnits} edit units (left/right paired)`);
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  _log(`Frame index complete: ${frameIndex.length} frames from ${(mxfFile.size / 1024 / 1024).toFixed(1)}MB file (${elapsed}s)`);
  return frameIndex;
}

/**
 * Parse SMPTE ST 377-4 MCA (Multi-Channel Audio) SubDescriptors from MXF header data.
 * @param {Uint8Array} headerData - MXF header bytes (typically first 2MB)
 * @returns {Array<{channelIndex: number, label: string}>|null}
 */
/**
 * Build the file's local-tag → UL map from its Primer Pack.
 *
 * MXF local tags in the dynamic range (0x8000+) mean nothing on their own — each
 * file declares what they stand for. Reading a set by a guessed tag therefore
 * works only by luck, which is why this parser previously found nothing in any
 * real DCP (ours writes 0x8001+, the old code looked for 0x3F01/0x3F02).
 *
 * @returns {Map<number,string>} local tag → 32-char hex UL
 */
function parsePrimerPack(headerData) {
  const map = new Map();
  for (let pos = 0; pos + 20 < headerData.length; pos++) {
    if (headerData[pos] !== 0x06 || headerData[pos + 1] !== 0x0e) continue;
    if (!matchUL(headerData, pos, UL_PRIMER_PACK)) continue;

    const ber = decodeBER(headerData, pos + 16);
    let p = pos + 16 + ber.bytesRead;
    const end = Math.min(p + ber.length, headerData.length);
    if (p + 8 > end) break;

    const count = new DataView(headerData.buffer, headerData.byteOffset + p).getUint32(0, false);
    const itemLength = new DataView(headerData.buffer, headerData.byteOffset + p + 4).getUint32(0, false);
    p += 8;
    if (itemLength !== 18) break;   // each entry is a 2-byte tag + a 16-byte UL

    for (let i = 0; i < count && p + 18 <= end; i++, p += 18) {
      const tag = (headerData[p] << 8) | headerData[p + 1];
      const ul = Array.from(headerData.subarray(p + 2, p + 18))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      map.set(tag, ul);
    }
    break;   // the first Primer Pack governs this partition's header metadata
  }
  return map;
}

export function parseMCALabels(headerData) {
  const labels = [];
  const primer = parsePrimerPack(headerData);
  // Resolve the local tags this particular file uses for the MCA items we need.
  const tagFor = (targetUL) => {
    for (const [tag, ul] of primer) if (ul === targetUL) return tag;
    return null;
  };
  const tagLabelDictID = tagFor(UL_MCA_LABEL_DICT_ID);
  const tagChannelID = tagFor(UL_MCA_CHANNEL_ID);
  if (tagLabelDictID === null || tagChannelID === null) return null;

  let pos = 0;
  while (pos + 20 < headerData.length) {
    if (headerData[pos] !== 0x06 || headerData[pos+1] !== 0x0e) { pos++; continue; }
    if (!matchUL(headerData, pos, UL_MCA_CHANNEL_SUBDESC)) { pos++; continue; }

    const ber = decodeBER(headerData, pos + 16);
    const setStart = pos + 16 + ber.bytesRead;
    const setEnd = Math.min(setStart + ber.length, headerData.length);

    try {
      const props = parseLocalSet(headerData, setStart, setEnd);
      let channelIndex = -1;
      let label = null;

      // MCAChannelID is 1-based in the file; callers index from 0.
      const idBytes = props[tagChannelID];
      if (idBytes?.length >= 4) {
        channelIndex = new DataView(idBytes.buffer, idBytes.byteOffset).getUint32(0, false) - 1;
      }
      // MCALabelDictionaryID: bytes 8-11 carry the channel identity. Bytes 12-15
      // are 00000000 for every DC audio label, so keying on those matched nothing.
      const ulBytes = props[tagLabelDictID];
      if (ulBytes?.length >= 16) {
        const identity = Array.from(ulBytes.slice(8, 12))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        label = CHANNEL_LABELS[identity] || null;
      }

      if (channelIndex >= 0 && label) {
        labels.push({ channelIndex, label });
      }
    } catch (e) {
      // Skip malformed descriptors
    }

    pos = setEnd;
  }

  return labels.length > 0 ? labels : null;
}

/**
 * Extract audio PCM from an audio MXF file.
 * Handles both clip-wrapped (single contiguous KLV) and frame-wrapped (per-frame KLVs) audio.
 *
 * For content >10 minutes, returns metadata for progressive loading instead of full PCM.
 *
 * @param {File} audioMxfFile
 * @param {Object} [options]
 * @param {number} [options.progressiveThresholdSec=600] - Threshold for progressive mode
 * @param {boolean} [options.forceProgressive=false] - Always return progressive metadata
 * @returns {Promise<Object>} Audio data or progressive metadata
 */
export async function extractAudioFromMXF(audioMxfFile, options = {}) {
  const { progressiveThresholdSec = 600, forceProgressive = false } = options;

  // Parse header for audio params
  const hdrSize = Math.min(audioMxfFile.size, 2 * 1024 * 1024);
  const hdr = new Uint8Array(await audioMxfFile.slice(0, hdrSize).arrayBuffer());
  let sampleRate = 48000, bitDepth = 24, channelCount = 6;
  let pos = 0;

  while (pos + 16 < hdr.length) {
    if (!isSMPTEKey(hdr, pos)) { pos++; continue; }
    if (matchUL(hdr, pos, UL_WAVE_DESC)) {
      const ber = decodeBER(hdr, pos + 16);
      const vStart = pos + 16 + ber.bytesRead;
      const vEnd = Math.min(vStart + ber.length, hdr.length);
      const props = parseLocalSet(hdr, vStart, vEnd);
      if (props[0x3D03]?.length >= 8) sampleRate = new DataView(props[0x3D03].buffer, props[0x3D03].byteOffset).getUint32(0, false);
      if (props[0x3D01]?.length >= 4) bitDepth = new DataView(props[0x3D01].buffer, props[0x3D01].byteOffset).getUint32(0, false);
      if (props[0x3D07]?.length >= 4) channelCount = new DataView(props[0x3D07].buffer, props[0x3D07].byteOffset).getUint32(0, false);
      console.log(`Audio MXF: ${channelCount}ch, ${sampleRate}Hz, ${bitDepth}-bit`);
      break;
    }
    pos++;
  }

  // Parse MCA channel labels (SMPTE ST 377-4)
  let mcaLabels = null;
  try {
    mcaLabels = parseMCALabels(hdr);
    if (mcaLabels) {
      console.log(`[MXF Audio] MCA labels: ${mcaLabels.map(l => `ch${l.channelIndex}=${l.label}`).join(', ')}`);
    }
  } catch (e) {
    console.warn('[MXF Audio] MCA label parsing failed:', e.message);
  }

  // Scan for sound element KLVs — first find Body Partition Pack, then sound elements
  const bytesPerSample = bitDepth / 8;
  const chunkSize = 4 * 1024 * 1024;
  let fileOffset = 0, pcmOffset = 0, pcmSize = 0;
  let bodyPartitionOffset = 0;

  // Pass 1: Find the Body Partition Pack
  while (fileOffset < audioMxfFile.size && bodyPartitionOffset === 0) {
    const end = Math.min(fileOffset + chunkSize, audioMxfFile.size);
    const chunk = new Uint8Array(await audioMxfFile.slice(fileOffset, end).arrayBuffer());
    let sp = 0;
    while (sp + 20 < chunk.length) {
      if (!isSMPTEKey(chunk, sp)) { sp++; continue; }
      if (isBodyPartition(chunk, sp)) {
        bodyPartitionOffset = fileOffset + sp;
        console.log(`[MXF Audio] Body Partition Pack at offset ${bodyPartitionOffset}`);
        break;
      }
      sp++;
    }
    fileOffset = end;
  }

  // Pass 2: Scan for sound element KLVs starting from body partition
  fileOffset = bodyPartitionOffset;
  let audioFrameCount = 0;
  let isFrameWrapped = false;
  const audioFrameIndex = [];

  while (fileOffset < audioMxfFile.size) {
    const end = Math.min(fileOffset + chunkSize, audioMxfFile.size);
    const chunk = new Uint8Array(await audioMxfFile.slice(fileOffset, end).arrayBuffer());
    let sp = 0;
    while (sp + 20 < chunk.length) {
      if (!isSMPTEKey(chunk, sp)) { sp++; continue; }
      if (isSoundElement(chunk, sp)) {
        const ber = decodeBER(chunk, sp + 16);
        if (ber.length > 0) {
          const dataOffset = fileOffset + sp + 16 + ber.bytesRead;
          audioFrameCount++;

          // Clip-wrapped: single large KLV contains all PCM
          if (ber.length > chunkSize) {
            pcmOffset = dataOffset;
            pcmSize = ber.length;
            console.log(`[MXF Audio] Clip-wrapped audio: ${(pcmSize / 1048576).toFixed(1)}MB`);
            break;
          }

          // Frame-wrapped: collect each element's offset+size
          audioFrameIndex.push({ offset: dataOffset, size: ber.length });
          pcmSize += ber.length;

          const totalKLV = 16 + ber.bytesRead + ber.length;
          if (sp + totalKLV <= chunk.length) {
            sp += totalKLV;
          } else {
            fileOffset = fileOffset + sp + totalKLV;
            sp = chunk.length;
          }
          continue;
        }
      }
      sp++;
    }
    if (pcmOffset > 0) break;
    fileOffset = end;
  }

  if (pcmOffset === 0 && audioFrameIndex.length > 0) {
    isFrameWrapped = true;
    console.log(`[MXF Audio] Frame-wrapped: ${audioFrameIndex.length} elements, ${(pcmSize / 1048576).toFixed(1)}MB PCM`);
  }

  if (pcmSize === 0 && !isFrameWrapped) {
    throw new Error('No audio essence found in MXF');
  }

  // Calculate totals
  const blockAlign = channelCount * bytesPerSample;
  const totalSamples = Math.floor(pcmSize / blockAlign);
  const totalDurationSec = totalSamples / sampleRate;

  // Progressive mode for long content or when forced (e.g., for transcoding)
  if (forceProgressive || totalDurationSec > progressiveThresholdSec) {
    console.log(`[MXF Audio] Progressive mode: ${totalDurationSec.toFixed(1)}s`);
    return {
      progressive: true,
      audioMxfFile,
      pcmOffset,
      pcmSize,
      channelCount,
      sampleRate,
      bitDepth,
      bytesPerSample,
      blockAlign,
      duration: totalDurationSec,
      totalSamples,
      mcaLabels,
      isFrameWrapped,
      audioFrameIndex: isFrameWrapped ? audioFrameIndex : null,
    };
  }

  // Read full PCM — different strategy for clip-wrapped vs frame-wrapped
  const pcmCappedSize = totalSamples * blockAlign;
  let pcm;

  if (isFrameWrapped) {
    console.log(`[MXF Audio] Reading ${audioFrameIndex.length} frame-wrapped elements → ${totalDurationSec.toFixed(1)}s`);
    pcm = new Uint8Array(pcmCappedSize);
    let writePos = 0;
    for (const frame of audioFrameIndex) {
      if (writePos + frame.size > pcmCappedSize) break;
      const frameData = new Uint8Array(await audioMxfFile.slice(frame.offset, frame.offset + frame.size).arrayBuffer());
      pcm.set(frameData, writePos);
      writePos += frame.size;
    }
  } else {
    pcm = new Uint8Array(await audioMxfFile.slice(pcmOffset, pcmOffset + pcmCappedSize).arrayBuffer());
  }

  // Deinterleave little-endian PCM → Float32 (SMPTE 382M byte order)
  const audioCtx = new OfflineAudioContext(channelCount, totalSamples, sampleRate);
  const audioBuffer = audioCtx.createBuffer(channelCount, totalSamples, sampleRate);

  for (let ch = 0; ch < channelCount; ch++) {
    const chData = audioBuffer.getChannelData(ch);
    for (let s = 0; s < totalSamples; s++) {
      const off = s * blockAlign + ch * bytesPerSample;
      if (bytesPerSample === 3) {
        let v = pcm[off] | (pcm[off+1] << 8) | (pcm[off+2] << 16);
        if (v & 0x800000) v |= ~0xFFFFFF;
        chData[s] = v / 8388608.0;
      } else if (bytesPerSample === 2) {
        let v = pcm[off] | (pcm[off+1] << 8);
        if (v & 0x8000) v |= ~0xFFFF;
        chData[s] = v / 32768.0;
      }
    }
  }

  return { audioBuffer, channelCount, sampleRate, bitDepth, duration: totalSamples / sampleRate, totalSamples, mcaLabels };
}

/**
 * Read a single PCM chunk from an MXF audio file (for progressive loading).
 * Handles both clip-wrapped and frame-wrapped audio.
 *
 * @param {Object} audioMeta - Progressive metadata from extractAudioFromMXF()
 * @param {number} startSample - First sample to read
 * @param {number} sampleCount - Number of samples to read
 * @returns {Promise<Float32Array[]>} Array of channel buffers
 */
export async function readAudioChunk(audioMeta, startSample, sampleCount) {
  const { audioMxfFile, pcmOffset, channelCount, bytesPerSample, blockAlign,
          isFrameWrapped, audioFrameIndex } = audioMeta;

  const actualCount = Math.min(sampleCount, audioMeta.totalSamples - startSample);
  if (actualCount <= 0) return null;

  let pcm;

  if (isFrameWrapped && audioFrameIndex) {
    // Calculate which audio frames contain our sample range
    const samplesPerFrame = audioFrameIndex.length > 0
      ? Math.floor(audioFrameIndex[0].size / blockAlign)
      : 0;

    if (samplesPerFrame === 0) return null;

    const startFrame = Math.floor(startSample / samplesPerFrame);
    const endFrame = Math.min(
      Math.ceil((startSample + actualCount) / samplesPerFrame),
      audioFrameIndex.length
    );

    // Read the relevant audio frames
    const chunks = [];
    for (let f = startFrame; f < endFrame; f++) {
      const frame = audioFrameIndex[f];
      const data = new Uint8Array(await audioMxfFile.slice(frame.offset, frame.offset + frame.size).arrayBuffer());
      chunks.push(data);
    }

    // Concatenate and extract the sample range
    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
    pcm = new Uint8Array(totalBytes);
    let writePos = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, writePos);
      writePos += chunk.length;
    }

    // Adjust for offset within first frame
    const offsetInFirstFrame = (startSample - startFrame * samplesPerFrame) * blockAlign;
    pcm = pcm.slice(offsetInFirstFrame, offsetInFirstFrame + actualCount * blockAlign);
  } else {
    // Clip-wrapped: direct range read
    const byteStart = pcmOffset + startSample * blockAlign;
    const byteEnd = byteStart + actualCount * blockAlign;
    pcm = new Uint8Array(await audioMxfFile.slice(byteStart, byteEnd).arrayBuffer());
  }

  // Deinterleave to Float32
  const channels = [];
  for (let ch = 0; ch < channelCount; ch++) {
    const chData = new Float32Array(actualCount);
    for (let s = 0; s < actualCount; s++) {
      const off = s * blockAlign + ch * bytesPerSample;
      if (off + bytesPerSample > pcm.length) break;
      if (bytesPerSample === 3) {
        let v = pcm[off] | (pcm[off+1] << 8) | (pcm[off+2] << 16);
        if (v & 0x800000) v |= ~0xFFFFFF;
        chData[s] = v / 8388608.0;
      } else if (bytesPerSample === 2) {
        let v = pcm[off] | (pcm[off+1] << 8);
        if (v & 0x8000) v |= ~0xFFFF;
        chData[s] = v / 32768.0;
      }
    }
    channels.push(chData);
  }

  return channels;
}
