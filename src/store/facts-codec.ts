// Encoding of the fact blobs in `file_facts`: UTF-8 JSON. Native JSON.parse
// decodes these blobs about twice as fast as a JavaScript MessagePack decoder,
// and decoding is what every build that resolves references waits on.

const encoder = new TextEncoder();

/**
 * The result owns an exactly sized buffer (a small `Buffer` shares an 8 KiB
 * pool slab, which postMessage would copy whole).
 */
export function encodeFacts(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeFacts<T>(bytes: Uint8Array): T {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return JSON.parse(buffer.toString('utf8')) as T;
}
