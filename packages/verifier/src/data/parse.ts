export type DataFormat = "json" | "jsonl" | "csv" | "markdown";

export interface DataFile {
  name: string;
  media_type: string;
  content: string;
}

export function formatOf(f: Pick<DataFile, "name" | "media_type">): DataFormat {
  const n = f.name.toLowerCase();
  const m = f.media_type.toLowerCase();
  if (n.endsWith(".jsonl") || n.endsWith(".ndjson") || m.includes("ndjson") || m.includes("jsonl"))
    return "jsonl";
  if (n.endsWith(".json") || m.includes("json")) return "json";
  if (n.endsWith(".csv") || m.includes("csv")) return "csv";
  return "markdown";
}

/** RFC 4180 CSV with a header row → records of strings. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur === "") quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body.map((r, i) => {
    if (r.length !== names.length) {
      throw new Error(`row ${i + 2} has ${r.length} fields; the header has ${names.length}`);
    }
    return Object.fromEntries(names.map((n, j) => [n, r[j] ?? ""]));
  });
}

export function parseData(f: DataFile): unknown {
  switch (formatOf(f)) {
    case "json":
      return JSON.parse(f.content);
    case "jsonl":
      return f.content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l, i) => {
          try {
            return JSON.parse(l);
          } catch {
            throw new Error(`line ${i + 1} isn't valid JSON`);
          }
        });
    case "csv":
      return parseCsv(f.content);
    case "markdown":
      return f.content;
  }
}

/** Every string value in a parsed document (for injection scanning). */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}
