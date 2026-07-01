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

