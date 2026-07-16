import { DriverPdfReceivedStatus, PrismaClient, UploadStatus } from "@prisma/client";
import { DocumentTypeCode, type DocumentTypeCode as DocumentTypeCodeValue } from "../src/lib/document-types.js";
import { isPaymentMirrorStorageKey } from "../src/lib/storage.js";

const prisma = new PrismaClient();
const applyChanges = process.argv.includes("--apply");

const mirrorStatuses = new Set<DriverPdfReceivedStatus>([
  DriverPdfReceivedStatus.pdf_aguardando_envio,
  DriverPdfReceivedStatus.pdf_enviado_ao_motorista,
  DriverPdfReceivedStatus.motorista_visualizou,
  DriverPdfReceivedStatus.aguardando_envio_nota_fiscal
]);

type UploadRow = {
  id: string;
  nomeOriginal: string;
  caminhoArquivo: string;
  motoristaId: string | null;
  periodoPagamentoId: string | null;
  basePagamentoId: string | null;
  status: UploadStatus;
  criadoEm: Date;
};

type MirrorRow = {
  id: string;
  uploadPdfId: string | null;
  documentType: DocumentTypeCodeValue | null;
  status: DriverPdfReceivedStatus;
  nomeArquivo: string | null;
  caminhoArquivo: string | null;
  motoristaId: string | null;
  periodoPagamentoId: string | null;
  basePagamentoId: string | null;
  uploadEm: Date;
};

function identityKeys(row: {
  motoristaId: string | null;
  periodoPagamentoId: string | null;
  basePagamentoId: string | null;
}) {
  const keys: string[] = [];

  if (row.motoristaId && row.periodoPagamentoId && row.basePagamentoId) {
    keys.push(`${row.motoristaId}|${row.periodoPagamentoId}|${row.basePagamentoId}`);
  }

  if (row.motoristaId && row.basePagamentoId) {
    keys.push(`${row.motoristaId}|${row.basePagamentoId}`);
  }

  if (row.basePagamentoId) {
    keys.push(`*|${row.basePagamentoId}`);
  }

  if (row.motoristaId) {
    keys.push(`${row.motoristaId}|*`);
  }

  return keys;
}

function chooseCandidate(
  row: {
    motoristaId: string | null;
    periodoPagamentoId: string | null;
    basePagamentoId: string | null;
    criadoEm?: Date;
  },
  candidatesByKey: Map<string, UploadRow>
) {
  for (const key of identityKeys(row)) {
    const candidate = candidatesByKey.get(key);

    if (candidate) {
      return candidate;
    }
  }

  return null;
}

async function main() {
  const [uploads, mirrors] = await Promise.all([
    prisma.uploadPdf.findMany({
      select: {
        id: true,
        nomeOriginal: true,
        caminhoArquivo: true,
        motoristaId: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        status: true,
        criadoEm: true
      }
    }),
    prisma.driverPdfReceived.findMany({
      select: {
        id: true,
        uploadPdfId: true,
        documentType: true,
        status: true,
        nomeArquivo: true,
        caminhoArquivo: true,
        motoristaId: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        uploadEm: true
      }
    })
  ]);

  const validUploads = uploads
    .filter((row) => isPaymentMirrorStorageKey(row.caminhoArquivo))
    .slice()
    .sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime());

  const candidatesByKey = new Map<string, UploadRow>();
  for (const upload of validUploads) {
    for (const key of identityKeys(upload)) {
      if (!candidatesByKey.has(key)) {
        candidatesByKey.set(key, upload);
      }
    }
  }

  const uploadById = new Map(uploads.map((row) => [row.id, row]));

  const uploadRepairs = uploads
    .filter((row) => !isPaymentMirrorStorageKey(row.caminhoArquivo))
    .map((row) => {
      const candidate = chooseCandidate(row, candidatesByKey);
      return candidate && candidate.caminhoArquivo !== row.caminhoArquivo
        ? {
            id: row.id,
            from: row.caminhoArquivo,
            to: candidate.caminhoArquivo,
            reason: "uploads_pdf"
          }
        : null;
    })
    .filter((value): value is { id: string; from: string; to: string; reason: string } => Boolean(value));

  const mirrorRepairs = mirrors
    .filter((row) => mirrorStatuses.has(row.status) || row.documentType === DocumentTypeCode.espelho)
    .filter((row) => !isPaymentMirrorStorageKey(row.caminhoArquivo))
    .map((row) => {
      const relatedUpload = row.uploadPdfId ? uploadById.get(row.uploadPdfId) : null;
      const candidate = relatedUpload ? chooseCandidate(relatedUpload, candidatesByKey) : chooseCandidate(row, candidatesByKey);
      return candidate && candidate.caminhoArquivo !== row.caminhoArquivo
        ? {
            id: row.id,
            from: row.caminhoArquivo || "",
            to: candidate.caminhoArquivo,
            reason: "driver_pdf_received"
          }
        : null;
    })
    .filter((value): value is { id: string; from: string; to: string; reason: string } => Boolean(value));

  console.log(
    JSON.stringify(
      {
        mode: applyChanges ? "apply" : "dry-run",
        uploadsFound: uploads.length,
        uploadsRepairs: uploadRepairs.length,
        mirrorRowsFound: mirrors.length,
        mirrorRepairs: mirrorRepairs.length
      },
      null,
      2
    )
  );

  if (!applyChanges) {
    console.log(
      JSON.stringify(
        {
          uploadRepairs: uploadRepairs.slice(0, 20),
          mirrorRepairs: mirrorRepairs.slice(0, 20)
        },
        null,
        2
      )
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const repair of uploadRepairs) {
      await tx.uploadPdf.update({
        where: { id: repair.id },
        data: { caminhoArquivo: repair.to }
      });
    }

    for (const repair of mirrorRepairs) {
      const current = mirrors.find((row) => row.id === repair.id);
      await tx.driverPdfReceived.update({
        where: { id: repair.id },
        data: {
          caminhoArquivo: repair.to,
          nomeArquivo: current?.nomeArquivo || null
        }
      });
    }
  });

  console.log("Reparo de caminhos concluido com sucesso.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
