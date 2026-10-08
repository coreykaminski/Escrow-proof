/**
 * Code golden set, part 1: ten small, well-specified tasks. Each has a correct reference
 * solution, a one-line bug, public test cases (shown to the seller) and held-out cases (the
 * buyer keeps them back, so code that only memorizes the public cases fails).
 */

export interface CodeTask {
  id: string;
  title: string;
  request: string;
  /** The exported function under test. */
  fn: string;
  /** Correct solution, an ES module exporting `fn`. */
  reference: string;
  /** [from, to]: a plausible one-line bug applied to the reference. */
  bug: [string, string];
  /** [args, expected] */
  publicCases: [unknown[], unknown][];
  hiddenCases: [unknown[], unknown][];
}

export const TASKS: CodeTask[] = [
  {
    id: "slugify",
    title: "slugify(text)",
    request:
      "Write slugify(text): lowercase, strip accents, replace runs of non-alphanumerics with a single hyphen, trim hyphens from both ends.",
    fn: "slugify",
    reference: `export function slugify(text) {
  return text
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`,
    bug: ['.replace(/^-+|-+$/g, "")', '.replace(/^-+/g, "")'],
    publicCases: [
      [["Hello World"], "hello-world"],
      [["  Café au lait!  "], "cafe-au-lait"],
      [["already-a-slug"], "already-a-slug"],
    ],
    hiddenCases: [
      [["Ünïcödé -- Test"], "unicode-test"],
      [["a___b"], "a-b"],
      [["Trailing!!!"], "trailing"],
      [[""], ""],
    ],
  },
  {
    id: "parse-duration",
    title: "parseDuration(text)",
    request:
      'Write parseDuration(text) that turns strings like "1h30m", "45s", "2h" or "1h2m3s" into a number of seconds. Return null for anything else.',
    fn: "parseDuration",
    reference: `export function parseDuration(text) {
  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(text);
  if (!m || text === "") return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
`,
    bug: ["Number(m[2] ?? 0) * 60", "Number(m[2] ?? 0) * 100"],
    publicCases: [
      [["1h30m"], 5400],
      [["45s"], 45],
      [["2h"], 7200],
    ],
    hiddenCases: [
      [["1h2m3s"], 3723],
      [["10m"], 600],
      [["abc"], null],
      [[""], null],
    ],
  },
  {
    id: "luhn",
    title: "luhnValid(number)",
    request:
      "Write luhnValid(number): true if the digit string passes the Luhn checksum. Ignore spaces; anything with other non-digits, or fewer than 2 digits, is invalid.",
    fn: "luhnValid",
    reference: `export function luhnValid(number) {
  const s = number.replace(/ /g, "");
  if (!/^\\d{2,}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
`,
    bug: ["if (d > 9) d -= 9;", "if (d > 9) d -= 10;"],
    publicCases: [
      [["4539 3195 0343 6467"], true],
      [["8273 1232 7352 0569"], false],
      [["059"], true],
    ],
    hiddenCases: [
      [["79927398713"], true],
      [["79927398710"], false],
      [["0"], false],
      [["055-444-285"], false],
      [["4111 1111 1111 1111"], true],
    ],
  },
  {
    id: "roman",
    title: "fromRoman(numeral)",
    request:
      "Write fromRoman(numeral) converting an uppercase Roman numeral (I to MMMCMXCIX, subtractive notation) to an integer.",
    fn: "fromRoman",
    reference: `const V = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
export function fromRoman(numeral) {
  let total = 0;
  for (let i = 0; i < numeral.length; i++) {
    const cur = V[numeral[i]];
    const next = V[numeral[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}
`,
    bug: ["total += cur < next ? -cur : cur;", "total += cur <= next ? -cur : cur;"],
    publicCases: [
      [["III"], 3],
      [["IV"], 4],
      [["MCMXCIV"], 1994],
    ],
    hiddenCases: [
      [["LVIII"], 58],
      [["MMMCMXCIX"], 3999],
      [["XL"], 40],
      [["CDXLIV"], 444],
    ],
  },
  {
    id: "chunk",
    title: "chunk(items, size)",
    request:
      "Write chunk(items, size) splitting an array into consecutive arrays of length size (the last may be shorter). Throw a RangeError if size is not a positive integer.",
    fn: "chunk",
    reference: `export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
`,
    bug: ["out.push(items.slice(i, i + size))", "out.push(items.slice(i, i + size - 1))"],
    publicCases: [
      [
        [[1, 2, 3, 4, 5], 2],
        [[1, 2], [3, 4], [5]],
      ],
      [[[], 3], []],
      [[["a", "b"], 5], [["a", "b"]]],
    ],
    hiddenCases: [
      [
        [[1, 2, 3, 4, 5, 6], 3],
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
      ],
      [[[1], 1], [[1]]],
      [
        [[1, 2, 3], 1],
        [[1], [2], [3]],
      ],
    ],
  },
  {
    id: "semver",
    title: "compareSemver(a, b)",
    request:
      "Write compareSemver(a, b) for MAJOR.MINOR.PATCH versions (no pre-release tags): return -1, 0 or 1. Compare numerically, not as strings.",
    fn: "compareSemver",
    reference: `export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
`,
    bug: ["for (let i = 0; i < 3; i++) {", "for (let i = 0; i < 2; i++) {"],
    publicCases: [
      [["1.2.3", "1.2.3"], 0],
      [["1.10.0", "1.9.0"], 1],
      [["0.1.0", "1.0.0"], -1],
    ],
    hiddenCases: [
      [["2.0.0", "10.0.0"], -1],
      [["1.0.10", "1.0.9"], 1],
      [["1.0.1", "1.0.2"], -1],
      [["3.4.5", "3.4.5"], 0],
    ],
  },
  {
    id: "word-freq",
    title: "topWords(text, k)",
    request:
      "Write topWords(text, k): the k most frequent words (case-insensitive, letters and apostrophes only) as [word, count] pairs, most frequent first, ties broken alphabetically.",
    fn: "topWords",
    reference: `export function topWords(text, k) {
  const counts = new Map();
  for (const w of text.toLowerCase().match(/[a-z']+/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .slice(0, k);
}
`,
    bug: ["y[1] - x[1] ||", "x[1] - y[1] ||"],
    publicCases: [
      [["the cat and the hat", 1], [["the", 2]]],
      [
        ["b a b a c", 2],
        [
          ["a", 2],
          ["b", 2],
        ],
      ],
      [["", 3], []],
    ],
    hiddenCases: [
      [
        ["It's it's IT'S fine", 2],
        [
          ["it's", 3],
          ["fine", 1],
        ],
      ],
      [
        ["one two two three three three", 3],
        [
          ["three", 3],
          ["two", 2],
          ["one", 1],
        ],
      ],
      [
        ["x y z", 2],
        [
          ["x", 1],
          ["y", 1],
        ],
      ],
    ],
  },
  {
    id: "deep-merge",
    title: "deepMerge(a, b)",
    request:
      "Write deepMerge(a, b) returning a new object: plain objects merge recursively, anything else in b (arrays included) replaces the value in a. Don't mutate the inputs.",
    fn: "deepMerge",
    reference: `const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}
`,
    bug: [
      "isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v",
      "isObj(v) ? { ...out[k], ...v } : v",
    ],
    publicCases: [
      [[{ a: 1 }, { b: 2 }], { a: 1, b: 2 }],
      [[{ a: { x: 1 } }, { a: { y: 2 } }], { a: { x: 1, y: 2 } }],
      [[{ a: [1, 2] }, { a: [3] }], { a: [3] }],
    ],
    hiddenCases: [
      [[{ a: { b: { c: 1, d: 2 } } }, { a: { b: { d: 3 } } }], { a: { b: { c: 1, d: 3 } } }],
      [[{ a: 1 }, { a: { b: 1 } }], { a: { b: 1 } }],
      [[{}, {}], {}],
    ],
  },
  {
    id: "csv-line",
    title: "parseCsvLine(line)",
    request:
      'Write parseCsvLine(line) splitting one CSV line into fields: commas separate fields, double-quoted fields may contain commas, and "" inside quotes is a literal quote.',
    fn: "parseCsvLine",
    reference: `export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
`,
    bug: ['else if (ch === ",") {', 'else if (ch === "," && cur !== "") {'],
    publicCases: [
      [["a,b,c"], ["a", "b", "c"]],
      [['"x, y",z'], ["x, y", "z"]],
      [["a,,b"], ["a", "", "b"]],
    ],
    hiddenCases: [
      [['"say ""hi""",2'], ['say "hi"', "2"]],
      [[""], [""]],
      [['""'], [""]],
      [["1,2,"], ["1", "2", ""]],
    ],
  },
  {
    id: "iso-week",
    title: "isoWeek(dateString)",
    request:
      'Write isoWeek(dateString) returning the ISO-8601 week number (1-53) of a "YYYY-MM-DD" date (UTC).',
    fn: "isoWeek",
    reference: `export function isoWeek(dateString) {
  const d = new Date(dateString + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  return 1 + Math.round((d - firstThursday) / (7 * 86400000));
}
`,
    bug: ["const day = (d.getUTCDay() + 6) % 7;", "const day = d.getUTCDay();"],
    publicCases: [
      [["2026-01-01"], 1],
      [["2026-10-08"], 41],
      [["2024-12-30"], 1],
    ],
    hiddenCases: [
      [["2021-01-03"], 53],
      [["2026-12-31"], 53],
      [["2023-01-01"], 52],
      [["2025-06-15"], 24],
    ],
  },
];
