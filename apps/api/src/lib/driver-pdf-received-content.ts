import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { prisma } from "./prisma.js";

function resolveStoredFilePath(rawPath: string | null) {
  if (!rawPath) {
    return null;
  }

  const normalized = rawPath.replace(/^\/+/, "").replace(/^storage\//, "storage/");
  return path.resolve(process.cwd(), normalized);
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDriverPdfReceivedContent() {
  const pendingRows = await prisma.driverPdfReceived.findMany({
    where: {
      content: null
    },
    select: {
      id: true,
      caminhoArquivo: true,
      uploadPdfId: true
    }
  });

  if (pendingRows.length === 0) {
    return;
  }

  const uploadIds = pendingRows
    .map((row) => row.uploadPdfId)
    .filter((value): value is string => Boolean(value));

  const uploads = uploadIds.length
    ? await prisma.uploadPdf.findMany({
        where: {
          id: {
            in: uploadIds
          }
        },
        select: {
          id: true,
          caminhoArquivo: true
        }
      })
    : [];

  const uploadPathById = new Map(uploads.map((item) => [item.id, item.caminhoArquivo]));

  for (const row of pendingRows) {
    const sourcePath = row.caminhoArquivo || (row.uploadPdfId ? uploadPathById.get(row.uploadPdfId) || null : null);
    const resolvedPath = resolveStoredFilePath(sourcePath);

    if (!resolvedPath || !(await fileExists(resolvedPath))) {
      continue;
    }

    const content = await readFile(resolvedPath);

    await prisma.driverPdfReceived.update({
      where: {
        id: row.id
      },
      data: {
        content
      }
    });
  }
}
