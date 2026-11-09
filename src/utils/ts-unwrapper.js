/**
 * Spoofed-Image MPEG-TS Unwrapper
 *
 * Direct JavaScript port of AniFam's `Q7/m` and `Q7/n` (`h4/l.s()`).
 * Some iframe-resolved streams disguise `.ts` segments with a leading PNG/JPEG/GIF/RIFF/BMP
 * header so CDNs serve them as static images. Browsers (`hls.js` / MSE) and standard muxers
 * reject segments unless those prepended bytes are stripped up to the first valid MPEG-TS
 * sync packet sequence (`0x47` repeated at `pos`, `pos + 188`, and `pos + 376`).
 */

import { Transform } from 'node:stream';

export const TS_SYNC_BYTE = 0x47;
export const TS_PACKET_SIZE = 188;
export const TS_SCAN_WINDOW = 65536; // 64 KiB, matches Q7/n.b()

/**
 * Exact byte magic signatures from `Q7/m.a`.
 */
export const SPOOFED_IMAGE_SIGNATURES = Object.freeze([
  Object.freeze({ name: 'PNG', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }),
  Object.freeze({ name: 'JPEG', bytes: Uint8Array.from([0xff, 0xd8, 0xff]) }),
  Object.freeze({ name: 'GIF8', bytes: Uint8Array.from([0x47, 0x49, 0x46, 0x38]) }),
  Object.freeze({ name: 'RIFF', bytes: Uint8Array.from([0x52, 0x49, 0x46, 0x46]) }),
  Object.freeze({ name: 'BMP', bytes: Uint8Array.from([0x42, 0x4d]) }),
]);

/**
 * Check whether `buffer` begins with any disguised image signature from `Q7/m`.
 *
 * @param {Uint8Array} buffer
 * @returns {{ name: string, bytes: Uint8Array } | null}
 */
export function detectSpoofedImageSignature(buffer) {
  if (!buffer || buffer.length < 4) return null;
  for (const sig of SPOOFED_IMAGE_SIGNATURES) {
    let matched = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[i] !== sig.bytes[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return sig;
  }
  return null;
}

/**
 * Search `buffer` (from `startPos` up to `limit`) for 3 consecutive MPEG-TS sync bytes
 * spaced 188 bytes apart (`pos`, `pos + 188`, `pos + 376`).
 *
 * @param {Uint8Array} buffer
 * @param {number} [startPos=0]
 * @returns {number} Byte offset of the first TS packet, or `-1` if not found yet.
 */
export function findTsSyncOffset(buffer, startPos = 0) {
  const maxPos = buffer.length - TS_PACKET_SIZE * 2;
  if (maxPos <= startPos) return -1;
  for (let i = Math.max(0, startPos); i < maxPos; i++) {
    if (
      buffer[i] === TS_SYNC_BYTE &&
      buffer[i + TS_PACKET_SIZE] === TS_SYNC_BYTE &&
      buffer[i + TS_PACKET_SIZE * 2] === TS_SYNC_BYTE
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Unwrap a complete segment buffer if it carries a disguised image header.
 *
 * @param {Buffer|Uint8Array} input
 * @param {{ forceScan?: boolean }} [options]
 * @returns {{ data: Buffer|Uint8Array, strippedBytes: number, signature: string|null }}
 */
export function unwrapTsBuffer(input, options = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const sig = detectSpoofedImageSignature(buf);
  if (!sig && !options.forceScan) {
    return { data: buf, strippedBytes: 0, signature: null };
  }
  if (sig === null && buf[0] === TS_SYNC_BYTE && buf[TS_PACKET_SIZE] === TS_SYNC_BYTE) {
    return { data: buf, strippedBytes: 0, signature: null };
  }
  const scanSlice = buf.length > TS_SCAN_WINDOW ? buf.subarray(0, TS_SCAN_WINDOW) : buf;
  const offset = findTsSyncOffset(scanSlice, 0);
  if (offset > 0) {
    return {
      data: buf.subarray(offset),
      strippedBytes: offset,
      signature: sig ? sig.name : 'RAW_OFFSET',
    };
  }
  return { data: buf, strippedBytes: 0, signature: sig ? sig.name : null };
}

/**
 * Streaming Transform that mimics `Q7/n` over HTTP chunked responses.
 * Buffers up to 64 KiB until either:
 *  - No disguised image signature is detected once >= 4 bytes arrive (passes through immediately)
 *  - Or a disguised signature IS detected and 3x `0x47` @ 188B sync is located within 64 KiB
 *    (strips prefix and passes through remaining chunks unbuffered).
 */
export class TsUnwrapperTransform extends Transform {
  /**
   * @param {{
   *   enabled?: boolean,
   *   forceScan?: boolean,
   *   onUnwrapped?: (info: { strippedBytes: number, signature: string|null }) => void,
   * }} [options]
   */
  constructor(options = {}) {
    super();
    this.enabled = options.enabled !== false;
    this.forceScan = Boolean(options.forceScan);
    this.onUnwrapped = options.onUnwrapped || null;
    this._decided = !this.enabled;
    this._headerChunks = [];
    this._headerLength = 0;
    this._scannedUpTo = 0;
    this._detectedSig = null;
  }

  _flushBuffered(startOffset = 0, sigName = null) {
    this._decided = true;
    const merged =
      this._headerChunks.length === 1
        ? this._headerChunks[0]
        : Buffer.concat(this._headerChunks, this._headerLength);
    this._headerChunks = [];
    this._headerLength = 0;

    if (this.onUnwrapped) {
      this.onUnwrapped({ strippedBytes: startOffset, signature: sigName });
    }
    if (startOffset < merged.length) {
      this.push(startOffset > 0 ? merged.subarray(startOffset) : merged);
    }
  }

  _transform(chunk, _encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this._decided) {
      this.push(buf);
      callback();
      return;
    }

    this._headerChunks.push(buf);
    this._headerLength += buf.length;

    if (this._headerLength < 4) {
      callback();
      return;
    }

    const merged =
      this._headerChunks.length === 1
        ? this._headerChunks[0]
        : Buffer.concat(this._headerChunks, this._headerLength);
    this._headerChunks = [merged];

    if (this._detectedSig === null && !this.forceScan) {
      this._detectedSig = detectSpoofedImageSignature(merged);
      if (!this._detectedSig) {
        // Not a disguised image segment — flush immediately without buffering further
        this._flushBuffered(0, null);
        callback();
        return;
      }
    }

    const offset = findTsSyncOffset(merged, this._scannedUpTo);
    if (offset >= 0) {
      this._flushBuffered(offset, this._detectedSig ? this._detectedSig.name : 'RAW_OFFSET');
      callback();
      return;
    }

    // Advance scan cursor safely without missing cross-chunk sync patterns
    this._scannedUpTo = Math.max(0, merged.length - TS_PACKET_SIZE * 2);

    if (this._headerLength >= TS_SCAN_WINDOW) {
      // Exceeded 64 KiB scan window without sync -> pass through unchanged
      this._flushBuffered(0, this._detectedSig ? this._detectedSig.name : null);
    }
    callback();
  }

  _flush(callback) {
    if (!this._decided && this._headerLength > 0) {
      const merged =
        this._headerChunks.length === 1
          ? this._headerChunks[0]
          : Buffer.concat(this._headerChunks, this._headerLength);
      this._headerChunks = [merged];
      const offset =
        this._detectedSig || this.forceScan ? findTsSyncOffset(merged, 0) : -1;
      this._flushBuffered(
        offset > 0 ? offset : 0,
        this._detectedSig ? this._detectedSig.name : null
      );
    }
    callback();
  }
}

export function createTsUnwrapperTransform(options) {
  return new TsUnwrapperTransform(options);
}
