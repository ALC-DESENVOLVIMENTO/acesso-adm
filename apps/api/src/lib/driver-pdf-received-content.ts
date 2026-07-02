import { prisma } from "./prisma.js";
import { fetchObjectBuffer, normalizeStorageKey } from "./storage.js";

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
    const sourceKey = normalizeStorageKey(
      row.caminhoArquivo || (row.uploadPdfId ? uploadPathById.get(row.uploadPdfId) || null : null)
    );

    if (!sourceKey) {
      continue;
    }

    const remoteObject = await fetchObjectBuffer(sourceKey).catch(() => null);
    const content = remoteObject?.body;

    if (!content) {
      continue;
    }

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
