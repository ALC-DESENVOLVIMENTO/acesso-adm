import { Router } from "express";
import multer from "multer";
import { requireAdmin, requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { buildStorageObjectUrl, createStorageKey, fetchObjectBuffer, uploadObject } from "../../lib/storage.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage()
});

const DRIVER_REGISTRY_TABLE = "driver_registry_entities";
const DRIVER_REGISTRY_PREFIX = "driver-registry:";
const DRIVER_REGISTRY_SEARCH_LIMIT = 20;
const DRIVER_REGISTRY_NAME_CANDIDATES = [
  "display_name",
  "normalized_name",
  "nome",
  "name",
  "full_name",
  "nome_completo",
  "driver_name",
  "razao_social"
];
const DRIVER_REGISTRY_CPF_CANDIDATES = [
  "cpf",
  "cpf_digits",
  "document_number",
  "documento",
  "documento_numero",
  "cpf_numero",
  "cpf_cnpj"
];
const DRIVER_REGISTRY_BASE_CANDIDATES = ["base", "unidade", "filial", "base_operacional"];
const DRIVER_REGISTRY_SEXO_CANDIDATES = ["sexo", "gender"];
const DRIVER_REGISTRY_PLATE_CANDIDATES = ["placa", "plate", "veiculo_placa", "vehicle_plate"];
const DRIVER_REGISTRY_FAVORED_NAME_CANDIDATES = [
  "nome_favorecido",
  "favorecido_nome",
  "favorecido",
  "beneficiario",
  "beneficiary_name"
];
const DRIVER_REGISTRY_FAVORED_CPF_CANDIDATES = [
  "cpf_favorecido",
  "cpf_do_favorecido",
  "favorecido_cpf",
  "beneficiary_cpf"
];
const DRIVER_REGISTRY_FAVORED_CNPJ_CANDIDATES = [
  "cnpj",
  "cnpj_favorecido",
  "cnpj_do_favorecido",
  "favorecido_cnpj",
  "beneficiary_cnpj"
];
const DRIVER_REGISTRY_FAVORED_EMAIL_CANDIDATES = [
  "email_favorecido",
  "e_mail_favorecido",
  "favorecido_email",
  "beneficiary_email"
];
const DRIVER_REGISTRY_FAVORED_PHONE_CANDIDATES = [
  "telefone_favorecido",
  "telefone_do_favorecido",
  "favorecido_telefone",
  "beneficiary_phone"
];
const DRIVER_REGISTRY_VALIDITY_CANDIDATES = ["validade_gr", "validade", "gr_validade", "gr_expiracao"];
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pdf_aprovado: "PDF aprovado",
  pdf_aguardando_envio: "PDF aguardando envio ao motorista",
  pdf_enviado_ao_motorista: "PDF enviado ao motorista",
  motorista_visualizou: "PDF visualizado",
  aguardando_envio_nota_fiscal: "Aguardando envio da Nota Fiscal",
  nota_fiscal_recebida: "Nota Fiscal recebida",
  nota_fiscal_em_analise: "Nota Fiscal em análise",
  nota_fiscal_aprovada: "Nota Fiscal aprovada",
  nota_fiscal_rejeitada: "Nota Fiscal recusada",
  em_atendimento: "Em atendimento",
  chamado_aberto: "Chamado aberto",
  processo_concluido: "Processo concluído"
};

type DriverRegistryMetadata = {
  schema: string;
  columns: Set<string>;
};

type DriverRegistryRawRow = Record<string, unknown>;

let driverRegistryMetadata: DriverRegistryMetadata | null | undefined;

const DRIVER_STATUS_MAP = {
  ativo: "ativo",
  inativo: "inativo",
  bloqueado: "bloqueado"
} as const;

function isSafeIdentifier(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function stripDiacritics(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function formatCpf(value: string | null) {
  if (!value) {
    return "";
  }

  const cpf = digitsOnly(value);

  if (cpf.length !== 11) {
    return value;
  }

  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

function firstNonEmpty(values: Array<unknown>) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
      continue;
    }

    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return String(value);
    }

    if (value instanceof Date) {
      return value.toISOString();
    }
  }

  return null;
}

function getRecordValue(row: DriverRegistryRawRow, candidates: string[]) {
  const normalized = new Map<string, unknown>();

  for (const [key, value] of Object.entries(row)) {
    normalized.set(key.toLowerCase(), value);
  }

  return firstNonEmpty(
    candidates.flatMap((key) => {
      const value = normalized.get(key.toLowerCase());
      return value === undefined ? [] : [value];
    })
  );
}

function getDateValue(row: DriverRegistryRawRow, candidates: string[]) {
  const value = getRecordValue(row, candidates);

  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString();
  }

  return null;
}

function getDateOnlyValue(row: DriverRegistryRawRow, candidates: string[]) {
  const value = getRecordValue(row, candidates);

  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function formatPaymentStatusLabel(value: string | null | undefined) {
  if (!value) {
    return "Sem status";
  }

  return PAYMENT_STATUS_LABELS[value] || value;
}

async function extractTotalGeralValue(storageKey: string | null | undefined) {
  if (!storageKey) {
    return null;
  }

  const remoteObject = await fetchObjectBuffer(storageKey).catch(() => null);
  if (!remoteObject?.body) {
    return null;
  }

  try {
    const pdfParseModule = await import("pdf-parse");
    const pdfParse = (pdfParseModule as unknown as { default?: (buffer: Buffer) => Promise<{ text: string }> })
      .default ?? (pdfParseModule as unknown as (buffer: Buffer) => Promise<{ text: string }>);
    const parsed = await pdfParse(Buffer.from(remoteObject.body));
    const text = String(parsed.text || "");
    const normalizedText = text.replace(/\s+/g, " ");
    const match =
      /Total Geral\s*[:\-]?\s*R?\$?\s*([\d.]+,\d{2})/i.exec(normalizedText) ||
      /Total\s*Geral\s*[:\-]?\s*([\d.]+,\d{2})/i.exec(normalizedText);

    return match?.[1] ? `R$ ${match[1]}` : null;
  } catch {
    return null;
  }
}

const noteStatuses = new Set([
  "nota_fiscal_recebida",
  "nota_fiscal_em_analise",
  "nota_fiscal_aprovada",
  "nota_fiscal_rejeitada",
  "processo_concluido"
]);

function isNoteStatus(status: string | null | undefined) {
  return Boolean(status && noteStatuses.has(status));
}

function getColumn(metadata: DriverRegistryMetadata, candidates: string[]) {
  for (const candidate of candidates) {
    if (metadata.columns.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return null;
}

function normalizeDriverStatus(rawStatus: string | boolean | null) {
  if (rawStatus === false) {
    return DRIVER_STATUS_MAP.inativo;
  }

  if (rawStatus === true) {
    return DRIVER_STATUS_MAP.ativo;
  }

  if (rawStatus === null || rawStatus === undefined) {
    return DRIVER_STATUS_MAP.ativo;
  }

  const normalized = stripDiacritics(rawStatus.toLowerCase());
  if (normalized.includes("bloq") || normalized.includes("susp") || normalized.includes("ban")) {
    return DRIVER_STATUS_MAP.bloqueado;
  }

  if (normalized.includes("inativ")) {
    return DRIVER_STATUS_MAP.inativo;
  }

  return DRIVER_STATUS_MAP.ativo;
}

async function getDriverRegistryMetadata() {
  if (driverRegistryMetadata !== undefined) {
    return driverRegistryMetadata;
  }

  const tables = await prisma.$queryRaw<
    Array<{
      table_schema: string;
      table_type: string;
    }>
  >`SELECT table_schema, table_type FROM information_schema.tables WHERE table_name = ${DRIVER_REGISTRY_TABLE} AND table_type IN ('BASE TABLE', 'VIEW', 'MATERIALIZED VIEW')`;

  if (tables.length === 0) {
    driverRegistryMetadata = null;
    return null;
  }

  const targetSchema =
    tables.find((row) => row.table_schema === "public")?.table_schema ||
    tables.find((row) => row.table_schema === "portal_administrativo")?.table_schema ||
    tables[0]?.table_schema ||
    null;

  if (!targetSchema) {
    driverRegistryMetadata = null;
    return null;
  }

  const columns = await prisma.$queryRaw<
    Array<{
      column_name: string;
    }>
  >`SELECT column_name FROM information_schema.columns WHERE table_schema = ${targetSchema} AND table_name = ${DRIVER_REGISTRY_TABLE}`;

  driverRegistryMetadata = {
    schema: targetSchema,
    columns: new Set(columns.map((row) => row.column_name.toLowerCase()))
  };

  return driverRegistryMetadata;
}

function quoteDriverRegistryIdentifier(value: string) {
  if (!isSafeIdentifier(value)) {
    throw new Error(`Identificador invalido da tabela driver_registry_entities: ${value}`);
  }

  return `"${value}"`;
}

async function fetchDriverRegistryRows(query: string) {
  const metadata = await getDriverRegistryMetadata();
  if (!metadata) {
    return [];
  }

  const normalizedQuery = normalizeText(query);
  const normalizedDigits = digitsOnly(query);

  if (!normalizedQuery && !normalizedDigits) {
    return [];
  }

  const nameColumn = getColumn(metadata, DRIVER_REGISTRY_NAME_CANDIDATES);
  const cpfColumn = getColumn(metadata, [
    ...DRIVER_REGISTRY_CPF_CANDIDATES,
    "cpf_numero",
    "cpf_cnpj"
  ]);

  const conditions: string[] = [];
  const params: string[] = [];

  if (nameColumn) {
    conditions.push(`COALESCE(${quoteDriverRegistryIdentifier(nameColumn)}, '') ILIKE $${params.length + 1}`);
    params.push(`%${normalizedQuery}%`);
  }

  if (cpfColumn) {
    conditions.push(`COALESCE(${quoteDriverRegistryIdentifier(cpfColumn)}, '') ILIKE $${params.length + 1}`);
    params.push(`%${normalizedQuery}%`);

    if (normalizedDigits) {
      conditions.push(
        `regexp_replace(COALESCE(${quoteDriverRegistryIdentifier(cpfColumn)}, ''), '\\D', '', 'g') ILIKE $${params.length + 1}`
      );
      params.push(`%${normalizedDigits}%`);
    }
  }

  if (conditions.length === 0) {
    return [];
  }

  const tableRef = `${quoteDriverRegistryIdentifier(metadata.schema)}.${quoteDriverRegistryIdentifier(
    DRIVER_REGISTRY_TABLE
  )}`;

  const orderBy = nameColumn ? quoteDriverRegistryIdentifier(nameColumn) : quoteDriverRegistryIdentifier("id");
  const sql = `SELECT * FROM ${tableRef} WHERE ${conditions.join(" OR ")} ORDER BY ${orderBy} ASC LIMIT ${DRIVER_REGISTRY_SEARCH_LIMIT}`;

  return (await prisma.$queryRawUnsafe<DriverRegistryRawRow[]>(sql, ...params)) as DriverRegistryRawRow[];
}

async function fetchDriverRegistryById(id: string) {
  const metadata = await getDriverRegistryMetadata();
  if (!metadata) {
    return null;
  }

  const idColumn = getColumn(metadata, ["id", "uuid", "codigo", "driver_id", "identificador"]);
  if (!idColumn) {
    return null;
  }

  const tableRef = `${quoteDriverRegistryIdentifier(metadata.schema)}.${quoteDriverRegistryIdentifier(
    DRIVER_REGISTRY_TABLE
  )}`;
  const sql = `SELECT * FROM ${tableRef} WHERE ${quoteDriverRegistryIdentifier(idColumn)} = $1 LIMIT 1`;
  const rows = await prisma.$queryRawUnsafe<DriverRegistryRawRow[]>(sql, id);

  return rows[0] || null;
}

async function fetchDriverRegistryByCpfDigits(cpfDigits: string) {
  const normalizedCpf = digitsOnly(cpfDigits);
  if (!normalizedCpf) {
    return null;
  }

  const metadata = await getDriverRegistryMetadata();
  if (!metadata) {
    return null;
  }

  const cpfColumn = getColumn(metadata, ["cpf_digits", "cpf", "document_number", "documento", "documento_numero"]);
  if (!cpfColumn) {
    return null;
  }

  const tableRef = `${quoteDriverRegistryIdentifier(metadata.schema)}.${quoteDriverRegistryIdentifier(
    DRIVER_REGISTRY_TABLE
  )}`;
  const sql = `SELECT * FROM ${tableRef} WHERE ${quoteDriverRegistryIdentifier(cpfColumn)} = $1 OR regexp_replace(COALESCE(${quoteDriverRegistryIdentifier(
    getColumn(metadata, ["cpf"]) || cpfColumn
  )}, ''), '\\D', '', 'g') = $1 LIMIT 1`;
  const rows = await prisma.$queryRawUnsafe<DriverRegistryRawRow[]>(sql, normalizedCpf);

  return rows[0] || null;
}

function driverRegistryAsAtendimentoPayload(row: DriverRegistryRawRow) {
  const metadata = {
    id: getRecordValue(row, ["id", "uuid", "codigo", "driver_id", "identificador"]),
    base: getRecordValue(row, DRIVER_REGISTRY_BASE_CANDIDATES),
    name: getRecordValue(row, ["display_name", "normalized_name", "nome", "name", "full_name", "nome_completo", "driver_name", "razao_social"]),
    cpf: getRecordValue(row, [...DRIVER_REGISTRY_CPF_CANDIDATES, "documento", "document_number", "documento_numero"]),
    rg: getRecordValue(row, ["rg", "registro_geral", "rg_numero"]),
    sexo: getRecordValue(row, DRIVER_REGISTRY_SEXO_CANDIDATES),
    placa: getRecordValue(row, DRIVER_REGISTRY_PLATE_CANDIDATES),
    city: getRecordValue(row, ["cidade", "municipio", "city"]),
    state: getRecordValue(row, ["estado", "uf", "state"]),
    company: getRecordValue(row, ["empresa_vinculada", "empresa", "company", "company_name"]),
    observacoes: getRecordValue(row, ["observacoes_gerais", "observacao_geral", "observacoes", "observacao"]),
    favorecidoNome: getRecordValue(row, DRIVER_REGISTRY_FAVORED_NAME_CANDIDATES),
    favorecidoCpf: getRecordValue(row, DRIVER_REGISTRY_FAVORED_CPF_CANDIDATES),
    favorecidoCpfDigits: digitsOnly(getRecordValue(row, DRIVER_REGISTRY_FAVORED_CPF_CANDIDATES) || ""),
    favorecidoCnpj: getRecordValue(row, DRIVER_REGISTRY_FAVORED_CNPJ_CANDIDATES),
    favorecidoEmail: getRecordValue(row, DRIVER_REGISTRY_FAVORED_EMAIL_CANDIDATES),
    favorecidoTelefone: getRecordValue(row, DRIVER_REGISTRY_FAVORED_PHONE_CANDIDATES),
    validadeGr: getDateOnlyValue(row, DRIVER_REGISTRY_VALIDITY_CANDIDATES)
  };

  const rawStatus = getRecordValue(row, ["status", "status_cadastro", "statusCadastro", "situacao", "ativo", "active"]);

  return {
    externalId: String(metadata.id || ""),
    nome: metadata.name || "Sem nome",
    cpf: metadata.cpf || "",
    cpfFormatado: formatCpf(metadata.cpf),
    rg: metadata.rg,
    base: metadata.base,
    sexo: metadata.sexo,
    placa: metadata.placa,
    telefone: getRecordValue(row, ["telefone", "telefone_contato", "fone", "phone"]),
    whatsapp: getRecordValue(row, ["whatsapp", "wpp", "telefone_whatsapp"]),
    email: getRecordValue(row, ["email", "e_mail"]),
    endereco: getRecordValue(row, ["endereco", "address", "logradouro"]),
    cidade: metadata.city,
    estado: metadata.state,
    cep: getRecordValue(row, ["cep", "cep_numero"]),
    statusCadastro: normalizeDriverStatus((rawStatus as string | boolean | null) ?? null),
    empresaVinculada: metadata.company,
    observacoesGerais: metadata.observacoes,
    dataNascimento: getDateValue(row, ["data_nascimento", "dt_nascimento", "nascimento", "birth_date"]),
    favorecidoNome: metadata.favorecidoNome,
    favorecidoCpf: metadata.favorecidoCpf,
    favorecidoCpfDigits: metadata.favorecidoCpfDigits,
    favorecidoCnpj: metadata.favorecidoCnpj,
    favorecidoEmail: metadata.favorecidoEmail,
    favorecidoTelefone: metadata.favorecidoTelefone,
    validadeGr: metadata.validadeGr
  };
}

function mapDriverRegistryForSearch(row: DriverRegistryRawRow, localDriver?: { id: string; statusCadastro: string }) {
  const mapped = driverRegistryAsAtendimentoPayload(row);

  return {
    id: localDriver?.id || `${DRIVER_REGISTRY_PREFIX}${mapped.externalId}`,
    name: mapped.nome,
    cpf: mapped.cpfFormatado || mapped.cpf || "",
    status: localDriver?.statusCadastro || mapped.statusCadastro,
    base: mapped.base,
    city: mapped.cidade,
    state: mapped.estado,
    company: mapped.empresaVinculada,
    classifiedAs: [],
    totalPdfs: 0,
    totalChamados: 0
  };
}

async function getOrCreateMotoristaFromRegistry(id: string) {
  const row = await fetchDriverRegistryById(id);
  if (!row) {
    return null;
  }

  const mapped = driverRegistryAsAtendimentoPayload(row);
  const normalizedCpf = digitsOnly(mapped.cpf || "");

  if (!normalizedCpf) {
    return null;
  }

  const existing = await prisma.motorista.findUnique({
    where: {
      cpf: normalizedCpf
    },
    select: {
      id: true
    }
  });

  if (existing?.id) {
    return existing.id;
  }

  const created = await prisma.motorista.create({
    data: {
      nome: mapped.nome,
      cpf: normalizedCpf,
      rg: mapped.rg,
      dataNascimento: mapped.dataNascimento ? new Date(mapped.dataNascimento) : null,
      telefone: mapped.telefone,
      whatsapp: mapped.whatsapp,
      email: mapped.email,
      endereco: mapped.endereco,
      cidade: mapped.cidade,
      estado: mapped.estado,
      cep: mapped.cep,
      statusCadastro: mapped.statusCadastro,
      empresaVinculada: mapped.empresaVinculada,
      observacoesGerais: mapped.observacoesGerais
    }
  });

  return created.id;
}

async function resolveMotoristaId(rawId: string) {
  const inputId = rawId.startsWith(DRIVER_REGISTRY_PREFIX)
    ? rawId.slice(DRIVER_REGISTRY_PREFIX.length)
    : rawId;

  const direct = await prisma.motorista.findUnique({
    where: {
      id: inputId
    },
    select: {
      id: true
    }
  });

  if (direct?.id) {
    return direct.id;
  }

  const syncedFromRegistry = await getOrCreateMotoristaFromRegistry(inputId);
  return syncedFromRegistry;
}

router.use(requireAuth, requireModuleAccess("atendimento"));

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function routeParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }

  return String(value || "").trim();
}

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return {
    iso: date.toISOString(),
    date: date.toLocaleDateString("pt-BR"),
    time: date.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit"
    })
  };
}

function toAttachmentPayload(attachment: {
  id: string;
  nomeOriginal: string;
  caminhoArquivo: string;
  criadoEm: Date;
}) {
  return {
    id: attachment.id,
    fileName: attachment.nomeOriginal,
    storageFileName: attachment.caminhoArquivo.split("/").pop() || attachment.nomeOriginal,
    downloadUrl: buildStorageObjectUrl(attachment.caminhoArquivo),
    createdAt: attachment.criadoEm
  };
}

function buildTimeline(
  motorista: {
    uploads: Array<{
      id: string;
      nomeOriginal: string;
      status: string;
      criadoEm: Date;
      usuario: { nome: string };
      periodoPagamento?: { nome: string } | null;
      basePagamento?: { nome: string } | null;
    }>;
    atendimentos: Array<{
      id: string;
      dataHora: Date;
      canal: string;
      resumo: string;
      observacoes: string | null;
      tempoMinutos: number | null;
      atendente: { nome: string };
    }>;
    chamados: Array<{
      id: string;
      abertoEm: Date;
      atualizadoEm: Date;
      encerradoEm: Date | null;
      titulo: string;
      assunto: string | null;
      status: string;
      prioridade: string;
      responsavel: { nome: string } | null;
      historicos: Array<{
        id: string;
        criadoEm: Date;
        descricao: string;
        usuario: { nome: string };
      }>;
    }>;
    notas: Array<{
      id: string;
      criadoEm: Date;
      conteudo: string;
      usuario: { nome: string };
    }>;
    logs: Array<{
      id: string;
      criadoEm: Date;
      acao: string;
      entidade: string;
      detalhes: unknown;
      usuario: { nome: string } | null;
    }>;
  }
) {
  const events = [
    ...motorista.uploads.map((upload) => ({
      id: `upload-${upload.id}`,
      type: "upload",
      title: `PDF anexado: ${upload.nomeOriginal}`,
      subtitle: `${upload.usuario.nome} · ${upload.periodoPagamento?.nome || "Sem periodo"}`,
      status: upload.status,
      at: upload.criadoEm
    })),
    ...motorista.atendimentos.map((item) => ({
      id: `atendimento-${item.id}`,
      type: "atendimento",
      title: `Atendimento via ${item.canal}`,
      subtitle: `${item.resumo} · ${item.atendente.nome}`,
      status: item.tempoMinutos ? `${item.tempoMinutos} min` : "Em andamento",
      at: item.dataHora
    })),
    ...motorista.chamados.flatMap((ticket) => [
      {
        id: `chamado-${ticket.id}`,
        type: "chamado",
        title: `Chamado aberto: ${ticket.assunto || ticket.titulo}`,
        subtitle: `${ticket.prioridade} · ${ticket.status}`,
        status: ticket.status,
        at: ticket.abertoEm
      },
      ...ticket.historicos.map((history) => ({
        id: `chamado-historico-${history.id}`,
        type: "chamado",
        title: `Movimentacao do chamado`,
        subtitle: `${history.usuario.nome} · ${history.descricao}`,
        status: ticket.status,
        at: history.criadoEm
      })),
      ...(ticket.encerradoEm
        ? [
            {
              id: `chamado-close-${ticket.id}`,
              type: "chamado",
              title: `Chamado encerrado: ${ticket.assunto || ticket.titulo}`,
              subtitle: ticket.responsavel?.nome || "Sem responsavel",
              status: ticket.status,
              at: ticket.encerradoEm
            }
          ]
        : [])
    ]),
    ...motorista.notas.map((note) => ({
      id: `nota-${note.id}`,
      type: "nota",
      title: "Nota interna registrada",
      subtitle: `${note.usuario.nome} · ${note.conteudo}`,
      status: "nota",
      at: note.criadoEm
    })),
    ...motorista.logs.map((log) => ({
      id: `log-${log.id}`,
      type: "log",
      title: `Log: ${log.acao}`,
      subtitle: `${log.usuario?.nome || "Sistema"} · ${log.entidade}`,
      status: "log",
      at: log.criadoEm
    }))
  ];

  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).map((event) => ({
    ...event,
    ...formatDateTime(event.at)
  }));
}

async function loadMotoristaDetail(motoristaId: string) {
  const resolvedMotoristaId = await resolveMotoristaId(motoristaId);
  if (!resolvedMotoristaId) {
    return null;
  }

  const motorista = await prisma.motorista.findUnique({
    where: {
      id: resolvedMotoristaId
    },
    include: {
      uploads: {
        include: {
          usuario: {
            select: {
              nome: true
            }
          },
          periodoPagamento: {
            select: {
              nome: true
            }
          },
          basePagamento: {
            select: {
              nome: true
            }
          }
        },
        orderBy: {
          criadoEm: "desc"
        }
      },
      atendimentos: {
        include: {
          atendente: {
            select: {
              nome: true
            }
          }
        },
        orderBy: {
          dataHora: "desc"
        }
      },
      chamados: {
        include: {
          responsavel: {
            select: {
              nome: true
            }
          },
          historicos: {
            include: {
              usuario: {
                select: {
                  nome: true
                }
              }
            },
            orderBy: {
              criadoEm: "desc"
            }
          },
          anexos: true
        },
        orderBy: {
          atualizadoEm: "desc"
        }
      },
      notas: {
        include: {
          usuario: {
            select: {
              nome: true
            }
          }
        },
        orderBy: {
          criadoEm: "desc"
        }
      },
      classificacoes: {
        include: {
          classificacao: true
        },
        orderBy: {
          criadoEm: "desc"
        }
      },
      logs: {
        include: {
          usuario: {
            select: {
              nome: true
            }
          }
        },
        orderBy: {
          criadoEm: "desc"
        }
      }
    }
  });

  if (!motorista) {
    return null;
  }

  const registryRow = await fetchDriverRegistryByCpfDigits(motorista.cpf).catch(() => null);
  const registryData = registryRow ? driverRegistryAsAtendimentoPayload(registryRow) : null;
  const paymentReceipts = await prisma.driverPdfReceived.findMany({
    where: {
      motoristaId: motorista.id
    },
    select: {
      id: true,
      uploadPdfId: true,
      motoristaId: true,
      periodoPagamentoId: true,
      basePagamentoId: true,
      status: true,
      uploadEm: true,
      enviadoAoMotoristaEm: true,
      visualizadoEm: true,
      aprovadoEm: true,
      rejeitadoEm: true,
      caminhoArquivo: true,
      nomeArquivo: true
    },
    orderBy: {
      uploadEm: "desc"
    }
  });
  const paymentHistoryByKey = new Map<string, (typeof motorista.uploads)[number]>();
  for (const upload of motorista.uploads
    .slice()
    .sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime())) {
    if (!upload.periodoPagamentoId || !upload.basePagamentoId) {
      continue;
    }

    const key = `${upload.periodoPagamentoId}|${upload.basePagamentoId}`;
    if (!paymentHistoryByKey.has(key)) {
      paymentHistoryByKey.set(key, upload);
    }
  }

  const paymentHistory = await Promise.all(
    Array.from(paymentHistoryByKey.values()).map(async (upload) => {
      const receipt =
        paymentReceipts.find((item) => item.uploadPdfId && item.uploadPdfId === upload.id && isNoteStatus(item.status)) ||
        paymentReceipts.find(
          (item) =>
            item.uploadPdfId &&
            item.uploadPdfId === upload.id
        ) ||
        paymentReceipts.find(
          (item) =>
            item.motoristaId === motorista.id &&
            item.periodoPagamentoId === upload.periodoPagamentoId &&
            item.basePagamentoId === upload.basePagamentoId &&
            isNoteStatus(item.status)
        ) ||
        paymentReceipts.find(
          (item) =>
            item.motoristaId === motorista.id &&
            item.periodoPagamentoId === upload.periodoPagamentoId &&
            item.basePagamentoId === upload.basePagamentoId
        ) ||
        null;
      const period = upload.periodoPagamento || null;
      const base = upload.basePagamento || null;
      const pdfSentAt = receipt?.enviadoAoMotoristaEm || upload.criadoEm;
      const pdfViewedAt = receipt?.visualizadoEm || null;
      const noteSentAt = isNoteStatus(receipt?.status) ? receipt?.uploadEm || null : null;
      const noteReceivedAt = isNoteStatus(receipt?.status) ? receipt?.aprovadoEm || receipt?.rejeitadoEm || null : null;
      const noteStatus = isNoteStatus(receipt?.status) ? receipt!.status : "aguardando_envio_nota_fiscal";
      const currentStatus =
        isNoteStatus(receipt?.status) && receipt?.status === "nota_fiscal_aprovada"
          ? "processo_concluido"
          : isNoteStatus(receipt?.status)
            ? receipt?.status || "aguardando_envio_nota_fiscal"
            : pdfViewedAt
              ? "motorista_visualizou"
              : pdfSentAt
                ? "pdf_enviado_ao_motorista"
                : "pdf_aguardando_envio";
      const paid = currentStatus === "processo_concluido";
      const valorPagamento = await extractTotalGeralValue(upload.caminhoArquivo).catch(() => null);

      return {
        id: receipt?.id || upload.id,
        periodoPagamentoId: upload.periodoPagamentoId || receipt?.periodoPagamentoId || null,
        periodoPagamento: period?.nome || null,
        basePagamentoId: upload.basePagamentoId || receipt?.basePagamentoId || null,
        basePagamento: base?.nome || null,
        dataPagamento: null,
        valorPagamento,
        statusProcesso: formatPaymentStatusLabel(currentStatus),
        pdfStatus: formatPaymentStatusLabel(currentStatus),
        pdfEnviadoEm: toIso(pdfSentAt),
        pdfVisualizadoEm: toIso(pdfViewedAt),
        notaFiscalStatus: formatPaymentStatusLabel(noteStatus),
        notaFiscalEnviadaEm: noteSentAt ? toIso(noteSentAt) : null,
        notaFiscalRecebidaEm: noteReceivedAt ? toIso(noteReceivedAt) : null,
        pago: paid,
        atualizadoEm: toIso(noteReceivedAt || pdfViewedAt || pdfSentAt || receipt?.uploadEm || upload.criadoEm),
        pdfDownloadUrl: upload.caminhoArquivo ? buildStorageObjectUrl(upload.caminhoArquivo) : null,
        notaFiscalDownloadUrl:
          isNoteStatus(receipt?.status) && receipt?.id
            ? `/api/financeiro/driver-pdfs/${receipt.id}/content`
            : null
      };
    })
  );

  return {
    motorista: {
      id: motorista.id,
      nome: motorista.nome,
      cpf: motorista.cpf,
      rg: motorista.rg,
      dataNascimento: motorista.dataNascimento,
      telefone: motorista.telefone,
      whatsapp: motorista.whatsapp,
      email: motorista.email,
      endereco: motorista.endereco,
      cidade: motorista.cidade,
      estado: motorista.estado,
      cep: motorista.cep,
      statusCadastro: motorista.statusCadastro,
      dataCriacao: motorista.criadoEm,
      ultimaAtualizacao: motorista.atualizadoEm,
      empresaVinculada: motorista.empresaVinculada,
      base: registryData?.base || null,
      nomeFavorecido: registryData?.favorecidoNome || null,
      cpfFavorecido: registryData?.favorecidoCpf || null,
      cnpjFavorecido: registryData?.favorecidoCnpj || null,
      observacoesGerais: motorista.observacoesGerais,
      classificacoes: motorista.classificacoes.map((item) => ({
        id: item.classificacao.id,
        name: item.classificacao.nome,
        description: item.classificacao.descricao,
        active: item.classificacao.ativa
      }))
    },
    historicoPagamentos: paymentHistory,
    pdfs: motorista.uploads.map((upload) => ({
      id: upload.id,
      nomeDocumento: upload.nomeOriginal,
      tipo: upload.basePagamento?.nome || "PDF",
      dataEnvio: upload.criadoEm,
      dataAprovacao: null,
      status: upload.status,
      usuarioResponsavel: upload.usuario.nome,
      periodName: upload.periodoPagamento?.nome || null,
      baseName: upload.basePagamento?.nome || null,
      downloadUrl: buildStorageObjectUrl(upload.caminhoArquivo),
    })),
    atendimentos: motorista.atendimentos.map((item) => ({
      id: item.id,
      dataHora: item.dataHora,
      atendente: item.atendente.nome,
      canal: item.canal,
      resumo: item.resumo,
      observacoes: item.observacoes,
      tempoAtendimento: item.tempoMinutos
    })),
    chamados: motorista.chamados.map((ticket) => ({
      id: ticket.id,
      numero: ticket.id.slice(0, 8).toUpperCase(),
      assunto: ticket.assunto || ticket.titulo,
      titulo: ticket.titulo,
      categoria: ticket.categoria || "Geral",
      prioridade: ticket.prioridade,
      status: ticket.status,
      responsavel: ticket.responsavel?.nome || null,
      dataAbertura: ticket.abertoEm,
      ultimaAtualizacao: ticket.atualizadoEm,
      encerradoEm: ticket.encerradoEm,
      motivoConclusao: ticket.motivoConclusao,
      solucaoAplicada: ticket.solucaoAplicada,
      observacoesFinais: ticket.observacoesFinais,
      historico: ticket.historicos.map((entry) => ({
        id: entry.id,
        dataHora: entry.criadoEm,
        usuario: entry.usuario.nome,
        descricao: entry.descricao
      })),
      anexos: ticket.anexos.map(toAttachmentPayload)
    })),
    notas: motorista.notas.map((note) => ({
      id: note.id,
      conteudo: note.conteudo,
      usuario: note.usuario.nome,
      dataHora: note.criadoEm
    })),
    timeline: buildTimeline(motorista),
    logs: motorista.logs.map((log) => ({
      id: log.id,
      acao: log.acao,
      entidade: log.entidade,
      entidadeId: log.entidadeId,
      detalhes: log.detalhes,
      usuario: log.usuario?.nome || "Sistema",
      dataHora: log.criadoEm
    }))
  };
}

router.get("/classificacoes", (_req, res) => {
  void (async () => {
    const classificacoes = await prisma.classificacaoMotorista.findMany({
      where: {
        ativa: true
      },
      orderBy: {
        nome: "asc"
      }
    });

    res.json(
      classificacoes.map((item) => ({
        id: item.id,
        name: item.nome,
        description: item.descricao,
        active: item.ativa
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar classificacoes.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/classificacoes", requireAdmin, (req, res) => {
  void (async () => {
    const body = req.body as Record<string, unknown>;
    const nome = String(body.name || "").trim();
    const descricao = String(body.description || "").trim() || null;

    if (!nome) {
      res.status(400).json({
        message: "Informe um nome para a classificacao."
      });
      return;
    }

    const classificacao = await prisma.classificacaoMotorista.upsert({
      where: {
        nome
      },
      update: {
        ativa: true,
        descricao: descricao || undefined
      },
      create: {
        nome,
        descricao
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth?.userId || null,
        acao: "criar_classificacao",
        entidade: "classificacoes_motorista",
        entidadeId: classificacao.id,
        detalhes: {
          nome,
          descricao
        }
      }
    });

    res.status(201).json({
      message: "Classificacao criada com sucesso.",
      classificacao: {
        id: classificacao.id,
        name: classificacao.nome,
        description: classificacao.descricao,
        active: classificacao.ativa
      }
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar classificacao.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/motoristas/search", (_req, res) => {
  void (async () => {
    const query = normalizeText(String(_req.query.q || "").trim());
    const digits = digitsOnly(query);

    if (!query && !digits) {
      res.json([]);
      return;
    }

    let registryRows: DriverRegistryRawRow[] = [];
    try {
      registryRows = await fetchDriverRegistryRows(query);
    } catch (error) {
      registryRows = [];
    }
    const localCpfMap = new Map<
      string,
      {
        id: string;
        statusCadastro: "ativo" | "inativo" | "bloqueado";
        cidade: string | null;
        estado: string | null;
        empresaVinculada: string | null;
        classificacoes: Array<{ classificacao: { nome: string } }>;
        uploads: Array<{ id: string }>;
        chamados: Array<{ id: string }>;
      }
    >();

    const mappedRows = registryRows
      .map((row) => driverRegistryAsAtendimentoPayload(row))
      .filter((row) => Boolean(row.externalId));

    const cpfs = Array.from(new Set(mappedRows.map((row) => digitsOnly(row.cpf || "")).filter(Boolean)));
    const localMotoristas = cpfs.length > 0
      ? await prisma.motorista.findMany({
          where: {
            cpf: {
              in: cpfs
            }
          },
          include: {
            classificacoes: {
              include: {
                classificacao: true
              }
            },
            uploads: {
              select: {
                id: true
              }
            },
            chamados: {
              select: {
                id: true
              }
            }
          }
        })
      : [];

    for (const motorista of localMotoristas) {
      localCpfMap.set(digitsOnly(motorista.cpf), motorista);
    }

    const registryResults = mappedRows.map((driver) => {
      const driverCpf = digitsOnly(driver.cpf || "");
      const matchedLocal = localCpfMap.get(driverCpf);

      return {
        id: matchedLocal?.id || `${DRIVER_REGISTRY_PREFIX}${driver.externalId}`,
        name: driver.nome,
        cpf: driver.cpfFormatado || driver.cpf || "",
        status: matchedLocal?.statusCadastro || driver.statusCadastro,
        city: driver.cidade || matchedLocal?.cidade || null,
        state: driver.estado || matchedLocal?.estado || null,
        company: driver.empresaVinculada || matchedLocal?.empresaVinculada || null,
        classifiedAs: matchedLocal ? matchedLocal.classificacoes.map((item) => item.classificacao.nome) : [],
        totalPdfs: matchedLocal?.uploads.length || 0,
        totalChamados: matchedLocal?.chamados.length || 0
      };
    });

    if (registryResults.length > 0) {
      res.json(registryResults);
      return;
    }

    const motoristas = await prisma.motorista.findMany({
      where: query
        ? {
            OR: [
              {
                nome: {
                  contains: query,
                  mode: "insensitive"
                }
              },
              {
                cpf: {
                  contains: query
                }
              },
              ...(digits
                ? [
                    {
                      cpf: {
                        contains: digits
                      }
                    }
                  ]
                : [])
            ]
          }
        : undefined,
      orderBy: {
        nome: "asc"
      },
      take: DRIVER_REGISTRY_SEARCH_LIMIT,
      include: {
        classificacoes: {
          include: {
            classificacao: true
          }
        },
        uploads: {
          select: {
            id: true
          }
        },
        chamados: {
          select: {
            id: true
          }
        }
      }
    });

    res.json(
      motoristas.map((motorista) => ({
        id: motorista.id,
        name: motorista.nome,
        cpf: motorista.cpf,
        status: motorista.statusCadastro,
        base: null,
        city: motorista.cidade,
        state: motorista.estado,
        company: motorista.empresaVinculada,
        classifiedAs: motorista.classificacoes.map((item) => item.classificacao.nome),
        totalPdfs: motorista.uploads.length,
        totalChamados: motorista.chamados.length
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao localizar motorista.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/motoristas/:id", (req, res) => {
  void (async () => {
    const motoristaId = routeParam(req.params.id);
    const detail = await loadMotoristaDetail(motoristaId);

    if (!detail) {
      res.status(404).json({
        message: "Motorista nao encontrado."
      });
      return;
    }

    res.json(detail);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar motorista.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/motoristas/:id", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = await resolveMotoristaId(routeParam(req.params.id));
    if (!motoristaId) {
      res.status(404).json({ message: "Motorista nao encontrado." });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const nome = String(body.nome || "").trim();
    const cpf = digitsOnly(String(body.cpf || "").trim());
    const rg = String(body.rg || "").trim() || null;
    const dataNascimentoRaw = String(body.dataNascimento || "").trim();
    const telefone = String(body.telefone || "").trim() || null;
    const whatsapp = String(body.whatsapp || "").trim() || null;
    const email = String(body.email || "").trim() || null;
    const endereco = String(body.endereco || "").trim() || null;
    const cidade = String(body.cidade || "").trim() || null;
    const estado = String(body.estado || "").trim() || null;
    const cep = String(body.cep || "").trim() || null;
    const statusCadastroRaw = String(body.statusCadastro || "").trim();
    const empresaVinculada = String(body.empresaVinculada || "").trim() || null;
    const observacoesGerais = String(body.observacoesGerais || "").trim() || null;

    if (!nome || !cpf) {
      res.status(400).json({
        message: "Informe nome e CPF do motorista."
      });
      return;
    }

    const statusCadastro = ["ativo", "inativo", "bloqueado"].includes(statusCadastroRaw)
      ? (statusCadastroRaw as "ativo" | "inativo" | "bloqueado")
      : null;

    if (!statusCadastro) {
      res.status(400).json({
        message: "Informe um status valido para o motorista."
      });
      return;
    }

    const updated = await prisma.motorista.update({
      where: {
        id: motoristaId
      },
      data: {
        nome,
        cpf,
        rg,
        dataNascimento: dataNascimentoRaw ? new Date(dataNascimentoRaw) : null,
        telefone,
        whatsapp,
        email,
        endereco,
        cidade,
        estado,
        cep,
        statusCadastro,
        empresaVinculada,
        observacoesGerais
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId: updated.id,
        acao: "editar_motorista",
        entidade: "motoristas",
        entidadeId: updated.id,
        detalhes: {
          nome,
          cpf,
          rg,
          dataNascimento: dataNascimentoRaw || null,
          telefone,
          whatsapp,
          email,
          endereco,
          cidade,
          estado,
          cep,
          statusCadastro,
          empresaVinculada,
          observacoesGerais
        }
      }
    });

    const detail = await loadMotoristaDetail(updated.id);

    res.json({
      message: "Motorista atualizado com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar motorista.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/motoristas/:id/classificacoes", (req, res) => {
  void (async () => {
    const motoristaId = await resolveMotoristaId(routeParam(req.params.id));
    if (!motoristaId) {
      res.status(404).json({ message: "Motorista nao encontrado." });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const classificacaoIds = Array.isArray(body.classificacaoIds)
      ? body.classificacaoIds.map((value: unknown) => String(value))
      : [];

    await prisma.motoristaClassificacao.deleteMany({
      where: {
        motoristaId
      }
    });

    await prisma.motoristaClassificacao.createMany({
      data: classificacaoIds.map((classificacaoId: string) => ({
        motoristaId,
        classificacaoId
      }))
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth?.userId || null,
        motoristaId,
        acao: "alterar_classificacao_motorista",
        entidade: "motoristas",
        entidadeId: motoristaId,
        detalhes: {
          classificacaoIds
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.json({
      message: "Classificacoes atualizadas.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar classificacoes.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/motoristas/:id/notas", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = await resolveMotoristaId(routeParam(req.params.id));
    if (!motoristaId) {
      res.status(404).json({ message: "Motorista nao encontrado." });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const content = String(body.content || "").trim();

    if (!content) {
      res.status(400).json({
        message: "Informe o conteudo da nota."
      });
      return;
    }

    const note = await prisma.notaAtendimento.create({
      data: {
        motoristaId,
        usuarioId: req.auth.userId,
        conteudo: content
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        acao: "criar_nota_atendimento",
        entidade: "notas_atendimento",
        entidadeId: note.id,
        detalhes: {
          content
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.status(201).json({
      message: "Nota salva com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao salvar nota.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/motoristas/:id/notas/:notaId", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = await resolveMotoristaId(routeParam(req.params.id));
    if (!motoristaId) {
      res.status(404).json({ message: "Motorista nao encontrado." });
      return;
    }
    const notaId = routeParam(req.params.notaId);
    const body = req.body as Record<string, unknown>;
    const content = String(body.content || "").trim();

    if (!content) {
      res.status(400).json({
        message: "Informe o conteudo da nota."
      });
      return;
    }

    const note = await prisma.notaAtendimento.update({
      where: {
        id: notaId
      },
      data: {
        conteudo: content
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        acao: "editar_nota_atendimento",
        entidade: "notas_atendimento",
        entidadeId: note.id,
        detalhes: {
          content
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.json({
      message: "Nota atualizada com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar nota.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.delete("/motoristas/:id/notas/:notaId", requireAdmin, (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = await resolveMotoristaId(routeParam(req.params.id));
    if (!motoristaId) {
      res.status(404).json({ message: "Motorista nao encontrado." });
      return;
    }
    const notaId = routeParam(req.params.notaId);
    await prisma.notaAtendimento.delete({
      where: {
        id: notaId
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        acao: "excluir_nota_atendimento",
        entidade: "notas_atendimento",
        entidadeId: notaId
      }
    });

    res.json({
      message: "Nota removida com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao excluir nota.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/motoristas/:id/atendimentos", upload.array("attachments", 6), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = await resolveMotoristaId(routeParam(req.params.id));
    if (!motoristaId) {
      res.status(404).json({ message: "Motorista nao encontrado." });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const resumo = String(body.resumo || "").trim();
    const observacoes = String(body.observacoes || "").trim() || null;
    const canal = String(body.canal || "chat").trim();
    const tempoMinutos = Number(String(body.tempoMinutos || "").trim() || "0") || null;
    const files = (req.files as Express.Multer.File[]) || [];

    if (!resumo) {
      res.status(400).json({
        message: "Informe um resumo para o atendimento."
      });
      return;
    }

    const atendimento = await prisma.atendimento.create({
      data: {
        motoristaId,
        atendenteId: req.auth.userId,
        canal: canal as never,
        resumo,
        observacoes,
        tempoMinutos
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        acao: "criar_atendimento",
        entidade: "atendimentos",
        entidadeId: atendimento.id,
        detalhes: {
          resumo,
          canal,
          anexos: files.length
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.status(201).json({
      message: "Atendimento registrado com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao registrar atendimento.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/motoristas/:id/chamados", upload.array("attachments", 10), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const motoristaId = await resolveMotoristaId(routeParam(req.params.id));
    if (!motoristaId) {
      res.status(404).json({ message: "Motorista nao encontrado." });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const assunto = String(body.assunto || "").trim();
    const categoria = String(body.categoria || "").trim();
    const prioridade = String(body.prioridade || "media").trim();
    const descricao = String(body.descricao || "").trim();
    const responsavelId = String(body.responsavelId || req.auth.userId).trim() || req.auth.userId;
    const files = (req.files as Express.Multer.File[]) || [];

    if (!assunto || !categoria || !descricao) {
      res.status(400).json({
        message: "Preencha assunto, categoria e descricao."
      });
      return;
    }

    const sequence = String(Date.now()).slice(-6);
    const chamado = await prisma.chamado.create({
      data: {
        motoristaId,
        titulo: assunto,
        assunto,
        categoria,
        prioridade: prioridade as never,
        descricao,
        status: "aberto",
        solicitanteId: req.auth.userId,
        responsavelId,
        abertoEm: new Date()
      }
    });

    if (files.length > 0) {
      await prisma.anexoChamado.createMany({
        data: await Promise.all(
          files.map(async (file) => {
            const key = createStorageKey("atendimento", file.originalname);
            await uploadObject({
              key,
              body: file.buffer,
              contentType: file.mimetype
            });

            return {
              chamadoId: chamado.id,
              nomeArquivo: file.originalname,
              nomeOriginal: file.originalname,
              caminhoArquivo: key
            };
          })
        )
      });
    }

    await prisma.historicoChamado.create({
      data: {
        chamadoId: chamado.id,
        usuarioId: req.auth.userId,
        descricao: `Chamado ${sequence} criado.`
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId,
        chamadoId: chamado.id,
        acao: "criar_chamado",
        entidade: "chamados",
        entidadeId: chamado.id,
        detalhes: {
          assunto,
          categoria,
          prioridade,
          responsavelId,
          anexos: files.length
        }
      }
    });

    const detail = await loadMotoristaDetail(motoristaId);

    res.status(201).json({
      message: "Chamado criado com sucesso.",
      detail
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar chamado.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/chamados/:id/movimentos", upload.array("attachments", 10), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const chamadoId = routeParam(req.params.id);
    const body = req.body as Record<string, unknown>;
    const descricao = String(body.description || body.descricao || "").trim();
    const files = (req.files as Express.Multer.File[]) || [];

    if (!descricao) {
      res.status(400).json({
        message: "Informe a movimentacao do chamado."
      });
      return;
    }

    const chamado = await prisma.chamado.findUnique({
      where: {
        id: chamadoId
      }
    });

    if (!chamado) {
      res.status(404).json({
        message: "Chamado nao encontrado."
      });
      return;
    }

    const history = await prisma.historicoChamado.create({
      data: {
        chamadoId: chamado.id,
        usuarioId: req.auth.userId,
        descricao
      }
    });

    if (files.length > 0) {
      await prisma.anexoChamado.createMany({
        data: await Promise.all(
          files.map(async (file) => {
            const key = createStorageKey("atendimento", file.originalname);
            await uploadObject({
              key,
              body: file.buffer,
              contentType: file.mimetype
            });

            return {
              chamadoId: chamado.id,
              historicoChamadoId: history.id,
              nomeArquivo: file.originalname,
              nomeOriginal: file.originalname,
              caminhoArquivo: key
            };
          })
        )
      });
    }

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId: chamado.motoristaId,
        chamadoId: chamado.id,
        acao: "atualizar_chamado",
        entidade: "historico_chamados",
        entidadeId: history.id,
        detalhes: {
          descricao,
          anexos: files.length
        }
      }
    });

    res.status(201).json({
      message: "Movimentacao registrada."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao registrar movimentacao.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/chamados/:id/encerrar", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({ message: "Sessao invalida." });
      return;
    }

    const chamadoId = routeParam(req.params.id);
    const body = req.body as Record<string, unknown>;
    const motivoConclusao = String(body.motivoConclusao || "").trim();
    const solucaoAplicada = String(body.solucaoAplicada || "").trim();
    const observacoesFinais = String(body.observacoesFinais || "").trim();

    const chamado = await prisma.chamado.findUnique({
      where: {
        id: chamadoId
      }
    });

    if (!chamado) {
      res.status(404).json({
        message: "Chamado nao encontrado."
      });
      return;
    }

    const abertoEm = chamado.abertoEm || chamado.criadoEm;
    const tempoTotalMinutos = Math.max(
      1,
      Math.round((Date.now() - new Date(abertoEm).getTime()) / 60000)
    );

    await prisma.chamado.update({
      where: {
        id: chamado.id
      },
      data: {
        status: "concluido",
        encerradoEm: new Date(),
        motivoConclusao,
        solucaoAplicada,
        observacoesFinais,
        tempoTotalMinutos
      }
    });

    await prisma.historicoChamado.create({
      data: {
        chamadoId: chamado.id,
        usuarioId: req.auth.userId,
        descricao: `Chamado encerrado. Motivo: ${motivoConclusao || "Nao informado"}`
      }
    });

    await prisma.logAtendimento.create({
      data: {
        usuarioId: req.auth.userId,
        motoristaId: chamado.motoristaId,
        chamadoId: chamado.id,
        acao: "encerrar_chamado",
        entidade: "chamados",
        entidadeId: chamado.id,
        detalhes: {
          motivoConclusao,
          solucaoAplicada,
          observacoesFinais,
          tempoTotalMinutos
        }
      }
    });

    res.json({
      message: "Chamado encerrado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao encerrar chamado.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/chamados/:id", (req, res) => {
  void (async () => {
    const chamadoId = routeParam(req.params.id);
    const chamado = await prisma.chamado.findUnique({
      where: {
        id: chamadoId
      },
      include: {
        responsavel: {
          select: {
            nome: true
          }
        },
        historicos: {
          include: {
            usuario: {
              select: {
                nome: true
              }
            }
          },
          orderBy: {
            criadoEm: "asc"
          }
        },
        anexos: true
      }
    });

    if (!chamado) {
      res.status(404).json({
        message: "Chamado nao encontrado."
      });
      return;
    }

    res.json({
      id: chamado.id,
      assunto: chamado.assunto || chamado.titulo,
      categoria: chamado.categoria || "Geral",
      prioridade: chamado.prioridade,
      status: chamado.status,
      responsavel: chamado.responsavel?.nome || null,
      dataAbertura: chamado.abertoEm,
      ultimaAtualizacao: chamado.atualizadoEm,
      encerradoEm: chamado.encerradoEm,
      motivoConclusao: chamado.motivoConclusao,
      solucaoAplicada: chamado.solucaoAplicada,
      observacoesFinais: chamado.observacoesFinais,
      historico: chamado.historicos.map((item) => ({
        id: item.id,
        dataHora: item.criadoEm,
        usuario: item.usuario.nome,
        descricao: item.descricao
      })),
      anexos: chamado.anexos.map(toAttachmentPayload)
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar chamado.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
