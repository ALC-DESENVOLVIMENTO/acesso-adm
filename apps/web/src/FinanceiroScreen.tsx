import {
  ArrowRight,
  Bell,
  CalendarBlank,
  ChartLineUp,
  ClockCounterClockwise,
  Eye,
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
  fetchFinanceiroBases,
  fetchFinanceiroMotoristas,
  fetchFinanceiroSummary,
  type FinanceiroBaseCard,
  type FinanceiroMotoristaRow,
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
    return "Nao informado";
  }

  const [year, month, day] = value.split("T")[0].split("-");
  return `${day}/${month}/${year}`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Nao informado";
  }

  return new Date(value).toLocaleString("pt-BR");
}

function formatStatusLabel(value: string) {
  const labels: Record<string, string> = {
    disponivel: "Aberto",
    aguardando_aprovacao: "Encerrado",
    aprovado: "Processado",
    pdf_aguardando_envio: "PDF aguardando envio ao motorista",
    pdf_enviado_ao_motorista: "PDF enviado ao motorista",
    motorista_visualizou: "Motorista visualizou o PDF",
    aguardando_envio_nota_fiscal: "Aguardando envio da Nota Fiscal",
    nota_fiscal_recebida: "Nota Fiscal recebida",
    nota_fiscal_em_analise: "Nota Fiscal em análise",
    nota_fiscal_aprovada: "Nota Fiscal aprovada",
    nota_fiscal_rejeitada: "Nota Fiscal rejeitada",
    em_atendimento: "Em atendimento via Chat",
    chamado_aberto: "Chamado aberto",
    processo_concluido: "Processo concluído"
  };

  return labels[value] || value;
}

function financeStatusClass(status: string) {
  if (["nota_fiscal_aprovada", "processo_concluido"].includes(status)) {
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
  const canManagePeriods = currentUser?.level === "N3" || currentUser?.level === "N4";

  const [summary, setSummary] = useState<FinanceiroSummary>(initialSummary);
  const [baseCards, setBaseCards] = useState<FinanceiroBaseCard[]>([]);
  const [motoristas, setMotoristas] = useState<FinanceiroMotoristaRow[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [selectedBaseId, setSelectedBaseId] = useState("");
  const [periodViewTab, setPeriodViewTab] = useState<"bases" | "motoristas">("bases");
  const [searchTerm, setSearchTerm] = useState("");
  const [cpfTerm, setCpfTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [attendanceFilter, setAttendanceFilter] = useState("todos");
  const [busyMessage, setBusyMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [periodModalOpen, setPeriodModalOpen] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState<PaymentPeriod | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PaymentPeriod | null>(null);
  const [periodForm, setPeriodForm] = useState<PeriodFormState>(initialPeriodForm);

  const selectedPeriod = useMemo(
    () => periods.find((period) => period.id === selectedPeriodId) || null,
    [periods, selectedPeriodId]
  );

  const allowedBases = useMemo(() => {
    if (!selectedPeriod) {
      return [];
    }

    return selectedPeriod.paymentType === "mensal"
      ? bases
      : bases.filter((base) => base.paymentType === selectedPeriod.paymentType);
  }, [bases, selectedPeriod]);

  const selectedBase = useMemo(
    () => allowedBases.find((base) => base.id === selectedBaseId) || null,
    [allowedBases, selectedBaseId]
  );

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
    if (!periodId || !baseId) {
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

  useEffect(() => {
    if (!periods.length) {
      setSelectedPeriodId("");
      return;
    }

    const defaultPeriod = periods.find((period) => period.status !== "aprovado") || periods[0];

    if (!selectedPeriodId || !periods.some((period) => period.id === selectedPeriodId)) {
      setSelectedPeriodId(defaultPeriod.id);
    }
  }, [periods, selectedPeriodId]);

  useEffect(() => {
    if (!selectedPeriodId) {
      setBaseCards([]);
      setSelectedBaseId("");
      return;
    }

    void (async () => {
      try {
        setErrorMessage("");
        setBusyMessage("Carregando bases do periodo...");
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
      setSelectedBaseId("");
      return;
    }

    if (!selectedBaseId || !allowedBases.some((base) => base.id === selectedBaseId)) {
      setSelectedBaseId(allowedBases[0].id);
    }
  }, [allowedBases, selectedBaseId]);

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
      setBusyMessage(editingPeriod ? "Atualizando periodo..." : "Criando periodo...");

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
      setErrorMessage(error instanceof Error ? error.message : "Falha ao salvar periodo.");
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
      setBusyMessage("Atualizando status do periodo...");
      await updatePaymentPeriodStatus(token, period.id, { status: nextStatus });
      await onRefreshPeriods();
      await loadSummary();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Falha ao atualizar status do periodo.");
    } finally {
      setBusyMessage("");
    }
  };

  const handleDeletePeriod = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      setBusyMessage("Excluindo periodo...");
      await deletePaymentPeriod(token, deleteTarget.id);
      await onRefreshPeriods();
      await loadSummary();
      setDeleteTarget(null);
      if (selectedPeriodId === deleteTarget.id) {
        setSelectedPeriodId("");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Falha ao excluir periodo.");
    } finally {
      setBusyMessage("");
    }
  };

  if (!canAccess) {
    return (
      <div className="screen">
        <section className="panel">
          <h3>Acesso restrito</h3>
          <p>Esta funcionalidade esta liberada apenas para usuarios com acesso ao modulo Financeiro.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="screen screen--financeiro">
      <section className="screen__intro screen__intro--financeiro">
        <div>
          <p className="eyebrow">Financeiro</p>
          <h1>Notas Fiscais</h1>
          <p>
            Acompanhe o ciclo completo dos PDFs enviados, visualizacoes do motorista e recebimento das notas
            fiscais em um unico painel.
          </p>
        </div>
        <div className="quick-meta">
          <span className="quick-meta__chip quick-meta__chip--active">{summary.activePeriods} periodos ativos</span>
          <span className="quick-meta__chip">{summary.notesPending} pendentes</span>
          <span className="quick-meta__chip">{summary.inAnalysis} em analise</span>
        </div>
      </section>

      <section className="stats-grid stats-grid--three finance-stats">
        <article className="stat-card">
          <div className="stat-card__icon">
            <CalendarBlank size={30} />
          </div>
          <div>
            <strong>{summary.activePeriods}</strong>
            <span>Periodos ativos</span>
            <small>Disponiveis para acompanhamento</small>
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
            <small>Registros de envio do periodo</small>
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
            <small>Aguardando movimentacao</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <ChartLineUp size={30} />
          </div>
          <div>
            <strong>{summary.concluded}</strong>
            <span>Concluidos</span>
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

      <section className="finance-layout">
        <article className="panel finance-panel">
          <div className="panel__header">
            <div>
              <h3>Periodos de pagamento</h3>
              <p>Crie, edite, encerre e reabra periodos sem sair do financeiro.</p>
            </div>
            {canManagePeriods ? (
              <button className="primary-button primary-button--inline" type="button" onClick={openCreateModal}>
                Novo periodo
                <ArrowRight size={18} weight="bold" />
              </button>
            ) : null}
          </div>

          <div className="finance-period-selector">
            <label className="field finance-period-selector__field">
              <span>Periodo selecionado</span>
              <select
                className="field__select"
                value={selectedPeriodId}
                onChange={(event) => setSelectedPeriodId(event.target.value)}
              >
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.name} - {formatStatusLabel(period.status)}
                  </option>
                ))}
              </select>
            </label>
            <div className="finance-period-selector__summary">
              <span className="status-pill">
                {selectedPeriod ? formatStatusLabel(selectedPeriod.status) : "Sem periodo selecionado"}
              </span>
            </div>
          </div>

          <div className="finance-period-list">
            {periods.map((period) => {
              const isSelected = period.id === selectedPeriodId;
              return (
                <article
                  className={`finance-period-card ${isSelected ? "finance-period-card--active" : ""}`}
                  key={period.id}
                  onClick={() => setSelectedPeriodId(period.id)}
                >
                  <div className="finance-period-card__top">
                    <div>
                      <h4>{period.name}</h4>
                      <p>
                        {formatDateOnly(period.startDate)} ate {formatDateOnly(period.endDate)}
                      </p>
                    </div>
                    <span className={`status-pill ${period.status === "disponivel" ? "status-pill--active" : ""}`}>
                      {formatStatusLabel(period.status)}
                    </span>
                  </div>

                  <div className="period-card__actions finance-period-card__actions">
                    {canManagePeriods ? (
                      <div className="period-card__actions finance-period-card__actions">
                        <button
                          className="ghost-button ghost-button--small"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openEditModal(period);
                          }}
                        >
                          Editar
                          <PencilSimple size={16} />
                        </button>
                        <button
                          className="ghost-button ghost-button--small"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleChangePeriodStatus(period);
                          }}
                        >
                          {period.status === "aprovado" ? "Reabrir" : "Encerrar"}
                        </button>
                        <button
                          className="ghost-button ghost-button--small"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void updatePaymentPeriodStatus(token, period.id, { status: "aprovado" })
                              .then(onRefreshPeriods)
                              .then(loadSummary)
                              .catch((error) => {
                                setErrorMessage(
                                  error instanceof Error ? error.message : "Falha ao processar periodo."
                                );
                              });
                          }}
                        >
                          Processar
                        </button>
                        <button
                          className="ghost-button ghost-button--small ghost-button--danger"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteTarget(period);
                          }}
                        >
                          Excluir
                          <TrashSimple size={16} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </article>

        <div className="finance-stack">
          <div className="period-tabs finance-section-tabs">
            <button
              className={`period-tab ${periodViewTab === "bases" ? "period-tab--active" : ""}`}
              type="button"
              onClick={() => setPeriodViewTab("bases")}
            >
              Periodo ativo
            </button>
            <button
              className={`period-tab ${periodViewTab === "motoristas" ? "period-tab--active" : ""}`}
              type="button"
              onClick={() => setPeriodViewTab("motoristas")}
            >
              Motoristas do periodo
            </button>
          </div>

          <article className="panel finance-panel" style={{ display: periodViewTab === "bases" ? "grid" : "none" }}>
            <div className="panel__header">
              <div>
                <h3>Periodo ativo</h3>
                <p>Visualize as bases do periodo selecionado e abra os motoristas rapidamente.</p>
              </div>
            </div>

            {selectedPeriod ? (
              <div className="finance-period-hero">
                <div>
                  <p className="eyebrow">Periodo selecionado</p>
                  <h4>{selectedPeriod.name}</h4>
                  <p>
                    {formatDateOnly(selectedPeriod.startDate)} ate {formatDateOnly(selectedPeriod.endDate)}
                  </p>
                </div>
                <div className="finance-period-hero__meta">
                  <span>{formatStatusLabel(selectedPeriod.status)}</span>
                </div>
              </div>
            ) : (
              <div className="crm-empty-screen">
                <strong>Nenhum periodo selecionado</strong>
                <p>Crie ou selecione um periodo para carregar as bases e os motoristas.</p>
              </div>
            )}

            <div className="finance-base-grid">
              {baseCards.map((base) => (
                <article className="finance-base-card" key={base.id}>
                  <div className="finance-base-card__top">
                    <div>
                      <strong>{base.name}</strong>
                      <span>{base.paymentType.toUpperCase()}</span>
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
                    Abrir
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
                <h3>Motoristas do periodo</h3>
                <p>Filtre por motoristas e acompanhe o status da nota fiscal em tempo real.</p>
              </div>
            </div>

            {selectedBase ? (
              <div className="finance-period-hero finance-period-hero--compact">
                <div>
                  <p className="eyebrow">Base selecionada</p>
                  <h4>{selectedBase.name}</h4>
                  <p>{selectedBase.paymentType.toUpperCase()}</p>
                </div>
                <div className="finance-period-hero__meta">
                  <span>{selectedBase.motoristas} motoristas</span>
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
                  <option value="nota_fiscal_em_analise">Em analise</option>
                  <option value="nota_fiscal_aprovada">Aprovada</option>
                  <option value="nota_fiscal_rejeitada">Rejeitada</option>
                  <option value="em_atendimento">Em atendimento</option>
                  <option value="chamado_aberto">Chamado aberto</option>
                  <option value="processo_concluido">Concluido</option>
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
                    <th>Periodo</th>
                    <th>PDF enviado</th>
                    <th>Visualizacao</th>
                    <th>NF enviada</th>
                    <th>Status</th>
                    <th>Atendimento</th>
                    <th>Atualizacao</th>
                    <th>Acoes</th>
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
                            {row.caminhoArquivo ? (
                              <a className="ghost-button ghost-button--small" href={row.caminhoArquivo} target="_blank" rel="noreferrer">
                                PDF
                                <FilePdf size={16} />
                              </a>
                            ) : null}
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

      {periodModalOpen ? (
        <div className="modal-overlay">
          <div className="modal-card modal-card--crm modal-card--finance">
            <div className="modal-card__header">
              <div>
                <h3>{editingPeriod ? "Editar periodo" : "Criar periodo"}</h3>
                <p>Defina datas, nome e tipo de pagamento do periodo.</p>
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
                <span>Nome do periodo</span>
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
                  {editingPeriod ? "Salvar alterações" : "Criar periodo"}
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
                <h3>Excluir periodo</h3>
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
