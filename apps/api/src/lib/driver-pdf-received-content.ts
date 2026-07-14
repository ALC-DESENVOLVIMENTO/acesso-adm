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
      documentType: true,
      status: true,
      caminhoArquivo: true,
      content: true,
      uploadPdfId: true
    }
  });

  if (!received) {
    return null;
  }

  const isNoteStatus = Boolean(
    received.status &&
      [
        "nota_fiscal_recebida",
        "nota_fiscal_em_analise",
        "nota_fiscal_aprovada",
        "nota_fiscal_rejeitada",
        "processo_concluido"
      ].includes(received.status)
  );

  if (received.documentType !== "nota_fiscal" && !isNoteStatus) {
    return null;
  }

  if (received.content && received.content.length > 0) {
    return Buffer.from(received.content);
  }

  const sourceKey = normalizeStorageKey(received.caminhoArquivo || null);

  if (!sourceKey) {
    return null;
  }

  const remoteObject = await fetchObjectBuffer(sourceKey).catch(() => null);
  return remoteObject?.body || null;
}
