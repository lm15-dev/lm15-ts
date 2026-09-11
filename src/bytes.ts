/**
 * Bytes and text without `Buffer`: base64 (standard and URL-safe) and UTF-8
 * over `Uint8Array`, from the JavaScript language and the WHATWG encoding
 * globals every runtime has. The one codec every entry point shares, so a
 * media payload encodes to the same bytes in a page, a worker and Node.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENCODE: string[] = [...ALPHABET];
const DECODE = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;
DECODE["-".charCodeAt(0)] = 62; // URL-safe spellings decode too
DECODE["_".charCodeAt(0)] = 63;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/** Standard base64 with padding (RFC 4648 §4), the spelling every provider wire takes. */
export function base64Encode(bytes: Uint8Array | ArrayBuffer): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < data.length; i += 3) {
    const n = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    out.push(ENCODE[(n >> 18) & 63]!, ENCODE[(n >> 12) & 63]!, ENCODE[(n >> 6) & 63]!, ENCODE[n & 63]!);
  }
  if (i < data.length) {
    const n = (data[i]! << 16) | ((i + 1 < data.length ? data[i + 1]! : 0) << 8);
    out.push(ENCODE[(n >> 18) & 63]!, ENCODE[(n >> 12) & 63]!, i + 1 < data.length ? ENCODE[(n >> 6) & 63]! : "=", "=");
  }
  return out.join("");
}

/** URL-safe base64 without padding (RFC 4648 §5): JWT segments, PKCE challenges. */
export function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
  return base64Encode(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Decode standard or URL-safe base64; padding optional, whitespace rejected.
 * Throws a `TypeError` on any character outside the alphabet, on a dangling
 * single character, and on non-zero bits hidden under the padding (a strict
 * decoder: two encodings never name one payload).
 */
export function base64Decode(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61 /* = */) end--;
  if (end % 4 === 1) throw new TypeError("base64: a dangling character (length ≡ 1 mod 4)");
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    const v = code < 256 ? DECODE[code]! : -1;
    if (v < 0) throw new TypeError(`base64: invalid character at offset ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new TypeError("base64: non-zero padding bits");
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Lossy on malformed input (U+FFFD), like every provider body decoder here. */
export function utf8Decode(bytes: Uint8Array | ArrayBuffer): string {
  return utf8Decoder.decode(bytes);
}

/** Bytes equal, constant shape (not constant time: nothing here compares secrets). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
