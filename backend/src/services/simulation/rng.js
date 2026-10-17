/**
 * Seedable PRNG (sfc32) + standard normal generator.
 * Fast, small state, good statistical quality for Monte Carlo work.
 */

/**
 * Hash an arbitrary seed (number or string) into four 32-bit state words.
 */
function seedState(seed) {
  const str = String(seed);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const next = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  return [next(), next(), next(), next()];
}

export function createRng(seed = 1) {
  let [a, b, c, d] = seedState(seed);
  let spare = 0;
  let hasSpare = false;

  /** Uniform in [0, 1) */
  function uniform() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Standard normal via Box-Muller (polar form avoided for deterministic draw count per pair) */
  function normal() {
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }
    let u = uniform();
    while (u <= 1e-12) u = uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    spare = r * Math.sin(theta);
    hasSpare = true;
    return r * Math.cos(theta);
  }

  /** Fill a typed array with standard normals */
  function fillNormal(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = normal();
    return arr;
  }

  // Burn-in to decorrelate from the seed hash
  for (let i = 0; i < 15; i++) uniform();

  return { uniform, normal, fillNormal };
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}
