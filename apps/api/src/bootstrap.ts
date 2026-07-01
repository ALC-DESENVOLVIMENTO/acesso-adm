import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withDatabaseSchema } from "./lib/database-url.js";

function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        DATABASE_URL: withDatabaseSchema(process.env.DATABASE_URL)
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
  await runCommand("npm", ["run", "db:seed"], apiRoot);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

