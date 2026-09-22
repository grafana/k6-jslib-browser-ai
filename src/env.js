// k6 has no built-in .env support, and open() only works during init (never
// inside the default function), so a best-effort dotenv read has to happen
// here, at module load time, rather than lazily when a key is looked up.
function loadDotEnv(path) {
  try {
    const raw = open(path);
    const vars = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
    return vars;
  } catch (err) {
    return {};
  }
}

// Relative to this file (src/env.js), so ../.env is the project root .env.
const DOTENV = loadDotEnv('../.env');

// First matching, non-empty value across k6 -e/--env flags and .env, trying
// each candidate name in order (covers naming variants like API_KEY vs TOKEN).
export function readEnv(...names) {
  for (const name of names) {
    if (__ENV[name]) return __ENV[name];
  }
  for (const name of names) {
    if (DOTENV[name]) return DOTENV[name];
  }
  return undefined;
}
