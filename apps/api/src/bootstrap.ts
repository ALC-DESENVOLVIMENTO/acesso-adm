import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFinanceiroCompatibilitySchema } from "./lib/financeiro-schema.js";
import { ensureDriverRegistryColumns } from "./lib/driver-registry-schema.js";
import { ensureDatabaseCompatibilityColumns } from "./lib/database-compatibility.js";
import { reconcileStorageReferences } from "./lib/storage-migration.js";
import { resolveDatabaseUrlWithSchema } from "./lib/database-url.js";

function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const databaseUrl = resolveDatabaseUrlWithSchema();

    if (!databaseUrl) {
      reject(
        new Error(
          "Nenhuma string de conexao foi encontrada. Defina DATABASE_URL, DATABASE_PUBLIC_URL ou DATABASE_PRIVATE_URL no Railway."
        )
      );
      return;
    }

    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl
      }
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Comando ${command} ${args.join(" ")} falhou com codigo ${code}`));
    });
  });
}

async function main() {
  const currentFile = fileURLToPath(import.meta.url);
  const apiRoot = path.resolve(path.dirname(currentFile), "..");

  await ensureDatabaseCompatibilityColumns();
  await ensureFinanceiroCompatibilitySchema();
  await ensureDriverRegistryColumns();
  await reconcileStorageReferences();
  await runCommand("npm", ["run", "db:seed"], apiRoot);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
