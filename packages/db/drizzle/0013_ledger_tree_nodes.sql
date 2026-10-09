CREATE TABLE "ledger_tree_nodes" (
	"level" integer NOT NULL,
	"idx" bigint NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "ledger_tree_nodes_level_idx_pk" PRIMARY KEY("level","idx")
);
