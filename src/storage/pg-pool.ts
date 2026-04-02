import postgres from "postgres";

export interface PgPoolConfig {
  max?: number;
  connect_timeout?: number;
  idle_timeout?: number;
  max_lifetime?: number;
  statement_timeout?: number;
}

const DEFAULT_CONFIG = {
  max: 10,
  connect_timeout: 30,
  idle_timeout: 300,
  max_lifetime: 3600,
};

export function createPgPool(
  url: string,
  config: PgPoolConfig = {},
): postgres.Sql {
  const merged = { ...DEFAULT_CONFIG, ...config };

  const options: postgres.Options<{}> = {
    max: merged.max,
    connect_timeout: merged.connect_timeout,
    idle_timeout: merged.idle_timeout,
    max_lifetime: merged.max_lifetime,
    onnotice(notice: postgres.Notice) {
      const code = (notice as Record<string, unknown>).code as string | undefined;
      if (code === "42P07" || code === "42710") return;
      console.warn("[pg notice]", notice);
    },
  };

  if (merged.statement_timeout !== undefined) {
    (options as Record<string, unknown>).connection = {
      statement_timeout: String(merged.statement_timeout),
    };
  }

  return postgres(url, options);
}

export function createAppPgPool(config: PgPoolConfig = {}): postgres.Sql {
  const url = process.env.PG_APP_URL;
  if (!url) {
    throw new Error("PG_APP_URL environment variable is not set");
  }
  return createPgPool(url, config);
}

export function createAppTestPgPool(config: PgPoolConfig = {}): postgres.Sql {
  const url = process.env.PG_APP_TEST_URL;
  if (!url) {
    throw new Error("PG_APP_TEST_URL environment variable is not set");
  }
  return createPgPool(url, config);
}
