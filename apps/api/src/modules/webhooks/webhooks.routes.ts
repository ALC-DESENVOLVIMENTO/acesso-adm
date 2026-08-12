import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DriverPdfReceivedStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import {
  markDriverPdfReceivedRejected,
  markDriverPdfReceivedViewed,
  upsertDriverPdfReceivedNoteStatus
} from "../../lib/driver-pdf-received.js";

const router = Router();

const webhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  data: z.record(z.unknown()).default({})
}).passthrough();

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

function isValidWebhookSignature(req: Request) {
  const secret = String(
    process.env.ACCESS_ADM_WEBHOOK_SECRET || process.env.PDFONLINE_WEBHOOK_SECRET || ""
  ).trim();

  if (!secret) {
    return true;
  }

  const provided = String(req.headers["x-webhook-signature"] || "").trim().replace(/^sha256=/i, "");
  const body = JSON.stringify(req.body ?? {});
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  if (!provided || provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
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

function isSefazCheckedEvent(event: string) {
  return event.trim().toLowerCase() === "portal.invoice.sefaz_checked";
}

function resolveSefazValidation(data: Record<string, unknown>) {
  const status = readString(data.sefazStatus || data.sefaz_status).toLowerCase();
  const active = typeof (data.sefazActive ?? data.sefaz_active) === "boolean"
    ? Boolean(data.sefazActive ?? data.sefaz_active)
    : null;

  if (active === true || ["ativa", "ativo", "autorizada", "autorizado", "validada", "valida"].includes(status)) {
    return { sefazStatus: "ativa", sefazActive: true, invoiceValidation: "valida", workflowStatus: DriverPdfReceivedStatus.nota_fiscal_aprovada };
  }

  if (active === false || ["cancelada", "cancelado", "invalida", "invalida"].includes(status)) {
    return { sefazStatus: "cancelada", sefazActive: false, invoiceValidation: "nao_valida", workflowStatus: DriverPdfReceivedStatus.nota_fiscal_rejeitada };
  }

  if (["nao_encontrada", "não_encontrada", "not_found"].includes(status)) {
    return { sefazStatus: "nao_encontrada", sefazActive: false, invoiceValidation: "nao_localizada", workflowStatus: DriverPdfReceivedStatus.nota_fiscal_em_analise };
  }

  return { sefazStatus: status || "erro_api", sefazActive: false, invoiceValidation: "erro_api", workflowStatus: DriverPdfReceivedStatus.nota_fiscal_em_analise };
}

async function processSefazCheckedWebhook(req: Request, data: Record<string, unknown>, event: string) {
  const referenceId = readString(
    data.uploadId || data.uploadPdfId || data.upload_id || data.upload_pdf_id || data.driverPdfReceivedId || data.driver_pdf_received_id
  );
  const periodId = readString(data.periodId || data.periodoPagamentoId || data.periodo_pagamento_id) || null;
  const basePaymentId = readString(data.basePaymentId || data.basePagamentoId || data.base_pagamento_id) || null;
  const motoristaId = readString(data.motoristaId || data.motorista_id) || null;
  const eventId = readString(data.eventId || data.event_id) || null;

  if (eventId) {
    const duplicate = await prisma.webhookEvento.findUnique({ where: { eventId }, select: { id: true, status: true } });
    if (duplicate) {
      return { duplicate: true, receivedId: duplicate.id };
    }
  }

  const upload = referenceId
    ? await prisma.uploadPdf.findUnique({
        where: { id: referenceId },
        select: { id: true, motoristaId: true, periodoPagamentoId: true, basePagamentoId: true, nomeOriginal: true, nomeArquivo: true, caminhoArquivo: true }
      })
    : null;
  const receivedReference = !upload && referenceId
    ? await prisma.driverPdfReceived.findUnique({
        where: { id: referenceId },
        select: { motoristaId: true, periodoPagamentoId: true, basePagamentoId: true, nomeArquivo: true, caminhoArquivo: true }
      })
    : null;
  const resolvedMotoristaId = motoristaId || upload?.motoristaId || receivedReference?.motoristaId || null;
  const resolvedPeriodId = periodId || upload?.periodoPagamentoId || receivedReference?.periodoPagamentoId || null;
  const resolvedBaseId = basePaymentId || upload?.basePagamentoId || receivedReference?.basePagamentoId || null;
  const validation = resolveSefazValidation(data);

  const receipt = await upsertDriverPdfReceivedNoteStatus({
    uploadPdfId: upload?.id || null,
    motoristaId: resolvedMotoristaId,
    periodId: resolvedPeriodId,
    basePaymentId: resolvedBaseId,
    fileName: readString(data.fileName || data.file_name) || upload?.nomeOriginal || upload?.nomeArquivo || receivedReference?.nomeArquivo || null,
    storageKey: readString(data.storageKey || data.storage_key) || upload?.caminhoArquivo || receivedReference?.caminhoArquivo || null,
    status: validation.workflowStatus,
    receivedAt: parseWebhookDate(data.receivedAt || data.received_at),
    approvedAt: validation.workflowStatus === DriverPdfReceivedStatus.nota_fiscal_aprovada
      ? parseWebhookDate(data.checkedAt || data.sefazChecked || data.sefaz_checked || data.occurredAt || data.occurred_at)
      : null,
    observacoes: readString(data.sefazStatusMessage || data.sefaz_status_message || data.message) || null
  });

  if (!receipt) {
    throw new Error("Webhook SEFAZ sem vínculo seguro com a nota fiscal.");
  }

  const checkedAt = parseWebhookDate(data.sefazChecked || data.sefaz_checked || data.checkedAt || data.checked_at || data.occurredAt || data.occurred_at) || new Date();
  const updated = await prisma.driverPdfReceived.update({
    where: { id: receipt.id },
    data: {
      sefazStatus: validation.sefazStatus,
      sefazActive: validation.sefazActive,
      sefazChecked: checkedAt,
      sefazStatusCode: readString(data.sefazStatusCode || data.sefaz_status_code) || null,
      sefazStatusMessage: readString(data.sefazStatusMessage || data.sefaz_status_message || data.message) || null,
      accessKey: readString(data.accessKey || data.access_key || data.chaveAcesso || data.chave_acesso) || null,
      invoiceValidation: validation.invoiceValidation
    },
    select: { id: true, status: true, sefazStatus: true, sefazActive: true, sefazChecked: true, invoiceValidation: true }
  });

  if (eventId) {
    await prisma.webhookEvento.create({
      data: {
        eventId,
        pagamentoId: upload?.id || null,
        payload: req.body,
        status: "enviado",
        tentativas: 1,
        respostaHttp: 200,
        usuarioId: null
      }
    });
  }

  await prisma.logAuditoria.create({
    data: {
      usuarioId: null,
      acao: "conferencia_sefaz_nota_fiscal",
      entidade: "driver_pdf_received",
      entidadeId: updated.id,
      ipOrigem: req.ip,
      userAgent: req.get("user-agent") || null,
      detalhes: {
        event,
        eventId,
        uploadId: upload?.id || referenceId || null,
        motoristaId: resolvedMotoristaId,
        periodId: resolvedPeriodId,
        basePaymentId: resolvedBaseId,
        sefazStatus: validation.sefazStatus,
        sefazActive: validation.sefazActive,
        accessKey: updated.sefazStatus ? readString(data.accessKey || data.access_key || data.chaveAcesso || data.chave_acesso) || null : null
      }
    }
  });

  return { duplicate: false, receivedId: updated.id, validation: updated };
}

async function handleDirectSefazRoute(req: Request, res: Response) {
  if (!isAuthorized(req) || !isValidWebhookSignature(req)) {
    res.status(401).json({ message: "Webhook nao autorizado." });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const data = body.data && typeof body.data === "object"
    ? { ...body, ...(body.data as Record<string, unknown>) }
    : body;
  const result = await processSefazCheckedWebhook(req, data, "portal.invoice.sefaz_checked");
  res.status(200).json({
    message: result.duplicate
      ? "Conferencia SEFAZ ja processada anteriormente."
      : "Conferencia SEFAZ registrada com sucesso.",
    duplicate: result.duplicate,
    receivedId: result.receivedId,
    validation: result.validation || null
  });
}

router.post("/invoice/sefaz-checked", (req, res) => {
  void handleDirectSefazRoute(req, res).catch((error) => {
    res.status(500).json({
      message: "Falha ao processar conferencia SEFAZ.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/access-adm", (req, res) => {
  void (async () => {
    if (!isAuthorized(req)) {
      res.status(401).json({
        message: "Webhook nao autorizado."
      });
      return;
    }

    if (!isValidWebhookSignature(req)) {
      res.status(401).json({
        message: "Assinatura do webhook invalida."
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
    const data = {
      ...(req.body && typeof req.body === "object" ? req.body : {}),
      ...(parsed.data.data || {})
    } as Record<string, unknown>;

    if (isSefazCheckedEvent(event)) {
      const result = await processSefazCheckedWebhook(req, data, event);
      res.status(200).json({
        message: result.duplicate
          ? "Conferencia SEFAZ ja processada anteriormente."
          : "Conferencia SEFAZ registrada com sucesso.",
        duplicate: result.duplicate,
        receivedId: result.receivedId,
        validation: result.validation || null
      });
      return;
    }
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
      processo_concluido: DriverPdfReceivedStatus.processo_concluido,
      motorista_visualizou: DriverPdfReceivedStatus.motorista_visualizou
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
      if (noteStatus === DriverPdfReceivedStatus.motorista_visualizou) {
        const result = await markDriverPdfReceivedViewed({
          uploadPdfId: uploadId || null,
          motoristaId: readString(data.motoristaId) || upload?.motoristaId || null,
          periodId: readString(data.periodId) || upload?.periodoPagamentoId || null,
          basePaymentId: readString(data.basePaymentId) || upload?.basePagamentoId || null,
          fileName: readString(data.fileName) || upload?.nomeOriginal || upload?.nomeArquivo || null,
          storageKey: readString(data.storageKey) || upload?.caminhoArquivo || null,
          mimeType: readString(data.mimeType) || "application/pdf",
          viewedAt: parseWebhookDate(data.viewedAt || data.visualizadoEm || data.occurredAt || data.occurred_at),
          createdByUserId: readString(data.createdByUserId) || null
        });

        if (result?.firstView) {
          await prisma.logAuditoria.create({
            data: {
              usuarioId: null,
              acao: "webhook_pdf_visualizado",
              entidade: "driver_pdf_received",
              entidadeId: result.record.id || upload?.id || null,
              ipOrigem: req.ip,
              userAgent: req.get("user-agent") || null,
              detalhes: {
                event,
                uploadId,
                motoristaId: readString(data.motoristaId) || upload?.motoristaId || null,
                periodId: readString(data.periodId) || upload?.periodoPagamentoId || null,
                basePaymentId: readString(data.basePaymentId) || upload?.basePagamentoId || null
              }
            }
          });
        }

        res.json({
          message: result?.firstView ? "Visualização registrada com sucesso." : "Visualização já registrada anteriormente.",
          receivedId: result?.record.id || null
        });
        return;
      }

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
