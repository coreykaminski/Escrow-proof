/** Loads ./.env if present. Variables already set in the environment win. */
export function loadEnv(path = ".env") {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
