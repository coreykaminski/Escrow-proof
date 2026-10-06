import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv.ts";

describe("csv", () => {
  it("round-trips quotes, commas, newlines and empty fields", () => {
    const rows = [
      ["request_id", "description", "testable"],
      ["tr-01", 'Uses "usted", never "tú", in every clause', ""],
      ["cd-02", "Line one\nline two, with comma", "y"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("reads a file edited in a spreadsheet (no trailing newline)", () => {
    expect(parseCsv("a,b\r\n1,y")).toEqual([
      ["a", "b"],
      ["1", "y"],
    ]);
  });
});
