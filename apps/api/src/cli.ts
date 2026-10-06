import { parseArgs } from "node:util";
import { createDb, type DbHandle, verifyLedger } from "@proofdesk/db";
import { createAccountWithKey } from "./accounts.ts";

const USAGE = `Usage: npm run cli -- <command> [options]

Commands:
  migrate                                  Apply database migrations
  create-account --name <name> [--ops] [--live]
                                           Create an account + API key (printed once)
  verify-ledger                            Verify the full ledger hash chain

Environment:
  DATABASE_URL   default "pglite:./.data/dev"`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      ops: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  if (!command) {
    console.log(USAGE);
    return 1;
  }

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

process.exitCode = await main();
