import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDriverPdfReceivedContent } from "./lib/driver-pdf-received-content.js";
import { ensureDriverRegistryColumns } from "./lib/driver-registry-schema.js";
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

  await runCommand("npx", ["prisma", "db", "push"], apiRoot);
  await ensureDriverRegistryColumns();
  await ensureDriverPdfReceivedContent();
  await runCommand("npm", ["run", "db:seed"], apiRoot);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
