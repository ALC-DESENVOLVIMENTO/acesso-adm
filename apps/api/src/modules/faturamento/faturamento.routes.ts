import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import { requireAuth, requireModuleAccess, requirePermission } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { parseFaturamentoReferences, parsePreFatura, type FaturamentoTipo } from "./faturamento-parser.js";

const router = Router();
const DB_SCHEMA = process.env.DB_SCHEMA || "portal_administrativo";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, callback) => callback(null, /\.(xlsx|xls)$/i.test(file.originalname))
});

const typeSchema: Record<string, FaturamentoTipo> = { lastmile: "lastmile", linehaul: "linehaul", melione: "melione" };
const typeLabels: Record<FaturamentoTipo, string> = { lastmile: "LastMile", linehaul: "LineHaul", melione: "MeliOne" };

function number(value: unknown) { return Number(value || 0); }
function cleanType(value: unknown): FaturamentoTipo | null { return typeSchema[String(value || "").toLowerCase()] || null; }
function safeFilename(value: string) { return value.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80); }

router.use(requireAuth, requireModuleAccess("faturamento"));

router.get("/summary", async (req, res) => {
  const requestedType = cleanType(req.query.type) || "lastmile";
  const rows = await prisma.$queryRawUnsafe<Array<any>>(`
    SELECT id, operacao, tipo, numero, nome_arquivo, nome_aba_principal, criado_em, total_linhas, total_rotas, total_geral, status, resumo
    FROM "${DB_SCHEMA}"."faturamento_pre_faturas"
    WHERE operacao = 'mercado_livre'
    ORDER BY criado_em DESC
    LIMIT 100
  `);
  const latestByType: Record<string, any> = {};
  rows.forEach((row) => { if (!latestByType[row.tipo]) latestByType[row.tipo] = row; });
  const selected = latestByType[requestedType] || latestByType.lastmile || rows[0] || null;
  let dashboard: any = { totalRows: 0, totalRoutes: 0, totalGeneral: 0, byCategory: {}, byBase: [] };
  if (selected) {
    const items = await prisma.$queryRawUnsafe<Array<any>>(`
      SELECT categoria, sigla_base, nome_base, COUNT(*)::int AS linhas, COALESCE(SUM(total),0)::float AS total
      FROM "${DB_SCHEMA}"."faturamento_pre_fatura_itens" WHERE pre_fatura_id = '${selected.id}' GROUP BY categoria, sigla_base, nome_base
    `);
    dashboard.totalRows = number(selected.total_linhas); dashboard.totalRoutes = number(selected.total_rotas); dashboard.totalGeneral = number(selected.total_geral);
    const bases: Record<string, any> = {};
    for (const item of items) {
      dashboard.byCategory[item.categoria] = (dashboard.byCategory[item.categoria] || 0) + number(item.total);
      const base = item.sigla_base || "Sem base";
      bases[base] ||= { sigla: base, nomeBase: item.nome_base || base, linhas: 0, total: 0 };
      bases[base].linhas += number(item.linhas); bases[base].total += number(item.total);
    }
    dashboard.byBase = Object.values(bases).sort((a: any, b: any) => b.total - a.total);
  }
  res.json({ operation: "mercado_livre", selectedType: selected?.tipo || requestedType, selected, latestByType, preFaturas: rows, dashboard, types: Object.entries(typeLabels).map(([value, label]) => ({ value, label })) });
});

router.get("/pre-faturas/:id", async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize || 50)));
  const id = req.params.id;
  const pre = await prisma.$queryRawUnsafe<Array<any>>(`SELECT * FROM "${DB_SCHEMA}"."faturamento_pre_faturas" WHERE id = '${id}' LIMIT 1`);
  if (!pre[0]) { res.status(404).json({ message: "Pré-fatura não encontrada." }); return; }
  const search = String(req.query.search || "").replace(/'/g, "''");
  const where = search ? `AND (motorista ILIKE '%${search}%' OR placa ILIKE '%${search}%' OR sigla_base ILIKE '%${search}%')` : "";
  const items = await prisma.$queryRawUnsafe<Array<any>>(`SELECT * FROM "${DB_SCHEMA}"."faturamento_pre_fatura_itens" WHERE pre_fatura_id = '${id}' ${where} ORDER BY linha_excel LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  const count = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`SELECT COUNT(*)::int AS count FROM "${DB_SCHEMA}"."faturamento_pre_fatura_itens" WHERE pre_fatura_id = '${id}' ${where}`);
  res.json({ preFatura: pre[0], items, page, pageSize, total: number(count[0]?.count) });
});

router.post("/pre-faturas/importar", requirePermission("faturamento.import"), upload.fields([{ name: "file", maxCount: 1 }, { name: "baseReference", maxCount: 1 }, { name: "vehicleReference", maxCount: 1 }]), async (req, res) => {
  const files = req.files as { file?: Express.Multer.File[]; baseReference?: Express.Multer.File[]; vehicleReference?: Express.Multer.File[] } | undefined;
  const preFile = files?.file?.[0];
  if (!preFile) { res.status(400).json({ message: "Selecione um arquivo .xlsx ou .xls." }); return; }
  const tipo = cleanType(req.body.type);
  if (!tipo) { res.status(400).json({ message: "Selecione o tipo da pré-fatura: LastMile, LineHaul ou MeliOne." }); return; }
  try {
    const references = parseFaturamentoReferences(files?.baseReference?.[0]?.buffer, files?.vehicleReference?.[0]?.buffer);
    const parsed = parsePreFatura(preFile.buffer, preFile.originalname, references);
    const hash = crypto.createHash("sha256").update(preFile.buffer).digest("hex");
    const existing = await prisma.$queryRawUnsafe<Array<any>>(`SELECT id FROM "${DB_SCHEMA}"."faturamento_pre_faturas" WHERE operacao = 'mercado_livre' AND tipo = '${tipo}' AND resumo->>'hash' = '${hash}' LIMIT 1`);
    if (existing[0]) { res.status(409).json({ message: "Esta pré-fatura já foi importada.", id: existing[0].id }); return; }
    const totalGeneral = parsed.items.reduce((sum, item) => sum + (item.categoria === "principal" ? item.total || 0 : 0), 0);
    const summary = { ...parsed.resumo, hash, hashArquivo: hash, tipoLabel: typeLabels[tipo] };
    const preId = crypto.randomUUID();
    await prisma.$executeRaw(Prisma.sql`INSERT INTO ${Prisma.raw(`"${DB_SCHEMA}"."faturamento_pre_faturas"`)} (id, operacao, tipo, numero, nome_arquivo, nome_aba_principal, usuario_id, total_linhas, total_rotas, total_geral, resumo) VALUES (${preId}::uuid, 'mercado_livre', ${tipo}, ${parsed.numero}, ${preFile.originalname}, ${parsed.nomeAbaPrincipal}, ${req.auth!.userId}::uuid, ${parsed.items.length}, ${new Set(parsed.items.map((item) => item.idRota).filter(Boolean)).size}, ${totalGeneral}, ${JSON.stringify(summary)}::jsonb)`);
    for (let start = 0; start < parsed.items.length; start += 250) {
      const chunk = parsed.items.slice(start, start + 250);
      const values = chunk.map((item) => Prisma.sql`(${crypto.randomUUID()}::uuid, ${preId}::uuid, ${item.aba}, ${item.linhaExcel}, ${item.categoria}, ${item.descricao}, ${item.veiculoModal}, ${item.svcContinuacao}, ${item.svc}, ${item.siglaBase}, ${item.nomeBase}, ${item.kmRange}, ${item.kmRanger}, ${item.idRota}, ${item.dataInicio}, ${item.dataFim}, ${item.placa}, ${item.motorista}, ${item.quantidade}, ${item.precoUnitario}, ${item.total}, ${item.tipoFrota}, ${JSON.stringify(item.raw)}::jsonb)`);
      await prisma.$executeRaw(Prisma.sql`INSERT INTO ${Prisma.raw(`"${DB_SCHEMA}"."faturamento_pre_fatura_itens"`)} (id, pre_fatura_id, aba, linha_excel, categoria, descricao, veiculo_modal, svc_continuacao, svc, sigla_base, nome_base, km_range, km_ranger, id_rota, data_inicio, data_fim, placa, motorista, quantidade, preco_unitario, total, tipo_frota, raw) VALUES ${Prisma.join(values)}`);
    }
    await prisma.logAuditoria.create({ data: { usuarioId: req.auth!.userId, acao: "faturamento_pre_fatura_importada", entidade: "faturamento_pre_faturas", entidadeId: preId, detalhes: { tipo, numero: parsed.numero, arquivo: preFile.originalname, linhas: parsed.items.length } } });
    res.status(201).json({ message: "Pré-fatura importada com sucesso.", id: preId, numero: parsed.numero, tipo, totalLinhas: parsed.items.length, totalGeral: totalGeneral });
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "Não foi possível interpretar a pré-fatura." });
  }
});

router.get("/pre-faturas/:id/exportar", requirePermission("faturamento.export"), async (req, res) => {
  const id = req.params.id;
  const rows = await prisma.$queryRawUnsafe<Array<any>>(`SELECT * FROM "${DB_SCHEMA}"."faturamento_pre_fatura_itens" WHERE pre_fatura_id = '${id}' ORDER BY categoria, linha_excel`);
  const pre = await prisma.$queryRawUnsafe<Array<any>>(`SELECT * FROM "${DB_SCHEMA}"."faturamento_pre_faturas" WHERE id = '${id}' LIMIT 1`);
  if (!pre[0]) { res.status(404).json({ message: "Pré-fatura não encontrada." }); return; }
  const workbook = XLSX.utils.book_new();
  const summary = [{ Indicador: "Pré-fatura", Valor: `#${pre[0].numero}` }, { Indicador: "Tipo", Valor: typeLabels[pre[0].tipo as FaturamentoTipo] || pre[0].tipo }, { Indicador: "Total de linhas", Valor: rows.length }, { Indicador: "Total geral", Valor: number(pre[0].total_geral) }];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summary), "Resumo");
  const categories = ["principal", "10pct", "pnrs", "perdidos", "pnrs_bugadas"];
  for (const category of categories) {
    const data = rows.filter((row) => row.categoria === category).map((row) => ({ Aba: row.aba, Linha: row.linha_excel, Base: row.nome_base || row.sigla_base, Motorista: row.motorista, Placa: row.placa, "ID da rota": row.id_rota, Quantidade: number(row.quantidade), "Preço unitário": number(row.preco_unitario), Total: number(row.total), "Data início": row.data_inicio, "Data término": row.data_fim }));
    if (data.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), category.slice(0, 31));
  }
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="faturamento_${safeFilename(pre[0].tipo)}_${safeFilename(pre[0].numero)}.xlsx"`);
  res.send(buffer);
});

export default router;
