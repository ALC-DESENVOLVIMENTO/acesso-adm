import { DocumentTypeCode, DriverPdfReceivedStatus, Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

const noteStatuses: DriverPdfReceivedStatus[] = [
  DriverPdfReceivedStatus.nota_fiscal_recebida,
  DriverPdfReceivedStatus.nota_fiscal_em_analise,
  DriverPdfReceivedStatus.nota_fiscal_aprovada,
  DriverPdfReceivedStatus.nota_fiscal_rejeitada,
  DriverPdfReceivedStatus.processo_concluido
];

function isNoteStatus(value: string | null | undefined) {
  return Boolean(value && noteStatuses.includes(value as DriverPdfReceivedStatus));
}

function isMirrorStatus(value: string | null | undefined) {
  const mirrorStatuses: DriverPdfReceivedStatus[] = [
    DriverPdfReceivedStatus.pdf_aguardando_envio,
    DriverPdfReceivedStatus.pdf_enviado_ao_motorista,
    DriverPdfReceivedStatus.motorista_visualizou,
    DriverPdfReceivedStatus.aguardando_envio_nota_fiscal
  ];

  return Boolean(
    value && mirrorStatuses.includes(value as DriverPdfReceivedStatus)
  );
}

export type DriverPdfReceivedUploadInput = {
  uploadPdfId: string;
  motoristaId: string;
  periodId: string;
  basePaymentId: string;
  fileName: string;
  storageKey: string;
  mimeType?: string | null;
  createdByUserId?: string | null;
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
};

function buildReceivedWhere(input: {
  uploadPdfId?: string | null;
  motoristaId?: string | null;
  periodId?: string | null;
  basePaymentId?: string | null;
  noteOnly?: boolean;
  nonNoteOnly?: boolean;
}) {
  const statusFilter = input.noteOnly
    ? { in: noteStatuses }
    : input.nonNoteOnly
      ? { notIn: noteStatuses }
      : undefined;

  if (input.uploadPdfId) {
    return {
      uploadPdfId: input.uploadPdfId,
      ...(statusFilter ? { status: statusFilter } : {})
    };
  }

  if (input.motoristaId && input.periodId && input.basePaymentId) {
    return {
      motoristaId: input.motoristaId,
      periodoPagamentoId: input.periodId,
      basePagamentoId: input.basePaymentId,
      ...(statusFilter ? { status: statusFilter } : {})
    };
  }

  return null;
}

async function setDriverPdfDocumentType(id: string, documentType: DocumentTypeCode) {
  await prisma.$executeRaw(Prisma.sql`
    update "driver_pdf_received"
       set "document_type" = ${documentType}
     where "id" = cast(${id} as uuid)
  `);
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
      nonNoteOnly: true
    }) || {
      motoristaId: input.motoristaId,
      periodoPagamentoId: input.periodId,
      basePagamentoId: input.basePaymentId
    },
    select: {
      id: true,
      visualizadoEm: true
    }
  });

  const data = {
    motoristaId: input.motoristaId,
    periodoPagamentoId: input.periodId,
    basePagamentoId: input.basePaymentId,
    nomeArquivo: input.fileName,
    caminhoArquivo: input.storageKey,
    tipoArquivo: input.mimeType || "application/pdf",
    uploadEm: now,
    usuarioId: input.createdByUserId ?? null,
    status,
    observacoes: null,
    visualizadoEm: existing?.visualizadoEm ?? null,
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
    const updated = await prisma.driverPdfReceived.update({
      where: {
        id: existing.id
      },
      data
    });

    await setDriverPdfDocumentType(updated.id, DocumentTypeCode.espelho);
    return updated;
  }

  const created = await prisma.driverPdfReceived.create({
    data
  });

  await setDriverPdfDocumentType(created.id, DocumentTypeCode.espelho);
  return created;
}

export async function markDriverPdfReceivedRejected(input: DriverPdfReceivedRejectionInput) {
  const now = input.rejectedAt || new Date();
  const where = buildReceivedWhere({
    uploadPdfId: input.uploadPdfId,
    motoristaId: input.motoristaId,
    periodId: input.periodId,
    basePaymentId: input.basePaymentId,
    noteOnly: true
  });

  if (where) {
    const existing = await prisma.driverPdfReceived.findFirst({
      where,
      select: {
        id: true
      }
    });

    if (existing?.id) {
      const updated = await prisma.driverPdfReceived.update({
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

      await setDriverPdfDocumentType(updated.id, DocumentTypeCode.nota_fiscal);
      return updated;
    }
  }

  if (!input.motoristaId || !input.periodId || !input.basePaymentId) {
    return null;
  }

  const created = await prisma.driverPdfReceived.create({
    data: {
      motoristaId: input.motoristaId,
      periodoPagamentoId: input.periodId,
      basePagamentoId: input.basePaymentId,
      nomeArquivo: input.fileName ?? null,
      caminhoArquivo: input.storageKey ?? null,
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

  await setDriverPdfDocumentType(created.id, DocumentTypeCode.nota_fiscal);
  return created;
}

export function isDriverPdfNoteStatus(value: string | null | undefined) {
  return isNoteStatus(value);
}

export function isDriverPdfMirrorStatus(value: string | null | undefined) {
  return isMirrorStatus(value);
}
