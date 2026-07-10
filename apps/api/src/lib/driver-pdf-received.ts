import { DocumentTypeCode, DriverPdfReceivedStatus } from "@prisma/client";
import { prisma } from "./prisma.js";

export type DriverPdfReceivedUploadInput = {
  uploadPdfId: string;
  motoristaId: string;
  periodId: string;
  basePaymentId: string;
  fileName: string;
  storageKey: string;
  mimeType?: string | null;
  createdByUserId?: string | null;
  documentType?: DocumentTypeCode | null;
};

export type DriverPdfReceivedRejectionInput = {
  uploadPdfId?: string | null;
  motoristaId?: string | null;
  periodId?: string | null;
  basePaymentId?: string | null;
  fileName?: string | null;
  storageKey?: string | null;
  mimeType?: string | null;
  motivoRejeicao?: string | null;
  observacoes?: string | null;
  rejectedById?: string | null;
  rejectedAt?: Date | null;
  documentType?: DocumentTypeCode | null;
};

function buildReceivedWhere(input: {
  uploadPdfId?: string | null;
  motoristaId?: string | null;
  periodId?: string | null;
  basePaymentId?: string | null;
  documentType?: DocumentTypeCode | null;
}) {
  if (input.uploadPdfId) {
    return {
      uploadPdfId: input.uploadPdfId,
      ...(input.documentType ? { documentType: input.documentType } : {})
    };
  }

  if (input.motoristaId && input.periodId && input.basePaymentId) {
    return {
      motoristaId: input.motoristaId,
      periodoPagamentoId: input.periodId,
      basePagamentoId: input.basePaymentId,
      ...(input.documentType ? { documentType: input.documentType } : {})
    };
  }

  return null;
}

export async function upsertDriverPdfReceivedFromUpload(
  input: DriverPdfReceivedUploadInput,
  status: DriverPdfReceivedStatus = DriverPdfReceivedStatus.pdf_enviado_ao_motorista
) {
  const now = new Date();
  const existing = await prisma.driverPdfReceived.findFirst({
    where: buildReceivedWhere({
      uploadPdfId: input.uploadPdfId,
      motoristaId: input.motoristaId,
      periodId: input.periodId,
      basePaymentId: input.basePaymentId,
      documentType: input.documentType ?? null
    }) || {
      motoristaId: input.motoristaId,
      periodoPagamentoId: input.periodId,
      basePagamentoId: input.basePaymentId
    },
    select: {
      id: true
    }
  });

  const data = {
    motoristaId: input.motoristaId,
    periodoPagamentoId: input.periodId,
    basePagamentoId: input.basePaymentId,
    nomeArquivo: input.fileName,
    caminhoArquivo: input.storageKey,
    documentType: input.documentType ?? null,
    tipoArquivo: input.mimeType || "application/pdf",
    uploadEm: now,
    usuarioId: input.createdByUserId ?? null,
    status,
    observacoes: null,
    visualizadoEm: null,
    enviadoAoMotoristaEm:
      status === DriverPdfReceivedStatus.pdf_enviado_ao_motorista ? now : null,
    aprovadoEm: null,
    aprovadoPorId: null,
    rejeitadoEm: null,
    rejeitadoPorId: null,
    motivoRejeicao: null,
    uploadPdfId: input.uploadPdfId
  } as const;

  if (existing?.id) {
    return prisma.driverPdfReceived.update({
      where: {
        id: existing.id
      },
      data
    });
  }

  return prisma.driverPdfReceived.create({
    data
  });
}

export async function markDriverPdfReceivedRejected(input: DriverPdfReceivedRejectionInput) {
  const now = input.rejectedAt || new Date();
  const where = buildReceivedWhere(input);

  if (where) {
    const existing = await prisma.driverPdfReceived.findFirst({
      where,
      select: {
        id: true
      }
    });

    if (existing?.id) {
      return prisma.driverPdfReceived.update({
        where: {
          id: existing.id
        },
        data: {
          status: DriverPdfReceivedStatus.nota_fiscal_rejeitada,
          rejeitadoEm: now,
          rejeitadoPorId: input.rejectedById ?? null,
          motivoRejeicao: input.motivoRejeicao ?? null,
          observacoes: input.observacoes ?? null
        }
      });
    }
  }

  if (!input.motoristaId || !input.periodId || !input.basePaymentId) {
    return null;
  }

  return prisma.driverPdfReceived.create({
    data: {
      motoristaId: input.motoristaId,
      periodoPagamentoId: input.periodId,
      basePagamentoId: input.basePaymentId,
      nomeArquivo: input.fileName ?? null,
      caminhoArquivo: input.storageKey ?? null,
      documentType: input.documentType ?? null,
      tipoArquivo: input.mimeType ?? "application/pdf",
      uploadEm: now,
      usuarioId: input.rejectedById ?? null,
      status: DriverPdfReceivedStatus.nota_fiscal_rejeitada,
      observacoes: input.observacoes ?? null,
      rejeitadoEm: now,
      rejeitadoPorId: input.rejectedById ?? null,
      motivoRejeicao: input.motivoRejeicao ?? null
    }
  });
}
