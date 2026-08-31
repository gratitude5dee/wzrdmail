const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generate a ULID (Crockford base32, 48-bit time + 80-bit randomness). */
export function ulid(now: number = Date.now()): string {
  let time = now;
  const chars = new Array<string>(26);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  for (let i = 0; i < 16; i++) {
    chars[10 + i] = CROCKFORD[rand[i]! % 32]!;
  }
  return chars.join("");
}

export type IdPrefix =
  | "org"
  | "user"
  | "key"
  | "pod"
  | "dom"
  | "thread"
  | "msg"
  | "att"
  | "lst"
  | "wh"
  | "whd"
  | "evt"
  | "draft";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

const ID_RE = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: string, prefix?: IdPrefix): boolean {
  if (!ID_RE.test(value)) return false;
  return prefix ? value.startsWith(`${prefix}_`) : true;
}
