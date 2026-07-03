import { prisma } from "./prisma.js";
import { fetchObjectBuffer, normalizeStorageKey } from "./storage.js";

export async function loadDriverPdfReceivedContent(
  driverPdfReceivedId: string,
  fallbackUploadId: string | null = null
) {
  const received = await prisma.driverPdfReceived.findUnique({
    where: {
      id: driverPdfReceivedId
    },
    select: {
      caminhoArquivo: true,
      uploadPdfId: true
    }
  });

  if (!received) {
    return null;
  }

  const upload = fallbackUploadId
    ? await prisma.uploadPdf.findUnique({
        where: {
          id: fallbackUploadId
        },
        select: {
          caminhoArquivo: true
        }
      })
    : received.uploadPdfId
      ? await prisma.uploadPdf.findUnique({
          where: {
            id: received.uploadPdfId
          },
          select: {
            caminhoArquivo: true
          }
        })
    : null;

  const sourceKey = normalizeStorageKey(
    received.caminhoArquivo || upload?.caminhoArquivo || null
  );

  if (!sourceKey) {
    return null;
  }

  const remoteObject = await fetchObjectBuffer(sourceKey).catch(() => null);
  return remoteObject?.body || null;
}
