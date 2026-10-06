/**
 * Scores a human-rated review.csv from `npm run eval:spec`.
 *
 *   npm run eval:spec:score -- evals/spec-engine/runs/<timestamp>/review.csv
 *
 * `testable` = y when a verifier could decide the criterion pass/fail from the deliverable
 * (plus source material) without guessing what the buyer meant; n otherwise.
 * Part 2 passes at ≥90% testable overall.
 */
import { readFileSync } from "node:fs";
import { parseCsv } from "./csv.ts";

const TARGET = 0.9;

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run eval:spec:score -- <review.csv>");
  process.exit(1);
}

const [header, ...rows] = parseCsv(readFileSync(path, "utf8"));
const col = (name: string) => {
  const i = header?.indexOf(name) ?? -1;
  if (i < 0) throw new Error(`review.csv has no "${name}" column`);
  return i;
};
const [idCol, testableCol] = [col("request_id"), col("testable")];

const verticalOf = (requestId: string) =>
  ({ tr: "translation", cd: "code", dt: "data", gn: "general" })[requestId.slice(0, 2)] ?? "other";

const tally = new Map<string, { yes: number; rated: number }>();
let unrated = 0;
for (const row of rows) {
  const answer = (row[testableCol] ?? "").trim().toLowerCase();
  if (!answer) {
    unrated++;
    continue;
  }
  if (!["y", "yes", "n", "no"].includes(answer)) {
    throw new Error(`unexpected testable value "${answer}" (use y or n)`);
  }
  for (const key of ["all", verticalOf(row[idCol] ?? "")]) {
    const t = tally.get(key) ?? { yes: 0, rated: 0 };
    t.rated++;
    if (answer.startsWith("y")) t.yes++;
    tally.set(key, t);
  }
}

const all = tally.get("all");
if (!all) {
  console.error(`No ratings yet: fill the "testable" column (y/n) in ${path}`);
  process.exit(1);
}
for (const [key, t] of tally) {
  console.log(
    `${key.padEnd(12)} ${((100 * t.yes) / t.rated).toFixed(1)}% testable (${t.yes}/${t.rated})`,
  );
}
if (unrated) console.log(`(${unrated} criteria not rated yet)`);
const pass = all.yes / all.rated >= TARGET;
console.log(pass ? `PASS: ≥${TARGET * 100}% testable` : `FAIL: below ${TARGET * 100}% testable`);
process.exitCode = pass && unrated === 0 ? 0 : 1;
