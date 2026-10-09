import { sha256Hex } from "./hash.ts";
import type { Outcome } from "./state-machine.ts";

/**
 * A content-free verdict record ("verdict/1"): what a stranger may learn about a final
 * decision, and nothing that identifies the transaction. It is sealed into the ledger as its
 * own entry, so it sits in the anchored Merkle tree and appears in the public /verdicts.json
 * feed. It never hashes identifying content: the subject is a salted digest of the agreement
 * id (the salt goes only to the parties), and time is reduced to the day.
 */
export const VERDICT_SCHEME = "verdict/1";

export interface VerdictRecord {
  v: typeof VERDICT_SCHEME;
  kind: "verdict";
  /** sha256(salt ":" agreement_id), hex. Only someone holding the salt can link it. */
  subject: string;
  outcome: { kind: "release" | "refund" | "partial"; release_percent?: number };
  decided_by: "auto" | "human";
  /** UTC day the decision became final (YYYY-MM-DD). */
  final_on: string;
}

export function verdictSubject(saltHex: string, agreementId: string): string {
  return sha256Hex(`${saltHex}:${agreementId}`);
}

export function buildVerdictRecord(p: {
  saltHex: string;
  agreementId: string;
  outcome: Outcome;
  decidedBy: "auto" | "human";
  finalAt: Date;
}): VerdictRecord {
  return {
    v: VERDICT_SCHEME,
    kind: "verdict",
    subject: verdictSubject(p.saltHex, p.agreementId),
    outcome:
      p.outcome.kind === "partial"
        ? { kind: "partial", release_percent: p.outcome.releasePercent }
        : { kind: p.outcome.kind },
    decided_by: p.decidedBy,
    final_on: p.finalAt.toISOString().slice(0, 10),
  };
}
