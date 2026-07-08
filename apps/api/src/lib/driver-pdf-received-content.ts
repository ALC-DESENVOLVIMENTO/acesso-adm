import { prisma } from "./prisma.js";
import { fetchObjectBuffer, normalizeStorageKey } from "./storage.js";

export async function loadDriverPdfReceivedContent(
  driverPdfReceivedId: string
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

  const sourceKey = normalizeStorageKey(received.caminhoArquivo || null);

  if (!sourceKey) {
    return null;
  }

  const remoteObject = await fetchObjectBuffer(sourceKey).catch(() => null);
  return remoteObject?.body || null;
}
