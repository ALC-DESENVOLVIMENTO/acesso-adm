import {
  ArrowRight,
  Bell,
  CalendarBlank,
  ChartLineUp,
  ClockCounterClockwise,
  Eye,
  FileArrowUp,
  FilePdf,
  FunnelSimple,
  MagnifyingGlass,
  PencilSimple,
  TrashSimple,
  UsersThree
} from "@phosphor-icons/react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  createPaymentPeriod,
  deletePaymentPeriod,
  confirmFinanceiroImport,
  exportFinanceiroAptosPagamento,
  fetchFinanceiroBases,
  fetchFinanceiroAptosPagamento,
  fetchFinanceiroImportacao,
  fetchFinanceiroHistorico,
  fetchFinanceiroNotaFiscalContent,
  fetchFinanceiroMotoristas,
  fetchFinanceiroSummary,
  exportFinanceiroNotasFiscais,
  previewFinanceiroImport,
  reprocessFinanceiroWebhook,
  type FinanceiroBaseCard,
  type FinanceiroAptosPagamentoPreview,
  type FinanceiroHistoricoItem,
  type FinanceiroMotoristaRow,
  type FinanceiroImportPreviewRow,
  type FinanceiroImportacaoDetalhe,
  type FinanceiroSummary,
  type LoginResponse,
  type PaymentBase,
  type PaymentFrequency,
  type PaymentPeriod,
  updatePaymentPeriod,
  updatePaymentPeriodStatus
} from "./lib/api";

type SessionUser = LoginResponse["user"];

type FinanceiroScreenProps = {
  token: string;
  currentUser: SessionUser | null;
  periods: PaymentPeriod[];
  bases: PaymentBase[];
  onRefreshPeriods: () => Promise<void>;
  onOpenMotorista: (motoristaId: string) => void;
};

type PeriodFormState = {
  name: string;
  startDate: string;
  endDate: string;
  paymentType: PaymentFrequency;
};

type FinanceTab = "exportacao" | "apagar" | "importacao";
type PreviewFilter = "todos" | "validos" | "erros";

const initialSummary: FinanceiroSummary = {
  activePeriods: 0,
  bases: 0,
  motoristas: 0,
  pdfsSent: 0,
  notesReceived: 0,
  notesPending: 0,
  inAnalysis: 0,
  rejected: 0,
  inAttendance: 0,
  concluded: 0
};

const initialPeriodForm: PeriodFormState = {
  name: "",
  startDate: "",
  endDate: "",
  paymentType: "semanal"
};

function formatDateOnly(value: string | null | undefined) {
  if (!value) {
    return "Não informado";
  }

  const [year, month, day] = value.split("T")[0].split("-");
  return `${day}/${month}/${year}`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Não informado";
  }

  return new Date(value).toLocaleString("pt-BR");
}

function formatStatusLabel(value: string) {
  const labels: Record<string, string> = {
    disponivel: "Aberto",
    aguardando_aprovacao: "Encerrado",
    aprovado: "Processado",
    pdf_aguardando_envio: "PDF aguardando envio",
    pdf_enviado_ao_motorista: "PDF enviado ao motorista",
    motorista_visualizou: "Motorista visualizou o PDF",
    aguardando_envio_nota_fiscal: "Aguardando NF",
    pago: "Pago",
    nota_fiscal_recebida: "Nota Fiscal recebida",
    nota_fiscal_em_analise: "Nota Fiscal em análise",
    nota_fiscal_aprovada: "Nota Fiscal aprovada",
    nota_fiscal_rejeitada: "Nota Fiscal rejeitada",
    em_atendimento: "Em atendimento",
    chamado_aberto: "Chamado aberto",
    processo_concluido: "Processo concluído"
  };

  return labels[value] || value;
}

function formatImportStatusLabel(value: string | null | undefined) {
  if (!value) {
    return "Não informado";
  }

  const labels: Record<string, string> = {
    NOTA_FISCAL_PENDENTE: "NOTA FISCAL PENDENTE"
  };

  return labels[value] || value.replace(/_/g, " ");
}

function formatImportValidationLabel(value: string) {
  const labels: Record<string, string> = {
    valido: "Valida",
    pagamento_nao_encontrado: "Pagamento não encontrado",
    correspondencia_ambiguo: "Correspondencia ambigua",
    linha_duplicada: "Linha duplicada",
    linha_vazia: "Linha vazia",
    linha_inconsistente: "Linha inconsistente",
    cor_nao_reconhecida: "Status não reconhecido",
    sem_identificador: "Sem identificador",
    ja_atualizada: "Ja atualizada",
    conflito_status: "Conflito de status"
  };

  return labels[value] || value;
}

function financeStatusClass(status: string) {
  if (["nota_fiscal_aprovada", "processo_concluido", "pago"].includes(status)) {
    return "finance-status-pill finance-status-pill--success";
  }

  if (["nota_fiscal_rejeitada"].includes(status)) {
    return "finance-status-pill finance-status-pill--danger";
  }

  if (["nota_fiscal_em_analise", "aguardando_envio_nota_fiscal"].includes(status)) {
    return "finance-status-pill finance-status-pill--warning";
  }

  if (["em_atendimento", "chamado_aberto"].includes(status)) {
    return "finance-status-pill finance-status-pill--info";
  }

  if (["pdf_aguardando_envio", "pdf_enviado_ao_motorista", "motorista_visualizou"].includes(status)) {
    return "finance-status-pill finance-status-pill--neutral";
  }

  return "finance-status-pill";
}

export function FinanceiroScreen({
  token,
  currentUser,
  periods,
  bases,
  onRefreshPeriods,
  onOpenMotorista
}: FinanceiroScreenProps) {
  const canAccess =
    Boolean(currentUser) &&
    (currentUser?.modules.includes("financeiro") || currentUser?.level === "N3" || currentUser?.level === "N4");
  const canAccessAptos =
    Boolean(currentUser) &&
    (currentUser?.permissions?.includes("financeiro.apagar.view") ||
      currentUser?.permissions?.includes("financeiro.apagar.consultar") ||
      currentUser?.permissions?.includes("financeiro.apagar.export") ||
      currentUser?.level === "N3" ||
      currentUser?.level === "N4");

  const [summary, setSummary] = useState<FinanceiroSummary>(initialSummary);
  const [baseCards, setBaseCards] = useState<FinanceiroBaseCard[]>([]);
  const [motoristas, setMotoristas] = useState<FinanceiroMotoristaRow[]>([]);
  const [currentImportacao, setCurrentImportacao] = useState<FinanceiroImportacaoDetalhe | null>(null);
  const [previewRows, setPreviewRows] = useState<FinanceiroImportPreviewRow[]>([]);
  const [apagarPreview, setApagarPreview] = useState<FinanceiroAptosPagamentoPreview | null>(null);
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(null);
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [selectedBaseId, setSelectedBaseId] = useState("all");
  const [periodViewTab, setPeriodViewTab] = useState<"bases" | "motoristas">("bases");
  const [financeTab, setFinanceTab] = useState<FinanceTab>("exportacao");
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>("todos");
  const [searchTerm, setSearchTerm] = useState("");
  const [cpfTerm, setCpfTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [attendanceFilter, setAttendanceFilter] = useState("todos");
  const [busyMessage, setBusyMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState("");
  const [importacaoConfirmada, setImportacaoConfirmada] = useState(false);
  const [apagarBusy, setApagarBusy] = useState("");
  const [apagarError, setApagarError] = useState("");
  const [periodModalOpen, setPeriodModalOpen] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState<PaymentPeriod | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PaymentPeriod | null>(null);
  const [periodForm, setPeriodForm] = useState<PeriodFormState>(initialPeriodForm);

  const selectedPeriod = useMemo(
    () => periods.find((period) => period.id === selectedPeriodId) || null,
    [periods, selectedPeriodId]
  );

  const visiblePeriods = useMemo(() => {
    return periods.filter((period) => period.status === "aprovado");
  }, [periods]);

  const allowedBases = useMemo(() => {
    if (!selectedPeriod) {
      return [];
    }

    return selectedPeriod.paymentType === "mensal"
      ? bases
      : bases.filter((base) => base.paymentType === selectedPeriod.paymentType);
  }, [bases, selectedPeriod]);

  const selectedBase = useMemo(() => {
    if (selectedBaseId === "all") {
      return null;
    }

    return allowedBases.find((base) => base.id === selectedBaseId) || null;
  }, [allowedBases, selectedBaseId]);

  const visibleMotoristas = useMemo(() => {
    return motoristas.filter((row) => {
      if (attendanceFilter !== "todos" && row.situacaoAtendimento !== attendanceFilter) {
        return false;
      }

      return true;
    });
  }, [attendanceFilter, motoristas]);

  const loadSummary = async () => {
    const data = await fetchFinanceiroSummary(token);
    setSummary(data);
  };

  const loadBaseCards = async (periodId: string) => {
    if (!periodId) {
      setBaseCards([]);
      return;
    }

    const data = await fetchFinanceiroBases(token, periodId);
    setBaseCards(data);
  };

  const loadMotoristas = async (periodId: string, baseId: string) => {
    if (!periodId) {
      setMotoristas([]);
      return;
    }

    const data = await fetchFinanceiroMotoristas(token, periodId, baseId, {
      search: searchTerm || undefined,
      cpf: cpfTerm || undefined,
      status: statusFilter !== "todos" ? statusFilter : undefined
    });

    setMotoristas(data);
  };

  const loadImportacaoDetalhe = async (importacaoId: string) => {
    const data = await fetchFinanceiroImportacao(token, importacaoId);
    setCurrentImportacao(data);
    setImportacaoConfirmada(data.status === "concluido" || data.status === "concluido_com_erro");
  };

  useEffect(() => {
    if (!visiblePeriods.length) {
      setSelectedPeriodId("");
      return;
    }

    const defaultPeriod = visiblePeriods[0];

    if (!selectedPeriodId || !visiblePeriods.some((period) => period.id === selectedPeriodId)) {
      setSelectedPeriodId(defaultPeriod.id);
    }
  }, [selectedPeriodId, visiblePeriods]);

  useEffect(() => {
    if (!selectedPeriodId) {
      setBaseCards([]);
      setSelectedBaseId("all");
      return;
    }

    void (async () => {
      try {
        setErrorMessage("");
        setBusyMessage("Carregando bases do período...");
        await loadBaseCards(selectedPeriodId);
        setPeriodViewTab("bases");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Falha ao carregar bases.");
      } finally {
        setBusyMessage("");
      }
    })();
  }, [selectedPeriodId, token]);

  useEffect(() => {
    if (!allowedBases.length) {
      setSelectedBaseId("all");
      return;
    }

    if (selectedBaseId !== "all" && !allowedBases.some((base) => base.id === selectedBaseId)) {
      setSelectedBaseId("all");
    }
  }, [allowedBases, selectedBaseId]);

  useEffect(() => {
    setApagarPreview(null);
    setApagarError("");
  }, [selectedBaseId, selectedPeriodId]);

  useEffect(() => {
    if (!selectedPeriodId || !selectedBaseId) {
      setMotoristas([]);
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          setErrorMessage("");
          setBusyMessage("Atualizando motoristas...");
          await loadMotoristas(selectedPeriodId, selectedBaseId);
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : "Falha ao carregar motoristas.");
        } finally {
          setBusyMessage("");
        }
      })();
    }, 250);

    return () => window.clearTimeout(timer);
  }, [cpfTerm, searchTerm, selectedBaseId, selectedPeriodId, statusFilter, token]);

  useEffect(() => {
    void (async () => {
      try {
        setErrorMessage("");
        await loadSummary();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Falha ao carregar resumo.");
      }
    })();

    const timer = window.setInterval(() => {
      void (async () => {
        try {
          await loadSummary();
        } catch {
          return;
        }
      })();
    }, 30000);

    return () => window.clearInterval(timer);
  }, [token]);

  const openCreateModal = () => {
    setEditingPeriod(null);
    setPeriodForm(initialPeriodForm);
    setPeriodModalOpen(true);
  };

  const openEditModal = (period: PaymentPeriod) => {
    setEditingPeriod(period);
    setPeriodForm({
      name: period.name,
      startDate: period.startDate,
      endDate: period.endDate,
      paymentType: period.paymentType
    });
    setPeriodModalOpen(true);
  };

  const handleSavePeriod = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      setBusyMessage(editingPeriod ? "Atualizando período..." : "Criando período...");

      if (editingPeriod) {
        await updatePaymentPeriod(token, editingPeriod.id, periodForm);
      } else {
        await createPaymentPeriod(token, periodForm);
      }

      await onRefreshPeriods();
      await loadSummary();
      setPeriodModalOpen(false);
      setEditingPeriod(null);
      setPeriodForm(initialPeriodForm);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Falha ao salvar período.");
    } finally {
      setBusyMessage("");
    }
  };

  const handleChangePeriodStatus = async (period: PaymentPeriod) => {
    const nextStatus: "disponivel" | "aguardando_aprovacao" | "aprovado" =
      period.status === "aprovado"
        ? "disponivel"
        : period.status === "disponivel"
          ? "aguardando_aprovacao"
          : "aprovado";

    try {
      setBusyMessage("Atualizando status do período...");
      await updatePaymentPeriodStatus(token, period.id, { status: nextStatus });
      await onRefreshPeriods();
      await loadSummary();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Falha ao atualizar status do período.");
    } finally {
      setBusyMessage("");
    }
  };

  const handleDeletePeriod = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      setBusyMessage("Excluindo período...");
      await deletePaymentPeriod(token, deleteTarget.id);
      await onRefreshPeriods();
      await loadSummary();
      setDeleteTarget(null);
      if (selectedPeriodId === deleteTarget.id) {
        setSelectedPeriodId("");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Falha ao excluir período.");
    } finally {
      setBusyMessage("");
    }
  };

  const handleExportNotasFiscais = async () => {
    if (!selectedPeriodId) {
      return;
    }

    try {
      setBusyMessage("Preparando exportação das notas fiscais...");
      const { blob, filename } = await exportFinanceiroNotasFiscais(
        token,
        selectedPeriodId,
        selectedBaseId === "all" ? null : selectedBaseId
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename || `notas-fiscais-${selectedPeriodId}.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Falha ao exportar notas fiscais.");
    } finally {
      setBusyMessage("");
    }
  };

  const handleConsultarAptosPagamento = async () => {
    if (!selectedPeriodId) {
      setApagarError("Selecione um período antes de consultar.");
      return;
    }

    try {
      setApagarBusy("Consultando motoristas aptos...");
      setApagarError("");
      const data = await fetchFinanceiroAptosPagamento(
        token,
        selectedPeriodId,
        selectedBaseId === "all" ? null : selectedBaseId
      );
      setApagarPreview(data);
    } catch (error) {
      setApagarError(error instanceof Error ? error.message : "Falha ao consultar aptos para pagamento.");
    } finally {
      setApagarBusy("");
    }
  };

  const handleExportAptosPagamento = async () => {
    if (!selectedPeriodId) {
      setApagarError("Selecione um período antes de exportar.");
      return;
    }

    try {
      setApagarBusy("Gerando Excel dos aptos para pagamento...");
      setApagarError("");
      const { blob, filename } = await exportFinanceiroAptosPagamento(
        token,
        selectedPeriodId,
        selectedBaseId === "all" ? null : selectedBaseId
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename || `aptos_pagamento_${selectedPeriodId}.xlsx`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (error) {
      setApagarError(error instanceof Error ? error.message : "Falha ao exportar aptos para pagamento.");
    } finally {
      setApagarBusy("");
    }
  };

  const handlePreviewFinanceiroImport = async () => {
    if (!selectedImportFile || !selectedPeriodId) {
      setImportError("Selecione um arquivo e um período antes da pré-visualização.");
      return;
    }

    try {
      setImportBusy("Lendo planilha e montando pré-visualização...");
      setImportError("");
      setImportMessage("");
      const preview = await previewFinanceiroImport(token, selectedImportFile, {
        periodId: selectedPeriodId,
        baseId: selectedBaseId === "all" ? null : selectedBaseId
      });
      setPreviewRows(preview.previewRows);
      setImportMessage(
        `${preview.importacao.totalValidas} linhas válidas e ${preview.importacao.totalErros} linhas com alerta.`
      );
      setImportacaoConfirmada(false);
      await loadImportacaoDetalhe(preview.importacao.id);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Falha ao pré-visualizar a importação.");
    } finally {
      setImportBusy("");
    }
  };

  const handleConfirmFinanceiroImport = async () => {
    if (!currentImportacao) {
      setImportError("Nenhuma importação para confirmar.");
      return;
    }

    try {
      setImportBusy("Confirmando importação e atualizando status...");
      setImportError("");
      const result = await confirmFinanceiroImport(token, currentImportacao.id);
      setImportacaoConfirmada(true);
      setImportMessage(
        `${result.updatedItems.length} pagamentos atualizados. ${result.webhookResults.filter((item) => item.ok).length} webhooks processados.`
      );
      await loadImportacaoDetalhe(currentImportacao.id);
      await loadSummary();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Falha ao confirmar importação.");
    } finally {
      setImportBusy("");
    }
  };

  const handleReprocessWebhook = async (eventId: string) => {
    try {
      setImportBusy("Reprocessando webhook...");
      setImportError("");
      await reprocessFinanceiroWebhook(token, eventId);
      if (currentImportacao) {
        await loadImportacaoDetalhe(currentImportacao.id);
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Falha ao reprocessar webhook.");
    } finally {
      setImportBusy("");
    }
  };

  const openNotaFiscal = async (row: FinanceiroMotoristaRow) => {
    if (!row.notaFiscalDownloadUrl) {
      setErrorMessage("Nota Fiscal ainda não enviada.");
      return;
    }

    try {
      setBusyMessage("Abrindo Nota Fiscal...");
      const { blob } = await fetchFinanceiroNotaFiscalContent(token, row.id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Falha ao visualizar Nota Fiscal.");
    } finally {
      setBusyMessage("");
    }
  };

  const openDriverPdf = async (row: FinanceiroMotoristaRow) => {
    if (!row.caminhoArquivo) {
      return;
    }

    try {
      setBusyMessage("Abrindo PDF do motorista...");
      window.open(row.caminhoArquivo, "_blank", "noopener,noreferrer");
    } catch (error) {
      void error;
    } finally {
      setBusyMessage("");
    }
  };

  if (!canAccess) {
    return (
      <div className="screen">
        <section className="panel">
          <h3>Acesso restrito</h3>
          <p>Esta funcionalidade está liberada apenas para usuários com acesso ao módulo Financeiro.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="screen screen--financeiro">
      <section className="screen__intro screen__intro--financeiro">
        <div>
          <p className="eyebrow">Financeiro</p>
          <h1>Financeiro</h1>
          <p>
            Acompanhe a exportação das notas fiscais, o espelho de pagamento e a importação da planilha financeira
            em um único painel.
          </p>
        </div>
        <div className="quick-meta">
          <span className="quick-meta__chip quick-meta__chip--active">{summary.activePeriods} períodos ativos</span>
          <span className="quick-meta__chip">{summary.notesPending} pendentes</span>
          <span className="quick-meta__chip">{summary.inAnalysis} em análise</span>
        </div>
      </section>

      <section className="stats-grid stats-grid--three finance-stats">
        <article className="stat-card">
          <div className="stat-card__icon">
            <CalendarBlank size={30} />
          </div>
          <div>
            <strong>{summary.activePeriods}</strong>
            <span>Períodos ativos</span>
            <small>Disponíveis para acompanhamento</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <UsersThree size={30} />
          </div>
          <div>
            <strong>{summary.motoristas}</strong>
            <span>Motoristas</span>
            <small>Carregados no fluxo financeiro</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <FilePdf size={30} />
          </div>
          <div>
            <strong>{summary.pdfsSent}</strong>
            <span>PDFs enviados</span>
            <small>Registros de envio do período</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <Bell size={30} />
          </div>
          <div>
            <strong>{summary.notesReceived}</strong>
            <span>Notas fiscais recebidas</span>
            <small>Arquivos registrados no banco</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <ClockCounterClockwise size={30} />
          </div>
          <div>
            <strong>{summary.notesPending}</strong>
            <span>Pendentes</span>
            <small>Aguardando movimentação</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <ChartLineUp size={30} />
          </div>
          <div>
            <strong>{summary.concluded}</strong>
            <span>Concluídos</span>
            <small>Processos finalizados</small>
          </div>
        </article>
      </section>

      {busyMessage ? (
        <section className="panel panel--compact">
          <p className="loading-note">{busyMessage}</p>
        </section>
      ) : null}

      {errorMessage ? (
        <section className="panel panel--compact finance-alert finance-alert--error">
          <p>{errorMessage}</p>
        </section>
      ) : null}

      <section className="finance-section-tabs">
        <div className="period-tabs">
          <button
            className={`period-tab ${financeTab === "exportacao" ? "period-tab--active" : ""}`}
            type="button"
            onClick={() => setFinanceTab("exportacao")}
          >
            Notas Fiscais
          </button>
          {canAccessAptos ? (
            <button
              className={`period-tab ${financeTab === "apagar" ? "period-tab--active" : ""}`}
              type="button"
              onClick={() => setFinanceTab("apagar")}
            >
              A pagar
            </button>
          ) : null}
          <button
            className={`period-tab ${financeTab === "importacao" ? "period-tab--active" : ""}`}
            type="button"
            onClick={() => setFinanceTab("importacao")}
          >
            Atualizar Pagamentos
          </button>
        </div>
        <span className="finance-tab-hint">
          {financeTab === "exportacao"
            ? "Selecione um período e exporte apenas as notas fiscais vinculadas."
            : financeTab === "apagar"
              ? "Consulte somente os motoristas aptos a receber pagamento e exporte o Excel."
              : "Atualize os pagamentos pela planilha da coluna Resumido e confirme os status."}
        </span>
      </section>

      {financeTab === "exportacao" ? (
        <section className="finance-layout">
          <article className="panel finance-panel">
          <div className="panel__header">
            <div>
              <h3>Períodos de pagamento</h3>
              <p>Selecione um período aberto para acompanhar os PDFs e as notas fiscais.</p>
            </div>
          </div>

          <div className="finance-period-list">
            {visiblePeriods.map((period) => {
              const isSelected = period.id === selectedPeriodId;
              return (
                <article
                  className={`finance-period-card ${isSelected ? "finance-period-card--active" : ""}`}
                  key={period.id}
                  onClick={() => {
                    setSelectedPeriodId(period.id);
                    setSelectedBaseId("all");
                    setPeriodViewTab("bases");
                  }}
                >
                  <div className="finance-period-card__top">
                    <div>
                      <h4>{period.name}</h4>
                      <p>
                        {formatDateOnly(period.startDate)} até {formatDateOnly(period.endDate)}
                      </p>
                    </div>
                    <span className={`status-pill ${period.status === "disponivel" ? "status-pill--active" : ""}`}>
                      {formatStatusLabel(period.status)}
                    </span>
                  </div>

                </article>
              );
            })}
          </div>
        </article>

          <div className="finance-stack">
            <div className="finance-section-tabs">
              <div className="period-tabs">
                <button
                  className={`period-tab ${periodViewTab === "bases" ? "period-tab--active" : ""}`}
                  type="button"
                  onClick={() => setPeriodViewTab("bases")}
                >
                  Período ativo
                </button>
                <button
                  className={`period-tab ${periodViewTab === "motoristas" ? "period-tab--active" : ""}`}
                  type="button"
                  onClick={() => setPeriodViewTab("motoristas")}
                >
                  Motoristas do período
                </button>
              </div>
              <button
                className="ghost-button ghost-button--small finance-export-button cta-motion cta-motion--ghost"
                type="button"
                onClick={handleExportNotasFiscais}
                disabled={!selectedPeriodId}
              >
                Exportar Notas Fiscais
              </button>
            </div>

            <article className="panel finance-panel" style={{ display: periodViewTab === "bases" ? "grid" : "none" }}>
            <div className="panel__header">
              <div>
                <h3>Período ativo</h3>
                <p>Visualize as bases do período selecionado e abra os motoristas rapidamente.</p>
              </div>
            </div>

            {selectedPeriod ? (
              <div className="finance-period-hero">
                <div>
                  <p className="eyebrow">Período selecionado</p>
                  <h4>{selectedPeriod.name}</h4>
                  <p>
                    {formatDateOnly(selectedPeriod.startDate)} até {formatDateOnly(selectedPeriod.endDate)}
                  </p>
                </div>
                <div className="finance-period-hero__meta">
                  <span>{formatStatusLabel(selectedPeriod.status)}</span>
                </div>
              </div>
            ) : (
              <div className="crm-empty-screen">
                <strong>Nenhum período selecionado</strong>
                <p>Crie ou selecione um período para carregar as bases e os motoristas.</p>
              </div>
            )}

            <div className="finance-base-grid">
              {baseCards.map((base) => (
                <article className="finance-base-card" key={base.id}>
                  <div className="finance-base-card__top">
                    <div>
                      <strong>{base.name}</strong>
                      <span>{` ${base.paymentType.toUpperCase()}`}</span>
                    </div>
                    <span>{base.motoristas} motoristas</span>
                  </div>
                  <div className="finance-base-card__metrics">
                    <span>{base.pdfsSent} PDFs enviados</span>
                    <span>{base.pdfsPending} PDFs pendentes</span>
                    <span>{base.notesReceived} NFs recebidas</span>
                    <span>{base.notesPending} NFs pendentes</span>
                  </div>
                  <button
                    className="ghost-button ghost-button--small"
                    type="button"
                    onClick={() => {
                      setSelectedBaseId(base.id);
                      setPeriodViewTab("motoristas");
                    }}
                  >
                    Visualizar
                  </button>
                </article>
              ))}
            </div>
          </article>

            <article
              className="panel finance-panel"
              style={{ display: periodViewTab === "motoristas" ? "grid" : "none" }}
            >
            <div className="panel__header">
              <div>
                <h3>Motoristas do período</h3>
                <p>Filtre por motoristas e acompanhe o status da nota fiscal em tempo real.</p>
              </div>
            </div>

            {selectedBase || selectedBaseId === "all" ? (
              <div className="finance-period-hero finance-period-hero--compact">
                <div>
                  <p className="eyebrow">Base selecionada</p>
                  <h4>{selectedBase ? selectedBase.name : "Todas as bases"}</h4>
                  <p>{selectedBase ? selectedBase.paymentType.toUpperCase() : "PERIODO INTEIRO"}</p>
                </div>
                <div className="finance-period-hero__meta">
                  <span>{(selectedBase?.motoristas ?? visibleMotoristas.length) || 0} motoristas</span>
                  <small>Base ativa para consulta</small>
                </div>
              </div>
            ) : null}

            <div className="filters-row finance-filters">
              <label className="search-field">
                <MagnifyingGlass size={18} />
                <input
                  placeholder="Buscar por nome"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </label>
              <label className="search-field">
                <MagnifyingGlass size={18} />
                <input
                  placeholder="Buscar por CPF"
                  value={cpfTerm}
                  onChange={(event) => setCpfTerm(event.target.value)}
                />
              </label>
              <label className="filter-select">
                <FunnelSimple size={18} />
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="todos">Todos os status</option>
                  <option value="pdf_aguardando_envio">PDF aguardando envio</option>
                  <option value="pdf_enviado_ao_motorista">PDF enviado</option>
                  <option value="motorista_visualizou">Visualizado</option>
                  <option value="aguardando_envio_nota_fiscal">Aguardando NF</option>
                  <option value="nota_fiscal_recebida">NF recebida</option>
                  <option value="nota_fiscal_em_analise">Em análise</option>
                  <option value="nota_fiscal_aprovada">Aprovada</option>
                  <option value="pago">Pago</option>
                  <option value="nota_fiscal_rejeitada">Rejeitada</option>
                  <option value="em_atendimento">Em atendimento</option>
                  <option value="chamado_aberto">Chamado aberto</option>
                  <option value="processo_concluido">Concluído</option>
                </select>
              </label>
              <label className="filter-select">
                <Bell size={18} />
                <select value={attendanceFilter} onChange={(event) => setAttendanceFilter(event.target.value)}>
                  <option value="todos">Situação do atendimento</option>
                  <option value="Em atendimento">Em atendimento</option>
                  <option value="Chamado aberto">Chamado aberto</option>
                  <option value="Aguardando retorno">Aguardando retorno</option>
                  <option value="Atendimento encerrado">Atendimento encerrado</option>
                </select>
              </label>
            </div>

            <div className="table-wrap finance-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Motorista</th>
                    <th>Base</th>
                    <th>Período</th>
                    <th>PDF enviado</th>
                    <th>Visualização</th>
                    <th>NF enviada</th>
                    <th>Status</th>
                    <th>Atendimento</th>
                    <th>Atualização</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMotoristas.length > 0 ? (
                    visibleMotoristas.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <strong>{row.nome}</strong>
                          <span className="table-cell-subtle">{row.cpf}</span>
                        </td>
                        <td>{row.base}</td>
                        <td>{row.periodoPagamento}</td>
                        <td>{formatDateTime(row.pdfEnviadoEm)}</td>
                        <td>{formatDateTime(row.pdfVisualizadoEm)}</td>
                        <td>{formatDateTime(row.notaFiscalEnviadaEm)}</td>
                        <td>
                          <button
                            className={financeStatusClass(row.status)}
                            type="button"
                            onClick={() => onOpenMotorista(row.motoristaId)}
                          >
                            {row.statusLabel}
                          </button>
                        </td>
                        <td>
                          <span className="finance-attendance-pill">{row.situacaoAtendimento}</span>
                        </td>
                        <td>{formatDateTime(row.ultimaAtualizacao)}</td>
                        <td>
                          <div className="table-actions">
                            <button className="ghost-button ghost-button--small" type="button" onClick={() => onOpenMotorista(row.motoristaId)}>
                              Abrir
                              <Eye size={16} />
                            </button>
                            <button
                              className="ghost-button ghost-button--small"
                              type="button"
                              onClick={() => void openNotaFiscal(row)}
                              disabled={!row.notaFiscalDownloadUrl}
                            >
                              Visualizar Nota Fiscal
                              <FilePdf size={16} />
                            </button>
                            <button
                              className="ghost-button ghost-button--small"
                              type="button"
                              onClick={() => void openDriverPdf(row)}
                              disabled={!row.caminhoArquivo}
                            >
                              Abrir PDF
                              <FilePdf size={16} />
                            </button>
                          </div>
                        </td>
                    </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={10}>
                        <div className="crm-empty">
                          <strong>Nenhum motorista encontrado</strong>
                          <p>Use os filtros ou aguarde a integracao dos registros de PDF e NF.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            </article>
          </div>
        </section>
      ) : financeTab === "apagar" ? (
        <section className="finance-layout finance-layout--import">
          <article className="panel finance-panel">
            <div className="panel__header">
              <div>
                <h3>A pagar</h3>
                <p>Exporta somente os motoristas que estao realmente aptos a receber pagamento.</p>
              </div>
            </div>

            <div className="finance-period-hero">
              <div>
                <p className="eyebrow">Período selecionado</p>
                <h4>{selectedPeriod?.name || "Selecione um período"}</h4>
                <p>
                  {selectedPeriod
                    ? `${formatDateOnly(selectedPeriod.startDate)} até ${formatDateOnly(selectedPeriod.endDate)}`
                    : "Escolha um período para consultar os aptos"}
                </p>
              </div>
              <div className="finance-period-hero__meta">
                <span>{selectedBase ? selectedBase.name : "Todas as bases"}</span>
                <small>Filtro seguro por período/base</small>
              </div>
            </div>

            <div className="filters-row finance-filters">
              <label className="filter-select">
                <CalendarBlank size={18} />
                <select
                  value={selectedPeriodId}
                  onChange={(event) => {
                    setSelectedPeriodId(event.target.value);
                    setSelectedBaseId("all");
                  }}
                >
                  <option value="">Selecione um período</option>
                  {visiblePeriods.map((period) => (
                    <option key={period.id} value={period.id}>
                      {period.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary-button primary-button--inline cta-motion"
                type="button"
                onClick={() => void handleConsultarAptosPagamento()}
                disabled={!selectedPeriodId || Boolean(apagarBusy)}
              >
                {apagarBusy || "Consultar"}
                <ArrowRight size={18} weight="bold" />
              </button>
              <button
                className="ghost-button ghost-button--small cta-motion cta-motion--ghost"
                type="button"
                onClick={() => void handleExportAptosPagamento()}
                disabled={!selectedPeriodId || Boolean(apagarBusy)}
              >
                Exportar Excel
              </button>
            </div>

            {apagarBusy ? <p className="loading-note">{apagarBusy}</p> : null}
            {apagarError ? <p className="finance-alert finance-alert--error">{apagarError}</p> : null}

            <div className="finance-import-summary">
              <article className="finance-import-card">
                <strong>{apagarPreview?.total_aptos || 0}</strong>
                <span>Aptos</span>
              </article>
              <article className="finance-import-card">
                <strong>{apagarPreview?.total_inaptos || 0}</strong>
                <span>Excluidos</span>
              </article>
              <article className="finance-import-card">
                <strong>{apagarPreview?.total_inconsistencias || 0}</strong>
                <span>Inconsistencias</span>
              </article>
              <article className="finance-import-card">
                <strong>{apagarPreview?.total_processos || 0}</strong>
                <span>Processos analisados</span>
              </article>
            </div>

            <div className="table-wrap finance-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Motorista</th>
                    <th>Favorecido</th>
                    <th>CPF</th>
                    <th>Valor total</th>
                    <th>Base</th>
                    <th>Status processo</th>
                    <th>Status NF</th>
                    <th>Status pagamento</th>
                  </tr>
                </thead>
                <tbody>
                  {(apagarPreview?.aptos || []).length > 0 ? (
                    apagarPreview!.aptos.map((row) => (
                      <tr key={row.processoId}>
                        <td>{row.nomeMotorista}</td>
                        <td>{row.nomeFavorecido}</td>
                        <td>{row.cpfFavorecido}</td>
                        <td>{row.valorTotalPdfFormatado}</td>
                        <td>{row.baseMotorista}</td>
                        <td>{row.statusProcesso}</td>
                        <td>{row.statusNotaFiscal}</td>
                        <td>{row.statusPagamento}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8}>
                        <div className="crm-empty">
                          <strong>Nenhum motorista apto localizado</strong>
                          <p>Execute a consulta em um período já processado para visualizar os aptos para pagamento.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="finance-import-summary">
              <article className="finance-import-card finance-import-card--history">
                <strong>Motoristas excluidos</strong>
                {(apagarPreview?.excluidos || []).length > 0 ? (
                  <div className="finance-import-history__list">
                    {apagarPreview!.excluidos.slice(0, 5).map((item) => (
                      <p key={`${item.processoId}-${item.motoristaId || "sem"}`}>
                        {item.nomeMotorista}: {item.motivo}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p>Sem exclusões para o período atual.</p>
                )}
              </article>
              <article className="finance-import-card finance-import-card--history">
                <strong>Inconsistencias</strong>
                {(apagarPreview?.inconsistencias || []).length > 0 ? (
                  <div className="finance-import-history__list">
                    {apagarPreview!.inconsistencias.slice(0, 5).map((item) => (
                      <p key={`${item.processoId}-${item.campo}`}>
                        {item.nomeMotorista}: {item.motivo}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p>Sem inconsistências para o período atual.</p>
                )}
              </article>
            </div>
          </article>
        </section>
      ) : (
        <section className="finance-layout finance-layout--import">
          <article className="panel finance-panel">
            <div className="panel__header">
              <div>
                <h3>Atualizar Pagamentos</h3>
                <p>Envie somente a aba Resumido, confira o status da coluna M e confirme o status calculado.</p>
              </div>
            </div>

            <div className="finance-period-hero">
              <div>
                <p className="eyebrow">Contexto selecionado</p>
                <h4>{selectedPeriod?.name || "Selecione um período"}</h4>
                <p>
                  {selectedPeriod ? `${formatDateOnly(selectedPeriod.startDate)} até ${formatDateOnly(selectedPeriod.endDate)}` : "Período necessário para o processamento"}
                </p>
              </div>
              <div className="finance-period-hero__meta">
                <span>{selectedBase ? selectedBase.name : "Todas as bases"}</span>
                <small>Importação segura por período/base</small>
              </div>
            </div>

            <div className="filters-row finance-filters">
              <div className="field">
                <span>Arquivo Excel</span>
                <label className={`upload-chooser ${importBusy ? "upload-chooser--loading" : ""}`}>
                  <FileArrowUp size={18} weight="bold" />
                  <span>Escolher arquivo</span>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(event) => setSelectedImportFile(event.target.files?.[0] || null)}
                  />
                </label>
                <small className="upload-chooser__filename">
                  {selectedImportFile?.name || "Nenhum arquivo escolhido"}
                </small>
              </div>
              <label className="filter-select">
                <FunnelSimple size={18} />
                <select value={previewFilter} onChange={(event) => setPreviewFilter(event.target.value as PreviewFilter)}>
                  <option value="todos">Todos</option>
                  <option value="validos">Válidos</option>
                  <option value="erros">Erros</option>
                </select>
              </label>
            </div>

            <div className="admin-form__actions">
              <button className="primary-button primary-button--inline cta-motion" type="button" onClick={handlePreviewFinanceiroImport} disabled={!selectedImportFile || !selectedPeriodId || Boolean(importBusy)}>
                {importBusy || "Gerar pré-visualização"}
                <ArrowRight size={18} weight="bold" />
              </button>
              <button className="ghost-button ghost-button--small cta-motion cta-motion--ghost" type="button" onClick={handleConfirmFinanceiroImport} disabled={!currentImportacao || importacaoConfirmada}>
                Confirmar importação
              </button>
            </div>

            {importBusy ? <p className="loading-note">{importBusy}</p> : null}
            {importError ? <p className="finance-alert finance-alert--error">{importError}</p> : null}
            {importMessage ? <p className="finance-alert finance-alert--success">{importMessage}</p> : null}

            <div className="table-wrap finance-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Linha</th>
                    <th>Identificador</th>
                    <th>Motorista</th>
                    <th>CPF/CNPJ</th>
                    <th>Cod.OBB</th>
                    <th>Status planilha</th>
                    <th>Status atual</th>
                    <th>Novo status</th>
                    <th>Regra</th>
                    <th>Validação</th>
                    <th>Mensagem</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows
                    .filter((row) => (previewFilter === "todos" ? true : previewFilter === "validos" ? row.situacaoValidacao === "valido" : row.situacaoValidacao !== "valido"))
                    .map((row) => (
                      <tr key={`${row.numeroLinha}-${row.identificador || row.codigoObb || "linha"}`}>
                        <td>{row.numeroLinha}</td>
                        <td>{row.identificador || "Não informado"}</td>
                        <td>{row.motorista || "Não informado"}</td>
                        <td>{row.cpfCnpj || "Não informado"}</td>
                        <td>{row.codigoObb || "Não informado"}</td>
                        <td>{formatImportStatusLabel(row.statusPlanilha)}</td>
                        <td>{row.statusAtual || "PENDENTE"}</td>
                        <td>{row.novoStatus || "Sem alteração"}</td>
                        <td>{row.regraAplicada}</td>
                        <td>{formatImportValidationLabel(row.situacaoValidacao)}</td>
                        <td>{row.mensagem || "-"}</td>
                        <td>
                          <button
                            className="ghost-button ghost-button--small"
                            type="button"
                            onClick={() => {
                              if (!row.motoristaId) {
                                setImportError(row.mensagem || "Linha sem correspondência segura.");
                                return;
                              }

                              onOpenMotorista(row.motoristaId);
                            }}
                          >
                            Abrir
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <div className="finance-import-history">
              <h4>Importacoes recentes</h4>
              <div className="finance-import-history__list">
                {currentImportacao?.webhookEventos?.length ? (
                  currentImportacao.webhookEventos.map((event) => (
                    <article className="finance-import-card finance-import-card--history" key={event.eventId}>
                      <strong>{event.eventId}</strong>
                      <span>{event.status}</span>
                      <small>
                        {event.tentativas} tentativa(s) - {event.respostaHttp || "sem resposta"}
                      </small>
                      {event.mensagemErro ? <p>{event.mensagemErro}</p> : null}
                      <button className="ghost-button ghost-button--small" type="button" onClick={() => void handleReprocessWebhook(event.eventId)}>
                        Reprocessar webhook
                      </button>
                    </article>
                  ))
                ) : (
                  <p>Nenhum webhook registrado ainda.</p>
                )}
              </div>
            </div>
          </article>
        </section>
      )}

      {periodModalOpen ? (
        <div className="modal-overlay">
          <div className="modal-card modal-card--crm modal-card--finance">
            <div className="modal-card__header">
              <div>
                <h3>{editingPeriod ? "Editar período" : "Criar período"}</h3>
                <p>Defina datas, nome e tipo de pagamento do período.</p>
              </div>
              <button
                className="ghost-button ghost-button--small"
                type="button"
                onClick={() => {
                  setPeriodModalOpen(false);
                  setEditingPeriod(null);
                  setPeriodForm(initialPeriodForm);
                }}
              >
                Fechar
              </button>
            </div>

            <form className="admin-form admin-form--modal finance-period-form" onSubmit={handleSavePeriod}>
              <label className="field">
                <span>Nome do período</span>
                <input
                  value={periodForm.name}
                  onChange={(event) =>
                    setPeriodForm((current) => ({
                      ...current,
                      name: event.target.value
                    }))
                  }
                  placeholder="Pagamento Semanal 1 a 7"
                  required
                />
              </label>

              <label className="field">
                <span>Tipo de pagamento</span>
                <select
                  className="field__select"
                  value={periodForm.paymentType}
                  onChange={(event) =>
                    setPeriodForm((current) => ({
                      ...current,
                      paymentType: event.target.value as PaymentFrequency
                    }))
                  }
                >
                  <option value="semanal">SEMANAL</option>
                  <option value="quinzenal">QUINZENAL</option>
                  <option value="mensal">MENSAL</option>
                </select>
              </label>

              <label className="field">
                <span>Data inicial</span>
                <input
                  type="date"
                  value={periodForm.startDate}
                  onChange={(event) =>
                    setPeriodForm((current) => ({
                      ...current,
                      startDate: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label className="field">
                <span>Data final</span>
                <input
                  type="date"
                  value={periodForm.endDate}
                  onChange={(event) =>
                    setPeriodForm((current) => ({
                      ...current,
                      endDate: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <div className="admin-form__actions">
                <button className="primary-button primary-button--inline" type="submit">
                  {editingPeriod ? "Salvar alterações" : "Criar período"}
                  <ArrowRight size={18} weight="bold" />
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-overlay">
          <div className="modal-card modal-card--confirm">
            <div className="modal-card__header">
              <div>
                <h3>Excluir período</h3>
                <p>
                  Tem certeza que deseja excluir <strong>{deleteTarget.name}</strong>?
                </p>
              </div>
            </div>
            <div className="modal-card__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setDeleteTarget(null)}
              >
                Cancelar
              </button>
              <button className="ghost-button ghost-button--danger" type="button" onClick={handleDeletePeriod}>
                Excluir
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

