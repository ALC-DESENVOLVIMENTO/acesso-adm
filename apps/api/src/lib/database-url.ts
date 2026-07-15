export function resolveDatabaseUrl() {
  const directUrl =
    process.env.DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.DATABASE_PRIVATE_URL;

  const publicUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_PRIVATE_URL;

  if (shouldPreferPublicDatabaseUrl(directUrl, publicUrl)) {
    return publicUrl;
  }

  if (directUrl) {
    return directUrl;
  }

  const host = process.env.PGHOST;
  const port = process.env.PGPORT || "5432";
  const database = process.env.PGDATABASE || process.env.POSTGRES_DB;
  const user = process.env.PGUSER || process.env.POSTGRES_USER;
  const password = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;

  if (host && database && user && password) {
    const encodedUser = encodeURIComponent(user);
    const encodedPassword = encodeURIComponent(password);
    return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${database}`;
  }

  return (
    process.env.DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.DATABASE_PRIVATE_URL
  );
}

function shouldPreferPublicDatabaseUrl(directUrl: string | undefined, publicUrl: string | undefined) {
  if (!publicUrl) {
    return false;
  }

  if (!directUrl) {
    return true;
  }

  if (process.env.NODE_ENV === "production") {
    return false;
  }

  try {
    const parsed = new URL(directUrl);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "postgres.railway.internal" || hostname.endsWith(".internal");
  } catch {
    return false;
  }
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
