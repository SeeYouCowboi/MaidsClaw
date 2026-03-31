#!/usr/bin/env bun

import { isSqliteFreezeEnabled } from "../src/storage/backend-types.js";

const frozen = isSqliteFreezeEnabled();

console.log(
	frozen
		? "SQLite freeze status: frozen (MAIDSCLAW_SQLITE_FREEZE=true)"
		: "SQLite freeze status: not frozen (set MAIDSCLAW_SQLITE_FREEZE=true to enable)",
);

process.exit(frozen ? 0 : 1);
