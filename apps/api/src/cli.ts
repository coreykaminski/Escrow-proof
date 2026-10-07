import { parseArgs } from "node:util";
import { lintSpec, VERTICALS, type Vertical } from "@proofdesk/core";
import { createDb, type DbHandle, verifyLedger } from "@proofdesk/db";
import { SpecDraftError, type SpecDrafter } from "@proofdesk/spec-engine";
import { createAccountWithKey } from "./accounts.ts";
import { loadEnv } from "./load-env.ts";
import { drafterFromEnv, paymentsFromEnv } from "./models.ts";
import { tick } from "./services/scheduler.ts";

const USAGE = `Usage: npm run cli -- <command> [options]

Commands:
  migrate                                  Apply database migrations
  create-account --name <name> [--ops] [--live]
                                           Create an account + API key (printed once)
  verify-ledger                            Verify the full ledger hash chain
  run-due                                  Scheduler tick: capture expiring holds, refund
                                           missed deadlines, settle due agreements, deliver
                                           webhooks (run it from cron every minute)
  draft-spec --request <text> [--vertical translation|code|data|general]
                                           Draft criteria for a request (calls Claude)

Environment (also read from ./.env):
  DATABASE_URL        default "pglite:./.data/dev"
  ANTHROPIC_API_KEY   needed by draft-spec
  SPEC_DRAFT_MODEL    default "claude-opus-5-5"
  STRIPE_SECRET_KEY   needed by run-due for card holds`;

async function main() {
  loadEnv();
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      ops: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      request: { type: "string" },
      vertical: { type: "string" },
    },
  });

  const command = positionals[0];
  if (!command) {
    console.log(USAGE);
    return 1;
  }
  if (command === "draft-spec") return draftSpec(values);

  const handle = createDb(process.env.DATABASE_URL ?? "pglite:./.data/dev");
  try {
    await handle.migrate();
    return await run(command, handle, values);
  } finally {
    await handle.close();
  }
}

async function run(
  command: string,
  { db }: DbHandle,
  values: { name?: string; ops: boolean; live: boolean },
): Promise<number> {
  switch (command) {
    case "migrate":
      console.log("Migrations applied.");
      return 0;

    case "create-account": {
      if (!values.name) {
        console.error("--name is required");
        return 1;
      }
      const result = await createAccountWithKey(db, {
        name: values.name,
        mode: values.live ? "live" : "test",
        scopes: values.ops ? ["platform", "ops"] : ["platform"],
      });
      console.log(`Account:  ${result.accountId}`);
      console.log(`Scopes:   ${result.scopes.join(", ")} (${result.mode} mode)`);
      console.log(`API key:  ${result.apiKey}`);
      console.log("Store this key now; it can't be shown again.");
      return 0;
    }

    case "run-due": {
      const payments = paymentsFromEnv();
      const result = await tick(db, payments ? { payments } : {}, new Date());
      console.log(JSON.stringify(result, null, 2));
      return result.errors.length ? 2 : 0;
    }

    case "verify-ledger": {
      const result = await verifyLedger(db);
      if (result.ok) {
        console.log(
          `Ledger OK: ${result.count} entries, head ${result.headSeq} ${result.headHash}`,
        );
        return 0;
      }
      console.error(`LEDGER BROKEN at seq ${result.seq}: ${result.reason}`);
      return 2;
    }

    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

/** No database needed: drafts and prints the criteria, open questions and lint warnings. */
async function draftSpec(values: { request?: string; vertical?: string }): Promise<number> {
  if (!values.request) {
    console.error("--request is required");
    return 1;
  }
  if (values.vertical && !(VERTICALS as readonly string[]).includes(values.vertical)) {
    console.error(`--vertical must be one of: ${VERTICALS.join(", ")}`);
    return 1;
  }
  const drafter = drafterFromEnv();
  if (!drafter) {
    console.error("ANTHROPIC_API_KEY is not set (in the environment or ./.env)");
    return 1;
  }
  let result: Awaited<ReturnType<SpecDrafter["draft"]>>;
  try {
    result = await drafter.draft({
      request: values.request,
      vertical: values.vertical as Vertical | undefined,
    });
  } catch (err) {
    if (!(err instanceof SpecDraftError)) throw err;
    const cause = err.cause instanceof Error ? `\n  ${err.cause.message}` : "";
    console.error(`Drafting failed [${err.code}]: ${err.message}${cause}`);
    return 2;
  }
  const { output, meta } = result;
  console.log(JSON.stringify(output, null, 2));
  const warnings = lintSpec({
    criteria: output.criteria.map((c) => ({ ...c, verification: c.verification || undefined })),
  });
  console.log(`\nLint: ${warnings.length === 0 ? "no warnings" : ""}`);
  for (const w of warnings) console.log(`  [${w.code}] ${w.criterion_id ?? "spec"}: ${w.message}`);
  console.log(
    `\n${meta.model} · ${meta.prompt_version} · ${meta.input_tokens} in / ${meta.output_tokens} out tokens`,
  );
  return 0;
}

process.exitCode = await main();
