import { DriverPdfReceivedStatus, PrismaClient } from "@prisma/client";
import { DocumentTypeCode } from "../src/lib/document-types.js";

const prisma = new PrismaClient();
const applyChanges = process.argv.includes("--apply");

const noteStatuses = new Set<DriverPdfReceivedStatus>([
  DriverPdfReceivedStatus.nota_fiscal_recebida,
  DriverPdfReceivedStatus.nota_fiscal_em_analise,
  DriverPdfReceivedStatus.nota_fiscal_aprovada,
  DriverPdfReceivedStatus.nota_fiscal_rejeitada,
  DriverPdfReceivedStatus.processo_concluido
]);

async function main() {
  const [uploadRows, receivedRows] = await Promise.all([
    prisma.uploadPdf.findMany({
      select: {
        id: true,
        documentType: true,
        status: true
      }
    }),
    prisma.driverPdfReceived.findMany({
      select: {
        id: true,
        documentType: true,
        status: true
      }
    })
  ]);

  const uploadsToFix = uploadRows.filter((row) => row.documentType !== DocumentTypeCode.espelho);
  const receivedToFix = receivedRows.filter((row) => {
    const expected = noteStatuses.has(row.status) ? DocumentTypeCode.nota_fiscal : DocumentTypeCode.espelho;
    return row.documentType !== expected;
  });

  console.log(
    JSON.stringify(
      {
        mode: applyChanges ? "apply" : "dry-run",
        uploadCount: uploadRows.length,
        uploadsToFix: uploadsToFix.length,
        receivedCount: receivedRows.length,
        receivedToFix: receivedToFix.length
      },
      null,
      2
    )
  );

  if (!applyChanges) {
    console.log(
      JSON.stringify(
        {
          sampleUploads: uploadsToFix.slice(0, 10).map((row) => ({ id: row.id, documentType: row.documentType, status: row.status })),
          sampleReceived: receivedToFix.slice(0, 10).map((row) => ({ id: row.id, documentType: row.documentType, status: row.status }))
        },
        null,
        2
      )
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `update "uploads_pdf"
       set "document_type" = $1
       where "document_type" is distinct from $1`,
      DocumentTypeCode.espelho
    );

    await tx.$executeRawUnsafe(
      `update "driver_pdf_received"
       set "document_type" = case
         when "status" in ('nota_fiscal_recebida', 'nota_fiscal_em_analise', 'nota_fiscal_aprovada', 'nota_fiscal_rejeitada', 'processo_concluido')
           then $1
         else $2
       end
       where "document_type" is distinct from case
         when "status" in ('nota_fiscal_recebida', 'nota_fiscal_em_analise', 'nota_fiscal_aprovada', 'nota_fiscal_rejeitada', 'processo_concluido')
           then $1
         else $2
       end`,
      DocumentTypeCode.nota_fiscal,
      DocumentTypeCode.espelho
    );
  });

  console.log("Backfill concluido com sucesso.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
