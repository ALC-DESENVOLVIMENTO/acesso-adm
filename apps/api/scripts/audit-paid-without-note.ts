import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrlWithSchema } from "../src/lib/database-url.js";

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrlWithSchema() } } });
const ids = [
  "eee25f29-ea03-4ad0-a63f-85059161dc2b",
  "f928a184-03f9-4069-8c19-7a4324ef2a0c"
];

async function main() {
  const uploads = await prisma.uploadPdf.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      motoristaId: true,
      motoristaNomeExtraido: true,
      motoristaCnpjExtraido: true,
      status: true,
      statusPagamento: true,
      statusPagamentoOrigem: true,
      statusPagamentoMotivo: true,
      periodoPagamentoId: true,
      basePagamentoId: true,
      caminhoArquivo: true,
      criadoEm: true
    }
  });

  const histories = await prisma.historicoStatusPagamento.findMany({
    where: { pagamentoId: { in: ids } },
    orderBy: { criadoEm: "asc" },
    select: {
      pagamentoId: true,
      statusAnterior: true,
      statusNovo: true,
      origem: true,
      motivo: true,
      importacaoId: true,
      criadoEm: true
    }
  });

  const receipts = await prisma.driverPdfReceived.findMany({
    where: {
      motoristaId: { in: uploads.map((upload) => upload.motoristaId).filter((id): id is string => Boolean(id)) },
      status: { in: ["nota_fiscal_recebida", "nota_fiscal_em_analise", "nota_fiscal_aprovada", "nota_fiscal_rejeitada", "processo_concluido"] }
    },
    select: {
      id: true,
      motoristaId: true,
      periodoPagamentoId: true,
      basePagamentoId: true,
      status: true,
      documentType: true,
      nomeArquivo: true,
      uploadPdfId: true
    }
  });

  const auditLogs = await prisma.logAuditoria.findMany({
    where: { entidadeId: { in: ids } },
    orderBy: { criadoEm: "asc" },
    select: { id: true, acao: true, entidade: true, entidadeId: true, detalhes: true, criadoEm: true }
  });

  const report = uploads.map((upload) => ({
    upload,
    histories: histories.filter((history) => history.pagamentoId === upload.id),
    receipts: receipts.filter((receipt) =>
      receipt.motoristaId === upload.motoristaId &&
      receipt.periodoPagamentoId === upload.periodoPagamentoId &&
      receipt.basePagamentoId === upload.basePagamentoId
    ),
    priorAuditLogs: auditLogs.filter((log) => log.entidadeId === upload.id)
  }));

  for (const item of report) {
    await prisma.logAuditoria.create({
      data: {
        acao: "auditoria_pagamento_sem_nf",
        entidade: "uploads_pdf",
        entidadeId: item.upload.id,
        detalhes: {
          escopo: "correcao_luiz_pedro_2026_09_10",
          motoristaId: item.upload.motoristaId,
          motoristaNomeExtraido: item.upload.motoristaNomeExtraido,
          periodoPagamentoId: item.upload.periodoPagamentoId,
          basePagamentoId: item.upload.basePagamentoId,
          statusPagamentoAtual: item.upload.statusPagamento,
          statusPagamentoOrigem: item.upload.statusPagamentoOrigem,
          statusPagamentoMotivo: item.upload.statusPagamentoMotivo,
          historicoStatus: item.histories,
          recibosNotaFiscalNoMesmoEscopo: item.receipts,
          logsAnterioresDoRegistro: item.priorAuditLogs,
          bucket: {
            objetosNotasFiscaisEncontrados: 0,
            observacao: "Auditoria do bucket não encontrou objeto de nota fiscal para este registro/escopo; não há evidência técnica de exclusão."
          },
          conclusao: "Pagamento PAGO preservado como histórico, mas sem NF comprovável no escopo. Registro não pode entrar em A pagar; futuras importações PAGO sem NF aprovada serão bloqueadas."
        }
      }
    });
  }

  console.log(JSON.stringify({ report, createdLogs: report.map((item) => item.upload.id) }, null, 2));
}

main().finally(() => prisma.$disconnect());
