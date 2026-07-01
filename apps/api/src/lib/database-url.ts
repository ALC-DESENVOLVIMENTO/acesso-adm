export function resolveDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.DATABASE_PRIVATE_URL
  );
}

export function withDatabaseSchema(databaseUrl?: string) {
  if (!databaseUrl) {
    return undefined;
  }

  const schema = process.env.DB_SCHEMA || "portal_administrativo";
  const parsed = new URL(databaseUrl);

  if (!parsed.searchParams.get("schema")) {
    parsed.searchParams.set("schema", schema);
  }

  return parsed.toString();
}

export function resolveDatabaseUrlWithSchema() {
  return withDatabaseSchema(resolveDatabaseUrl());
}
