import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrlWithSchema } from "../src/lib/database-url.js";

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrlWithSchema() } } });

async function main() {
  const receipts = await prisma.driverPdfReceived.findMany({
    where: { documentType: { not: "espelho" }, uploadPdfId: { not: null } },
    select: { id: true, uploadPdfId: true, motoristaId: true, periodoPagamentoId: true, basePagamentoId: true, status: true, nomeArquivo: true }
  });
  const sourceIds = receipts.map((receipt) => receipt.uploadPdfId).filter((id): id is string => Boolean(id));
  const sources = await prisma.uploadPdf.findMany({
    where: { id: { in: sourceIds }, documentType: { not: "espelho" } },
    select: { id: true, motoristaId: true, periodoPagamentoId: true, basePagamentoId: true, nomeArquivo: true }
  });
  const sourceById = new Map(sources.map((source) => [source.id, source] as const));
  const candidates = receipts.map((receipt) => {
    const source = receipt.uploadPdfId ? sourceById.get(receipt.uploadPdfId) : null;
    if (!source || !source.motoristaId || !source.periodoPagamentoId || !source.basePagamentoId) return null;
    if (receipt.motoristaId && receipt.motoristaId !== source.motoristaId) {
      return { kind: "conflito", receipt, source } as const;
    }
    const changed = receipt.motoristaId !== source.motoristaId || receipt.periodoPagamentoId !== source.periodoPagamentoId || receipt.basePagamentoId !== source.basePagamentoId;
    return changed ? { kind: "corrigir", receipt, source } as const : { kind: "ok", receipt, source } as const;
  }).filter(Boolean);
  const conflicts = candidates.filter((item) => item.kind === "conflito");
  const toFix = candidates.filter((item) => item.kind === "corrigir");
  for (const item of toFix) {
    if (item.kind !== "corrigir") continue;
    await prisma.$transaction(async (tx) => {
      await tx.driverPdfReceived.update({
        where: { id: item.receipt.id },
        data: { motoristaId: item.source.motoristaId, periodoPagamentoId: item.source.periodoPagamentoId, basePagamentoId: item.source.basePagamentoId }
      });
      await tx.logAuditoria.create({
        data: {
          acao: "backfill_escopo_nf",
          entidade: "driver_pdf_received",
          entidadeId: item.receipt.id,
          detalhes: {
            origem: "upload_pdf_original",
            uploadPdfId: item.source.id,
            arquivo: item.receipt.nomeArquivo || item.source.nomeArquivo,
            antes: { motoristaId: item.receipt.motoristaId, periodoPagamentoId: item.receipt.periodoPagamentoId, basePagamentoId: item.receipt.basePagamentoId },
            depois: { motoristaId: item.source.motoristaId, periodoPagamentoId: item.source.periodoPagamentoId, basePagamentoId: item.source.basePagamentoId }
          }
        }
      });
    });
  }
  console.log(JSON.stringify({ totalRecibosNF: receipts.length, semEscopoCorrigidos: toFix.length, semAlteracao: candidates.filter((item) => item.kind === "ok").length, conflitosNaoAlterados: conflicts.length, conflitos: conflicts.map((item) => ({ receiptId: item.receipt.id, uploadPdfId: item.source.id, reciboMotoristaId: item.receipt.motoristaId, uploadMotoristaId: item.source.motoristaId, arquivo: item.receipt.nomeArquivo })) }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
