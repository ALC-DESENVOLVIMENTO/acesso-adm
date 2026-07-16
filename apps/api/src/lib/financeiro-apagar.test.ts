import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { DriverPdfReceivedStatus, FinanceiroStatusPagamento, UploadStatus } from "@prisma/client";
import type { AptosPagamentoPreview } from "./financeiro-apagar.js";

process.env.DATABASE_URL ||= "postgresql://user:password@localhost:5432/test";

const {
  buildWorkbook,
  evaluateAptidao,
  resolveBeneficiaryCnpj
} = await import("./financeiro-apagar.js");

function makeUpload() {
  return {
    id: "upload-1",
    motoristaId: "motorista-1",
    periodoPagamentoId: "periodo-1",
    basePagamentoId: "base-1",
    nomeOriginal: "espelho.pdf",
    caminhoArquivo: "uploads/periodo/base/motorista/espelho.pdf",
    status: UploadStatus.processado,
    statusPagamento: FinanceiroStatusPagamento.PENDENTE,
    motorista: {
      id: "motorista-1",
      nome: "Joao da Silva",
      cpf: "12345678901",
      statusCadastro: "ativo"
    },
    periodoPagamento: {
      id: "periodo-1",
      nome: "Semana 1 a 7"
    },
    basePagamento: {
      id: "base-1",
      nome: "CONTAGEM"
    }
  } as const;
}

test("evaluateAptidao marks an approved payment as apto", () => {
  const upload = makeUpload();
  const evaluation = evaluateAptidao({
    upload: upload as never,
    mirrorReceipt: {
      status: DriverPdfReceivedStatus.motorista_visualizou,
      visualizadoEm: new Date()
    } as never,
    noteReceipt: {
      status: DriverPdfReceivedStatus.nota_fiscal_aprovada
    } as never,
    paymentStatus: FinanceiroStatusPagamento.PENDENTE
  });

  assert.equal(evaluation.apto, true);
  assert.equal(evaluation.statusProcesso, "Aguardando pagamento");
});

test("evaluateAptidao blocks already paid items", () => {
  const upload = makeUpload();
  const evaluation = evaluateAptidao({
    upload: upload as never,
    mirrorReceipt: {
      status: DriverPdfReceivedStatus.motorista_visualizou,
      visualizadoEm: new Date()
    } as never,
    noteReceipt: {
      status: DriverPdfReceivedStatus.nota_fiscal_aprovada
    } as never,
    paymentStatus: FinanceiroStatusPagamento.PAGO
  });

  assert.equal(evaluation.apto, false);
  assert.equal(evaluation.motivoExclusao, "Pagamento ja realizado");
});

test("resolveBeneficiaryCnpj uses the registry CNPJ and never falls back to CPF", () => {
  const registryMatch = {
    externalId: "registry-1",
    nome: "Joao da Silva",
    cpf: "12345678901",
    cpfDigits: "12345678901",
    cnpj: "00123456000199",
    base: "CONTAGEM",
    raw: {
      cpf_favorecido: "98765432100",
      cnpj_digits: "00123456000199"
    }
  };

  assert.equal(resolveBeneficiaryCnpj(registryMatch), "00123456000199");
  assert.equal(
    resolveBeneficiaryCnpj({ ...registryMatch, cnpj: null, raw: { cpf_favorecido: "98765432100" } }),
    ""
  );
});

test("buildWorkbook creates the expected sheets and headers", () => {
  const preview: AptosPagamentoPreview = {
    periodoId: "periodo-1",
    periodo: {
      id: "periodo-1",
      nome: "Semana 1 a 7"
    },
    totalProcessos: 1,
    totalAptos: 1,
    totalInaptos: 0,
    totalInconsistencias: 1,
    aptos: [
      {
        processoId: "upload-1",
        motoristaId: "motorista-1",
        nomeMotorista: "Joao da Silva",
        nomeFavorecido: "Joao da Silva",
        cnpjFavorecido: "00123456000199",
        valorTotalPdf: 1500.5,
        valorTotalPdfFormatado: "R$ 1.500,50",
        baseMotorista: "CONTAGEM",
        statusProcesso: "Aguardando pagamento",
        statusNotaFiscal: "Nota fiscal aprovada",
        statusPagamento: "PENDENTE"
      }
    ],
    excluidos: [],
    inconsistencias: [
      {
        processoId: "upload-2",
        motoristaId: "motorista-2",
        nomeMotorista: "Maria",
        periodo: "Semana 1 a 7",
        motivo: "CNPJ do favorecido ausente",
        campo: "cnpj_favorecido"
      }
    ]
  };

  const buffer = buildWorkbook(preview);
  const workbook = XLSX.read(buffer, { type: "buffer" });

  assert.deepEqual(workbook.SheetNames, ["Aptos para Pagamento", "Inconsistências"]);

  const sheet = workbook.Sheets["Aptos para Pagamento"];
  assert.equal(sheet.A1?.v, "Nome Motorista");
  assert.equal(sheet.C1?.v, "CNPJ do Favorecido");
  assert.equal(sheet.C2?.v, "00123456000199");
  assert.equal(sheet.C2?.t, "s");
  assert.equal(sheet.E1?.v, "Base do Motorista");
  assert.equal(sheet.D2?.v, 1500.5);
});
