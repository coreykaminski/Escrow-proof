import { describe, expect, it } from "vitest";
import { checkGlossary, isGlossaryFile, parseGlossary } from "../src/translation/glossary.ts";

const glossary = parseGlossary(
  [
    "source,target,note",
    "Agreement,Contrato,",
    "Licensor,Licenciante|Cedente,either is fine",
    "Confidential Information,Información Confidencial,",
    '"Service Level, Uptime",Nivel de Servicio,quoted term with a comma',
  ].join("\n"),
);

describe("glossary", () => {
  it("parses source/target columns, alternatives and quoted cells", () => {
    expect(glossary).toEqual([
      { source: "Agreement", targets: ["Contrato"] },
      { source: "Licensor", targets: ["Licenciante", "Cedente"] },
      { source: "Confidential Information", targets: ["Información Confidencial"] },
      { source: "Service Level, Uptime", targets: ["Nivel de Servicio"] },
    ]);
    expect(isGlossaryFile({ name: "glossary.csv" })).toBe(true);
    expect(isGlossaryFile({ name: "inputs/legal_glossary_v2.csv" })).toBe(true);
    expect(isGlossaryFile({ name: "contract_en.txt" })).toBe(false);
  });

  it("accepts the approved term, inflected forms, alternatives and any case", () => {
    const src = "This Agreement binds the Licensor. Confidential Information stays confidential.";
    const tgt =
      "Los contratos obligan al CEDENTE. La información confidencial sigue siendo confidencial.";
    expect(checkGlossary(src, tgt, glossary)).toEqual([]);
  });

  it("flags a source term whose approved translation never appears", () => {
    const src = "This Agreement binds the Licensor.";
    const tgt = "Este Acuerdo obliga al Licenciante.";
    const findings = checkGlossary(src, tgt, glossary);
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "glossary_violation",
        confidence: "high",
        severity: "major",
      }),
    ]);
    expect(findings[0]?.message).toContain('"Agreement"');
    expect(findings[0]?.message).toContain('"Contrato"');
  });

  it("ignores terms the source doesn't use, and doesn't match inside other words", () => {
    expect(checkGlossary("A short note.", "Una nota breve.", glossary)).toEqual([]);
    // "Agreements" isn't the term "Agreement"… but "Agreement" inside "Disagreement" isn't either.
    expect(checkGlossary("A Disagreement arose.", "Surgió un desacuerdo.", glossary)).toEqual([]);
    // An approved term doesn't count when it's only a prefix of a longer, different word.
    const f = checkGlossary("The Agreement.", "El Contratiempo.", glossary);
    expect(f).toHaveLength(1);
  });
});
