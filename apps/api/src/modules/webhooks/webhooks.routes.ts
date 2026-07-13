import { Router, type Request } from "express";
import { DriverPdfReceivedStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import {
  markDriverPdfReceivedRejected,
  upsertDriverPdfReceivedNoteStatus
} from "../../lib/driver-pdf-received.js";

const router = Router();

const webhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  data: z.record(z.unknown()).default({})
});

function readWebhookToken(req: Request) {
  const authorization = String(req.headers.authorization || "").trim();

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return String(
    req.headers["x-webhook-token"] ||
      req.headers["x-bridge-token"] ||
      req.headers["x-access-adm-token"] ||
      ""
  ).trim();
}

function resolveExpectedToken() {
  return String(
    process.env.ACCESS_ADM_WEBHOOK_TOKEN ||
      process.env.PDFONLINE_BRIDGE_TOKEN ||
      process.env.PDFONLINE_WEBHOOK_TOKEN ||
      ""
  ).trim();
}

function isAuthorized(req: Request) {
  const expectedToken = resolveExpectedToken();

  if (!expectedToken) {
    return true;
  }

  return readWebhookToken(req) === expectedToken;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWebhookStatus(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function parseWebhookDate(value: unknown) {
  const raw = readString(value);

  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

router.post("/access-adm", (req, res) => {
  void (async () => {
    if (!isAuthorized(req)) {
      res.status(401).json({
        message: "Webhook nao autorizado."
      });
      return;
    }

    const parsed = webhookEnvelopeSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: "Payload invalido para webhook.",
        issues: parsed.error.flatten()
      });
      return;
    }

    const event = parsed.data.event.trim();
    const data = parsed.data.data || {};
    const rawStatus = normalizeWebhookStatus(
      readString(
        data.status ||
          data.notaFiscalStatus ||
          data.nota_fiscal_status ||
          data.situacao ||
          data.situacaoNotaFiscal ||
          event
      )
    );

    const noteStatusMap: Record<string, DriverPdfReceivedStatus> = {
      nota_fiscal_recebida: DriverPdfReceivedStatus.nota_fiscal_recebida,
      nota_fiscal_em_analise: DriverPdfReceivedStatus.nota_fiscal_em_analise,
      nota_fiscal_aprovada: DriverPdfReceivedStatus.nota_fiscal_aprovada,
      nota_fiscal_rejeitada: DriverPdfReceivedStatus.nota_fiscal_rejeitada,
      processo_concluido: DriverPdfReceivedStatus.processo_concluido
    };
    const noteStatus = noteStatusMap[rawStatus] || null;
    const uploadId = readString(data.uploadId || data.uploadPdfId);
    const upload = uploadId
      ? await prisma.uploadPdf.findUnique({
          where: {
            id: uploadId
          },
          select: {
            id: true,
            motoristaId: true,
            periodoPagamentoId: true,
            basePagamentoId: true,
            nomeOriginal: true,
            caminhoArquivo: true,
            nomeArquivo: true
          }
        })
      : null;

    if (noteStatus) {
      const result = await upsertDriverPdfReceivedNoteStatus({
        uploadPdfId: uploadId || null,
        motoristaId: readString(data.motoristaId) || upload?.motoristaId || null,
        periodId: readString(data.periodId) || upload?.periodoPagamentoId || null,
        basePaymentId: readString(data.basePaymentId) || upload?.basePagamentoId || null,
        fileName: readString(data.fileName) || upload?.nomeOriginal || upload?.nomeArquivo || null,
        storageKey: readString(data.storageKey) || upload?.caminhoArquivo || null,
        mimeType: readString(data.mimeType) || "application/pdf",
        status: noteStatus,
        receivedAt: parseWebhookDate(data.receivedAt),
        approvedAt: parseWebhookDate(data.approvedAt),
        rejectedAt: parseWebhookDate(data.rejectedAt),
        observacoes: readString(data.observacoes || data.observation || data.notes) || null,
        createdByUserId: readString(data.createdByUserId) || null
      });

      await prisma.logAuditoria.create({
        data: {
          usuarioId: null,
          acao: "webhook_pdf_nota_fiscal_status",
          entidade: "driver_pdf_received",
          entidadeId: result?.id || upload?.id || null,
          ipOrigem: req.ip,
          userAgent: req.get("user-agent") || null,
          detalhes: {
            event,
            status: noteStatus,
            uploadId,
            motoristaId: readString(data.motoristaId) || upload?.motoristaId || null,
            periodId: readString(data.periodId) || upload?.periodoPagamentoId || null,
            basePaymentId: readString(data.basePaymentId) || upload?.basePagamentoId || null
          }
        }
      });

      res.json({
        message: "Status de nota fiscal registrado com sucesso.",
        receivedId: result?.id || null
      });
      return;
    }

    if (!event.toLowerCase().includes("rejeit")) {
      res.json({
        message: "Evento recebido.",
        ignored: true
      });
      return;
    }

    const result = await markDriverPdfReceivedRejected({
      uploadPdfId: uploadId || null,
      motoristaId: readString(data.motoristaId) || upload?.motoristaId || null,
      periodId: readString(data.periodId) || upload?.periodoPagamentoId || null,
      basePaymentId: readString(data.basePaymentId) || upload?.basePagamentoId || null,
      fileName: readString(data.fileName) || upload?.nomeOriginal || upload?.nomeArquivo || null,
      storageKey: readString(data.storageKey) || upload?.caminhoArquivo || null,
      mimeType: readString(data.mimeType) || "application/pdf",
      motivoRejeicao: readString(data.motivoRejeicao || data.reason || data.motivo || data.message) || null,
      observacoes: readString(data.observacoes || data.observation || data.notes) || null,
      rejectedById: readString(data.rejectedById) || null,
      rejectedAt: readString(data.rejectedAt) ? new Date(readString(data.rejectedAt)) : null
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: null,
        acao: "webhook_pdf_rejeitado",
        entidade: "driver_pdf_received",
        entidadeId: result?.id || upload?.id || null,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          event,
          uploadId,
          motoristaId: readString(data.motoristaId) || upload?.motoristaId || null,
          periodId: readString(data.periodId) || upload?.periodoPagamentoId || null,
          basePaymentId: readString(data.basePaymentId) || upload?.basePagamentoId || null,
          motivoRejeicao: readString(data.motivoRejeicao || data.reason || data.motivo || data.message) || null
        }
      }
    });

    res.json({
      message: "Rejeicao registrada com sucesso.",
      receivedId: result?.id || null
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao processar webhook.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
