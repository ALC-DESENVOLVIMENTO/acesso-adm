import { hasObjectStorage, normalizeStorageKey } from "./storage.js";
import { prisma } from "./prisma.js";

type MigrationRecord = {
  id: string;
  path: string | null;
  setPath: (path: string) => Promise<void>;
};

type UploadPdfRow = {
  id: string;
  caminhoArquivo: string;
};

type AnexoChamadoRow = {
  id: string;
  caminhoArquivo: string;
};

type UsuarioRow = {
  id: string;
  fotoPerfil: string | null;
};

type DriverPdfReceivedRow = {
  id: string;
  caminhoArquivo: string | null;
};

function extractStorageKey(rawValue: string | null | undefined) {
  if (!rawValue) {
    return null;
  }

  const trimmed = String(rawValue).trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const pathWithSlash = url.pathname;
      if (pathWithSlash.startsWith("/api/storage/")) {
        return pathWithSlash.slice("/api/storage/".length);
      }
      if (pathWithSlash.startsWith("/storage/")) {
        return pathWithSlash.slice("/storage/".length);
      }
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("/api/storage/")) {
    return trimmed.slice("/api/storage/".length);
  }

  if (trimmed.startsWith("/storage/")) {
    return trimmed.slice("/storage/".length);
  }

  if (trimmed.startsWith("storage/")) {
    return trimmed.slice("storage/".length);
  }

  return trimmed;
}

function toStoragePath(raw: string | null | undefined) {
  const extracted = extractStorageKey(raw);
  return normalizeStorageKey(extracted);
}

async function syncRecord(record: MigrationRecord) {
  const targetPath = toStoragePath(record.path);

  if (!targetPath) {
    return;
  }

  if (record.path !== targetPath) {
    await record.setPath(targetPath);
  }
}

async function runMigration(records: MigrationRecord[]) {
  for (const record of records) {
    await syncRecord(record).catch(() => null);
  }
}

export async function reconcileStorageReferences() {
  if (!hasObjectStorage()) {
    return;
  }

  const uploadPdfRows = await prisma.uploadPdf.findMany({
    select: {
      id: true,
      caminhoArquivo: true
    }
  });

  const anexoRows = await prisma.anexoChamado.findMany({
    select: {
      id: true,
      caminhoArquivo: true
    }
  });

  const userRows = await prisma.usuario.findMany({
    select: {
      id: true,
      fotoPerfil: true
    }
  });

  const driverRows = await prisma.driverPdfReceived.findMany({
    select: {
      id: true,
      caminhoArquivo: true
    }
  });

  const uploadRows = uploadPdfRows
    .map((row: UploadPdfRow) => ({
      id: row.id,
      path: row.caminhoArquivo,
      setPath: async (nextPath: string) => {
        await prisma.uploadPdf.update({
          where: { id: row.id },
          data: { caminhoArquivo: nextPath }
        });
      }
    }));

  const attachmentRows = anexoRows.map((row: AnexoChamadoRow) => ({
    id: row.id,
    path: row.caminhoArquivo,
    setPath: async (nextPath: string) => {
      await prisma.anexoChamado.update({
        where: { id: row.id },
        data: { caminhoArquivo: nextPath }
      });
    }
  }));

  const userPhotoRows = userRows.map((row: UsuarioRow) => ({
    id: row.id,
    path: row.fotoPerfil,
    setPath: async (nextPath: string) => {
      await prisma.usuario.update({
        where: { id: row.id },
        data: { fotoPerfil: nextPath }
      });
    }
  }));

  const driverRecords = driverRows
    .map((row) => {
      return {
        id: row.id,
        path: row.caminhoArquivo,
        setPath: async (nextPath: string) => {
          await prisma.driverPdfReceived.update({
            where: { id: row.id },
            data: { caminhoArquivo: nextPath }
          });
        }
      };
    })
    .filter((record) => Boolean(record.path)) as MigrationRecord[];

  await runMigration(uploadRows);
  await runMigration(attachmentRows);
  await runMigration(userPhotoRows);
  await runMigration(driverRecords);
}
