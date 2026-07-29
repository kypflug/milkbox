/**
 * ULID — 26-char Crockford base32, lexically sortable by creation time.
 * 48-bit millisecond timestamp + 80 bits of randomness. Hand-rolled so the
 * app carries no dependency for 30 lines of encoding.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }

  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let random = '';
  // 10 bytes = 80 bits → 16 base32 chars (5 bits each)
  let bits = 0;
  let acc = 0;
  for (const byte of rand) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      random += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  return time + random;
}

/** Extract the millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < 10; i++) {
    t = t * 32 + ALPHABET.indexOf(id[i]);
  }
  return t;
}
