import crypto from 'node:crypto';

export const newServerSeed = () => crypto.randomBytes(32).toString('hex');
export const hash          = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Deterministic [0,1) float from (server_seed, client_seed, nonce)
export function rngFloat(serverSeed, clientSeed, nonce) {
  const h = crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest();
  // first 6 bytes -> 48-bit int -> [0,1)
  let v = 0;
  for (let i = 0; i < 6; i++) v = v * 256 + h[i];
  return v / 2 ** 48;
}

export const rngInt = (serverSeed, clientSeed, nonce, n) =>
  Math.floor(rngFloat(serverSeed, clientSeed, nonce) * n);
