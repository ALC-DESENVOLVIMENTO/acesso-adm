import {
  ArrowRight,
  Bell,
  CalendarBlank,
  ChatCenteredDots,
  EnvelopeSimple,
  ChartLineUp,
  ClockCounterClockwise,
  Eye,
  FileArrowUp,
  FilePdf,
  FunnelSimple,
  GearSix,
  HouseLine,
  List,
  LockKey,
  LockSimple,
  MagnifyingGlass,
  PencilSimple,
  SignOut,
  TrashSimple,
  UserCirclePlus,
  UsersThree
} from "@phosphor-icons/react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  changeFirstAccessPassword,
  createUser,
  createPaymentPeriod,
  deletePaymentPeriod,
  deleteUser,
  deleteUpload,
  downloadUpload,
  fetchDashboardSummary,
  fetchAtendimentoClassificacoes,
  fetchAtendimentoMotorista,
  fetchPaymentBases,
  fetchPaymentPeriods,
  fetchSession,
  fetchUploadHistory,
  fetchUploads,
  searchAtendimentoMotoristas,
  fetchUsers,
  loginRequest,
  logoutRequest,
  updateMotoristaClassificacoes,
  createAtendimentoNota,
  updateAtendimentoNota,
  deleteAtendimentoNota,
  createAtendimentoChamado,
  createAtendimentoMovimento,
  closeAtendimentoChamado,
  replaceUpload,
  resetUserPassword,
  updateUser,
  updateUserStatus,
  uploadPdfs,
  type DashboardSummary,
  type AtendimentoClassificacao,
  type AtendimentoDetail,
  type AtendimentoMotoristaSearch,
  type LoginResponse,
  type PaymentBase,
  type PaymentPeriod,
  type UploadProgressState,
  type UploadRow,
  type UserPayload,
  type UserSummary
} from "./lib/api";

type AccessLevel = "N1" | "N2" | "N3" | "N4";
type View = "login" | "first-access" | "dashboard" | "pdfs" | "users" | "periods" | "atendimento";

type Activity = {
  icon: "pdf" | "user" | "view";
  title: string;
  subtitle: string;
  date: string;
  time: string;
};

type SessionUser = LoginResponse["user"];

type FlashMessage = {
  type: "success" | "error";
  text: string;
};

type UploadHistoryState = {
  uploadId: string;
  entries: UploadRow[];
} | null;

const menuItems = [
  { key: "dashboard", label: "Dashboard", icon: HouseLine },
  { key: "pdfs", label: "Envio de PDFs", icon: FileArrowUp },
  { key: "users", label: "Cadastro de Usuarios", icon: UserCirclePlus },
  { key: "periods", label: "Criação de Periodo", icon: CalendarBlank },
  { key: "atendimento", label: "Atendimento", icon: ChatCenteredDots }
] as const;

const activities: Activity[] = [
  {
    icon: "pdf",
    title: "PDF enviado: Conhecimento_12345.pdf",
    subtitle: "Enviado por Administrador",
    date: "05/05/2025",
    time: "10:30"
  },
  {
    icon: "user",
    title: "Usuario novo cadastrado: joao.silva",
    subtitle: "Cadastrado por Administrador",
    date: "05/05/2025",
    time: "09:15"
  },
  {
    icon: "view",
    title: "PDF visualizado: Conhecimento_54321.pdf",
    subtitle: "Visualizado por maria.souza",
    date: "05/05/2025",
    time: "08:45"
  },
  {
    icon: "pdf",
    title: "PDF enviado: Romaneio_98765.pdf",
    subtitle: "Enviado por Administrador",
    date: "04/05/2025",
    time: "17:20"
  }
];

const initialSummary: DashboardSummary = {
  pdfsSent: 0,
  pendingPdfs: 0,
  processedPdfs: 0,
  pendingInvoices: 0,
  ticketsWaiting: 0,
  closedTickets: 0,
  usersCount: 0
};

const logoSrc = "/alc-logotipo-dark.png";

function formatStatusLabel(status: string) {
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateOnly(dateValue: string) {
  const datePart = dateValue.includes("T") ? dateValue.split("T")[0] : dateValue;
  const [year, month, day] = datePart.split("-");

  return `${day}/${month}/${year}`;
}

function App() {
  const [view, setView] = useState<View>("login");
  const [activeView, setActiveView] = useState<Exclude<View, "login" | "first-access">>("dashboard");
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [loadingMessage, setLoadingMessage] = useState("");
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(null);
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary>(initialSummary);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [paymentPeriods, setPaymentPeriods] = useState<PaymentPeriod[]>([]);
  const [paymentBases, setPaymentBases] = useState<PaymentBase[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);
  const [uploadHistory, setUploadHistory] = useState<UploadHistoryState>(null);
  const [createUserSignal, setCreateUserSignal] = useState(0);
  const [deleteUserTarget, setDeleteUserTarget] = useState<UserSummary | null>(null);
  const [deleteUploadTarget, setDeleteUploadTarget] = useState<UploadRow | null>(null);
  const [deletePeriodTarget, setDeletePeriodTarget] = useState<PaymentPeriod | null>(null);
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [uploadsLoaded, setUploadsLoaded] = useState(false);
  const [periodDataLoaded, setPeriodDataLoaded] = useState(false);

  const allowedMenu = useMemo(() => {
    if (!currentUser) {
      return [];
    }

    return menuItems.filter((item) => {
      if (item.key === "periods") {
        return currentUser.level === "N3" || currentUser.level === "N4";
      }

      return currentUser.modules.includes(item.key);
    });
  }, [currentUser]);

  const canSeePdfData = useMemo(() => currentUser?.modules.includes("pdfs") ?? false, [currentUser]);
  const canSeeUsersData = useMemo(() => currentUser?.modules.includes("users") ?? false, [currentUser]);
  const canSeePeriodData = useMemo(
    () => canSeePdfData || currentUser?.level === "N3" || currentUser?.level === "N4",
    [canSeePdfData, currentUser]
  );

  const clearLoadedState = () => {
    setDashboardLoaded(false);
    setUsersLoaded(false);
    setUploadsLoaded(false);
    setPeriodDataLoaded(false);
  };

  const loadDashboardSummary = async () => {
    const summary = await fetchDashboardSummary(token);
    setDashboardSummary(summary);
    setDashboardLoaded(true);
  };

  const loadUsersData = async () => {
    const usersData = await fetchUsers(token);
    setUsers(usersData);
    setUsersLoaded(true);
  };

  const loadUploadsData = async () => {
    const uploadsData = await fetchUploads(token);
    setUploads(uploadsData);
    setUploadsLoaded(true);
  };

  const loadPeriodData = async () => {
    const [periodsData, basesData] = await Promise.all([fetchPaymentPeriods(token), fetchPaymentBases(token)]);
    setPaymentPeriods(periodsData);
    setPaymentBases(basesData);
    setPeriodDataLoaded(true);
  };

  useEffect(() => {
    const storedSession = localStorage.getItem("portal-admin-session");

    if (!storedSession) {
      return;
    }

    void (async () => {
      try {
        const { token: storedToken } = JSON.parse(storedSession) as { token: string; user: SessionUser };
        const session = await fetchSession(storedToken);
        setToken(session.token);
        setCurrentUser(session.user);
        localStorage.setItem(
          "portal-admin-session",
          JSON.stringify({
            token: session.token,
            user: session.user
          })
        );

        if (session.firstAccess) {
          setView("first-access");
          return;
        }

        setActiveView("dashboard");
        setView("dashboard");
      } catch {
        localStorage.removeItem("portal-admin-session");
      }
    })();
  }, []);

  useEffect(() => {
    if (!token || !currentUser || view === "login" || view === "first-access") {
      return;
    }

    let cancelled = false;
    const loadData = async () => {
      setLoadingMessage("Carregando dados do portal...");

      try {
        if (activeView === "dashboard") {
          if (!dashboardLoaded) {
            await loadDashboardSummary();
          }

          return;
        }

        const tasks: Promise<unknown>[] = [];

        if (activeView === "users") {
          if (canSeeUsersData && !usersLoaded) {
            tasks.push(loadUsersData());
          }
        }

        if (activeView === "pdfs") {
          if (canSeePdfData && !uploadsLoaded) {
            tasks.push(loadUploadsData());
          }

          if (canSeePeriodData && !periodDataLoaded) {
            tasks.push(loadPeriodData());
          }
        }

        if (activeView === "periods" && canSeePeriodData && !periodDataLoaded) {
          tasks.push(loadPeriodData());
        }

        if (tasks.length === 0) {
          return;
        }

        await Promise.all(tasks);

        if (cancelled) {
          return;
        }

        setFlashMessage(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setLoginError(error instanceof Error ? error.message : "Falha ao carregar dados do portal.");
      } finally {
        if (!cancelled) {
          setLoadingMessage("");
        }
      }
    };

    void loadData();

    return () => {
      cancelled = true;
    };
  }, [
    activeView,
    canSeePdfData,
    canSeePeriodData,
    canSeeUsersData,
    currentUser,
    dashboardLoaded,
    periodDataLoaded,
    token,
    uploadsLoaded,
    usersLoaded,
    view
  ]);


  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") || "").trim().toLowerCase();
    const password = String(data.get("password") || "").trim();

    setLoadingMessage("Autenticando acesso...");
    setLoginError("");

    try {
      const response = await loginRequest({ email, password });
      setCurrentUser(response.user);
      setToken(response.token);
      clearLoadedState();
      setDashboardSummary(initialSummary);
      setUploads([]);
      setUsers([]);
      setPaymentPeriods([]);
      setPaymentBases([]);
      localStorage.setItem(
        "portal-admin-session",
        JSON.stringify({
          token: response.token,
          user: response.user
        })
      );

      if (response.firstAccess) {
        setView("first-access");
        return;
      }

      const nextView = response.user.modules.includes("dashboard")
        ? "dashboard"
        : ((response.user.modules[0] || "dashboard") as Exclude<View, "login" | "first-access">);

      setActiveView(nextView);
      setView(nextView);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Falha ao autenticar usuario.");
    } finally {
      setLoadingMessage("");
    }
  };

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!currentUser) {
      return;
    }

    const data = new FormData(event.currentTarget);
    const currentPassword = String(data.get("currentPassword") || "").trim();
    const newPassword = String(data.get("newPassword") || "").trim();
    const confirmPassword = String(data.get("confirmPassword") || "").trim();

    if (newPassword !== confirmPassword) {
      setPasswordError("A confirmacao da senha precisa ser igual a nova senha.");
      return;
    }

    setLoadingMessage("Atualizando senha inicial...");
    setPasswordError("");

    try {
      await changeFirstAccessPassword({
        email: currentUser.email,
        currentPassword,
        newPassword
      });

      const updatedUser = {
        ...currentUser,
        firstAccess: false
      };

      setCurrentUser(updatedUser);
      localStorage.setItem(
        "portal-admin-session",
        JSON.stringify({
          token,
          user: updatedUser
        })
      );
      setActiveView("dashboard");
      setView("dashboard");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Falha ao alterar a senha.");
    } finally {
      setLoadingMessage("");
    }
  };

  const handleLogout = () => {
    if (token) {
      void logoutRequest(token).catch(() => undefined);
    }

    setCurrentUser(null);
    setToken("");
    setUsers([]);
    setUploads([]);
    setPaymentPeriods([]);
    setPaymentBases([]);
    setDashboardSummary(initialSummary);
    setLoginError("");
    setPasswordError("");
    setLoadingMessage("");
    setFlashMessage(null);
    setUploadProgress(null);
    setUploadHistory(null);
    setDeleteUserTarget(null);
    setDeleteUploadTarget(null);
    setDeletePeriodTarget(null);
    setActiveView("dashboard");
    setView("login");
    clearLoadedState();
    localStorage.removeItem("portal-admin-session");
  };

  const handleCreateUser = async (payload: UserPayload) => {
    if (!token) {
      return false;
    }

    setLoadingMessage("Criando usuario...");

    try {
      const response = await createUser(token, payload);
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao criar usuario."
      });
      return false;
    } finally {
      setLoadingMessage("");
    }
  };

  const handleUpdateUser = async (userId: string, payload: UserPayload) => {
    if (!token) {
      return false;
    }

    setLoadingMessage("Atualizando usuario...");

    try {
      const response = await updateUser(token, userId, payload);
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao atualizar usuario."
      });
      return false;
    } finally {
      setLoadingMessage("");
    }
  };

  const handleDeleteUser = async (user: UserSummary) => {
    if (!token) {
      return false;
    }

    setLoadingMessage("Excluindo usuario...");

    try {
      const response = await deleteUser(token, user.id);
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao excluir usuario."
      });
      return false;
    } finally {
      setLoadingMessage("");
    }
  };

  const handleCreatePeriod = async (payload: {
    name: string;
    startDate: string;
    endDate: string;
    paymentType: "semanal" | "quinzenal" | "mensal";
  }) => {
    if (!token) {
      return false;
    }

    setLoadingMessage("Criando periodo...");

    try {
      const response = await createPaymentPeriod(token, payload);
      setFlashMessage({ type: "success", text: response.message });
      await loadPeriodData();
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao criar periodo."
      });
      return false;
    } finally {
      setLoadingMessage("");
    }
  };

  const openUsersCreateModal = () => {
    setActiveView("users");
    setView("users");
    setCreateUserSignal((current) => current + 1);
  };

  const openPdfUploadShortcut = () => {
    setActiveView("pdfs");
    setView("pdfs");
    setFlashMessage({
      type: "success",
      text: "A tela de envio de PDFs foi aberta."
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const requestDeleteUser = (user: UserSummary) => {
    setDeleteUserTarget(user);
  };

  const requestDeleteUpload = (upload: UploadRow) => {
    setDeleteUploadTarget(upload);
  };

  const requestDeletePeriod = (period: PaymentPeriod) => {
    setDeletePeriodTarget(period);
  };

  const handleToggleBlock = async (user: UserSummary) => {
    if (!token) {
      return;
    }

    setLoadingMessage("Atualizando bloqueio...");

    try {
      const response = await updateUserStatus(token, user.id, {
        blocked: !user.blocked
      });
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao alterar bloqueio."
      });
    } finally {
      setLoadingMessage("");
    }
  };

  const handleToggleActive = async (user: UserSummary) => {
    if (!token) {
      return;
    }

    setLoadingMessage("Atualizando status...");

    try {
      const response = await updateUserStatus(token, user.id, {
        active: !user.active
      });
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao atualizar status."
      });
    } finally {
      setLoadingMessage("");
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (!token) {
      return;
    }

    setLoadingMessage("Redefinindo senha...");

    try {
      const response = await resetUserPassword(token, userId);
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao redefinir senha."
      });
    } finally {
      setLoadingMessage("");
    }
  };

  const handleUploadFiles = async (
    files: File[],
    fields?: { periodId?: string; basePaymentId?: string }
  ) => {
    if (!token || files.length === 0) {
      return;
    }

    setLoadingMessage("Enviando PDFs...");
    setUploadProgress({
      loaded: 0,
      total: 0,
      percent: 0,
      label: "Preparando upload..."
    });

    try {
      const response = await uploadPdfs(token, files, fields, (progress) => {
        setUploadProgress({
          ...progress,
          label: "Enviando PDFs..."
        });
      });
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUploadsData(), loadDashboardSummary()]);
      setActiveView("pdfs");
      setView("pdfs");
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao enviar PDFs."
      });
    } finally {
      setLoadingMessage("");
      setUploadProgress(null);
    }
  };

  const handleReplaceUpload = async (uploadId: string, file: File) => {
    if (!token) {
      return;
    }

    setLoadingMessage("Substituindo PDF...");
    setUploadProgress({
      loaded: 0,
      total: 0,
      percent: 0,
      label: "Preparando substituicao..."
    });

    try {
      const response = await replaceUpload(token, uploadId, file, (progress) => {
        setUploadProgress({
          ...progress,
          label: "Substituindo PDF..."
        });
      });
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUploadsData(), loadDashboardSummary()]);

      if (uploadHistory?.uploadId) {
        const entries = await fetchUploadHistory(token, uploadHistory.uploadId);
        setUploadHistory({
          uploadId: uploadHistory.uploadId,
          entries
        });
      }
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao substituir PDF."
      });
    } finally {
      setLoadingMessage("");
      setUploadProgress(null);
    }
  };

  const handleDownloadUpload = async (uploadRow: UploadRow) => {
    if (!token) {
      return;
    }

    try {
      await downloadUpload(token, uploadRow.id, uploadRow.fileName);
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao baixar arquivo."
      });
    }
  };

  const handleOpenUploadHistory = async (uploadId: string) => {
    if (!token) {
      return;
    }

    setLoadingMessage("Carregando historico do PDF...");

    try {
      const entries = await fetchUploadHistory(token, uploadId);
      setUploadHistory({
        uploadId,
        entries
      });
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao carregar historico do PDF."
      });
    } finally {
      setLoadingMessage("");
    }
  };

  const handleDeleteUpload = async (uploadId: string) => {
    if (!token) {
      return;
    }

    setLoadingMessage("Removendo PDF...");

    try {
      const response = await deleteUpload(token, uploadId);
      setFlashMessage({ type: "success", text: response.message });

      if (uploadHistory?.uploadId === uploadId) {
        setUploadHistory(null);
      }

      await Promise.all([loadUploadsData(), loadDashboardSummary()]);
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao remover PDF."
      });
    } finally {
      setLoadingMessage("");
    }
  };

  const handleDeletePeriod = async (periodId: string) => {
    if (!token) {
      return;
    }

    setLoadingMessage("Excluindo periodo...");

    try {
      const response = await deletePaymentPeriod(token, periodId);
      setFlashMessage({ type: "success", text: response.message });
      await loadPeriodData();
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao excluir periodo."
      });
    } finally {
      setLoadingMessage("");
    }
  };

  if (view === "login") {
    return (
      <main className="auth-page">
        <section className="auth-hero">
          <div className="auth-brand">
            <img className="auth-brand__logo" src={logoSrc} alt="ALC Pereira Filho Transportes" />
            <div className="auth-brand__copy">
              <span className="auth-brand__title">Portal Administrativo</span>
              <span className="auth-brand__subtitle">Administracao simplificada</span>
            </div>
          </div>

          <div className="auth-headline">
            <h1>Bem-vindo ao Portal Administrativo!</h1>
            <p className="auth-copy">
              Acesse sua conta para gerenciar operacoes, acompanhar informacoes e utilizar os
              recursos do sistema com seguranca.
            </p>
            <p className="auth-copy auth-copy--muted">
              Este ambiente e exclusivo para usuarios autorizados.
            </p>
          </div>

          <div className="hero-preview">
            <div className="hero-preview__window">
              <div className="hero-preview__sidebar">
                <img className="hero-preview__mini-logo" src={logoSrc} alt="Logo da ALC Pereira Filho Transportes" />
                <div className="hero-preview__menu">
                  <span className="hero-preview__menu-item hero-preview__menu-item--active" />
                  <span className="hero-preview__menu-item" />
                  <span className="hero-preview__menu-item" />
                </div>
              </div>
              <div className="hero-preview__content">
                <div className="hero-preview__topbar" />
                <div className="hero-preview__kpis">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className="hero-preview__body">
                  <div className="hero-preview__chart" />
                  <div className="hero-preview__activity">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="hero-watermark" aria-hidden="true">
            <img className="hero-watermark__image" src={logoSrc} alt="" />
          </div>
        </section>

        <section className="auth-panel">
          <div className="auth-card auth-card--login">
            <img className="auth-card__logo" src={logoSrc} alt="ALC Pereira Filho Transportes" />
            <p className="eyebrow">Acesso seguro</p>
            <h2>Entrar no sistema</h2>
            <p className="panel-copy">
              Use um dos e-mails cadastrados na base inicial e a senha temporaria `0000`.
            </p>

            <form className="form-stack" onSubmit={handleLogin}>
              <label className="field">
                <span>E-mail</span>
                <span className="field__control">
                  <EnvelopeSimple size={18} />
                  <input name="email" type="email" placeholder="Digite seu e-mail" required />
                </span>
              </label>
              <label className="field">
                <span>Senha</span>
                <span className="field__control">
                  <LockSimple size={18} />
                  <input name="password" type="password" placeholder="Digite sua senha" required />
                </span>
              </label>

              {loadingMessage ? <p className="loading-note">{loadingMessage}</p> : null}
              {loginError ? <p className="form-error">{loginError}</p> : null}

              <button className="primary-button" type="submit">
                Acessar
                <ArrowRight size={18} weight="bold" />
              </button>
            </form>

            <div className="auth-note">
              <LockKey size={18} />
              <span>Primeiro login com troca de senha obrigatoria e controle por perfil.</span>
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (view === "first-access") {
    return (
      <main className="first-access-page">
        <div className="first-access-card">
          <img className="first-access-card__logo" src={logoSrc} alt="ALC Pereira Filho Transportes" />
          <p className="eyebrow">Seguranca obrigatoria</p>
          <h2>Altere sua senha para continuar</h2>
          <p className="panel-copy">
            No primeiro acesso, o sistema exige a substituicao da senha padrao antes de liberar os
            demais modulos.
          </p>

          <form className="form-stack" onSubmit={handleChangePassword}>
            <label className="field">
              <span>Senha atual</span>
              <span className="field__control">
                <LockSimple size={18} />
                <input
                  name="currentPassword"
                  type="password"
                  placeholder="Informe a senha atual"
                  required
                />
              </span>
            </label>
            <label className="field">
              <span>Nova senha</span>
              <span className="field__control">
                <LockSimple size={18} />
                <input
                  name="newPassword"
                  type="password"
                  placeholder="Minimo de 6 caracteres"
                  required
                />
              </span>
            </label>
            <label className="field">
              <span>Confirmar nova senha</span>
              <span className="field__control">
                <LockSimple size={18} />
                <input
                  name="confirmPassword"
                  type="password"
                  placeholder="Repita a nova senha"
                  required
                />
              </span>
            </label>

            {loadingMessage ? <p className="loading-note">{loadingMessage}</p> : null}
            {passwordError ? <p className="form-error">{passwordError}</p> : null}

            <button className="primary-button" type="submit">
              Salvar e continuar
              <ArrowRight size={18} weight="bold" />
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="shell-page">
      <aside className="sidebar">
        <div>
          <nav className="sidebar__nav">
            {allowedMenu.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.key;
              return (
                <button
                  key={item.key}
                  className={`sidebar__item ${isActive ? "sidebar__item--active" : ""}`}
                  onClick={() => {
                    setActiveView(item.key);
                    setView(item.key);
                  }}
                  type="button"
                >
                  <Icon size={22} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <button className="sidebar__logout" onClick={handleLogout} type="button">
          <SignOut size={22} />
          <span>Sair do Sistema</span>
        </button>
      </aside>

      <section className="shell-content">
        <header className="topbar">
          <button className="icon-button" type="button" aria-label="Abrir menu">
            <List size={24} />
          </button>
          <div className="topbar__brand" aria-label="ALC Pereira Filho Transportes">
            <img src={logoSrc} alt="ALC Pereira Filho Transportes" />
          </div>
          <div className="topbar__actions">
            <button className="icon-button" type="button" aria-label="Notificacoes">
              <Bell size={22} />
            </button>
            <button className="profile-chip" type="button">
              <span className="profile-chip__avatar">{currentUser?.name.slice(0, 2).toUpperCase()}</span>
              <span>
                <strong>{currentUser?.name}</strong>
                <small>{currentUser?.email}</small>
              </span>
            </button>
          </div>
        </header>

        {loadingMessage ? (
          <div className="panel">
            <p className="loading-note">{loadingMessage}</p>
          </div>
        ) : null}

        {loginError ? (
          <div className="panel">
            <p className="form-error">{loginError}</p>
          </div>
        ) : null}

        {flashMessage ? (
          <div className="panel">
            <p className={flashMessage.type === "success" ? "success-note" : "form-error"}>
              {flashMessage.text}
            </p>
          </div>
        ) : null}

        {activeView === "dashboard" ? (
          <DashboardScreen
            currentUser={currentUser}
            summary={dashboardSummary}
            onOpenCreateUser={openUsersCreateModal}
            onOpenPdfUpload={openPdfUploadShortcut}
          />
        ) : null}
        {activeView === "periods" ? (
          <PeriodsScreen
            currentUser={currentUser}
            bases={paymentBases}
            periods={paymentPeriods}
            onCreatePeriod={handleCreatePeriod}
            onDeletePeriod={requestDeletePeriod}
          />
        ) : null}
        {activeView === "pdfs" ? (
          <PdfsScreen
            uploads={uploads}
            uploadProgress={uploadProgress}
            uploadHistory={uploadHistory}
            onCloseHistory={() => setUploadHistory(null)}
            onDeleteUpload={requestDeleteUpload}
            onDownloadUpload={handleDownloadUpload}
            onOpenUploadHistory={handleOpenUploadHistory}
            onReplaceUpload={handleReplaceUpload}
            onUploadFiles={handleUploadFiles}
            periods={paymentPeriods}
            bases={paymentBases}
          />
        ) : null}
        {activeView === "users" ? (
          <UsersScreen
            users={users}
            onCreateUser={handleCreateUser}
            onDeleteUser={requestDeleteUser}
            onResetPassword={handleResetPassword}
            onToggleActive={handleToggleActive}
            onToggleBlock={handleToggleBlock}
            onUpdateUser={handleUpdateUser}
            createUserSignal={createUserSignal}
          />
        ) : null}
        {activeView === "atendimento" ? (
          <AtendimentoScreen token={token} currentUser={currentUser} />
        ) : null}
      </section>

      {deleteUserTarget ? (
        <div className="modal-overlay" onClick={() => setDeleteUserTarget(null)}>
          <div
            className="modal-card modal-card--confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-user-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Confirmacao</p>
                <h3 id="delete-user-title">Excluir usuario</h3>
                <p>
                  Excluir permanentemente <strong>{deleteUserTarget.name}</strong> do banco de dados?
                </p>
              </div>
            </div>

            <div className="confirm-actions">
              <button className="ghost-button" type="button" onClick={() => setDeleteUserTarget(null)}>
                Cancelar
              </button>
              <button
                className="primary-button primary-button--inline"
                type="button"
                onClick={async () => {
                  const target = deleteUserTarget;
                  setDeleteUserTarget(null);
                  if (target) {
                    await handleDeleteUser(target);
                  }
                }}
              >
                Excluir agora
                <TrashSimple size={18} weight="bold" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteUploadTarget ? (
        <div className="modal-overlay" onClick={() => setDeleteUploadTarget(null)}>
          <div
            className="modal-card modal-card--confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-upload-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Confirmacao</p>
                <h3 id="delete-upload-title">Remover PDF</h3>
                <p>
                  Remover permanentemente <strong>{deleteUploadTarget.fileName}</strong> da fila operacional?
                </p>
              </div>
            </div>

            <div className="confirm-actions">
              <button className="ghost-button" type="button" onClick={() => setDeleteUploadTarget(null)}>
                Cancelar
              </button>
              <button
                className="primary-button primary-button--inline"
                type="button"
                onClick={async () => {
                  const target = deleteUploadTarget;
                  setDeleteUploadTarget(null);
                  if (target) {
                    await handleDeleteUpload(target.id);
                  }
                }}
              >
                Remover agora
                <TrashSimple size={18} weight="bold" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deletePeriodTarget ? (
        <div className="modal-overlay" onClick={() => setDeletePeriodTarget(null)}>
          <div
            className="modal-card modal-card--confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-period-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Confirmacao</p>
                <h3 id="delete-period-title">Excluir periodo</h3>
                <p>
                  Excluir permanentemente o periodo <strong>{deletePeriodTarget.name}</strong>?
                </p>
              </div>
            </div>

            <div className="confirm-actions">
              <button className="ghost-button" type="button" onClick={() => setDeletePeriodTarget(null)}>
                Cancelar
              </button>
              <button
                className="primary-button primary-button--inline"
                type="button"
                onClick={async () => {
                  const target = deletePeriodTarget;
                  setDeletePeriodTarget(null);
                  if (target) {
                    await handleDeletePeriod(target.id);
                  }
                }}
              >
                Excluir agora
                <TrashSimple size={18} weight="bold" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function DashboardScreen({
  currentUser,
  summary,
  onOpenCreateUser,
  onOpenPdfUpload
}: {
  currentUser: SessionUser | null;
  summary: DashboardSummary;
  onOpenCreateUser: () => void;
  onOpenPdfUpload: () => void;
}) {
  const stats = [
    {
      label: "PDFs Enviados",
      value: String(summary.pdfsSent),
      detail: `${summary.processedPdfs} processados`,
      icon: FilePdf
    },
    {
      label: "Usuarios Cadastrados",
      value: String(summary.usersCount),
      detail: "Base ativa do portal",
      icon: UsersThree
    },
    {
      label: "PDFs Pendentes",
      value: String(summary.pendingPdfs),
      detail: "Aguardando processamento",
      icon: Eye
    },
    {
      label: "Chamados Aguardando",
      value: String(summary.ticketsWaiting),
      detail: `${summary.closedTickets} concluidos`,
      icon: CalendarBlank
    }
  ];

  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Visao geral</p>
          <h1>Bem-vindo ao Portal Administrativo!</h1>
          <p>
            Gerencie informacoes, documentos e usuarios do sistema com uma experiencia corporativa
            clara e modular.
          </p>
        </div>
        <div className="quick-meta">
          <span className="quick-meta__chip">Nivel {currentUser?.level as AccessLevel}</span>
          <span className="quick-meta__chip">Ultimos 7 dias</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>Acesso Rapido</h3>
            <p>Atalhos operacionais para a equipe administrativa</p>
          </div>
        </div>

        <div className="quick-actions">
          {currentUser?.modules.includes("pdfs") ? (
            <button className="quick-action-card" type="button" onClick={onOpenPdfUpload}>
              <div className="quick-action-card__icon">
                <FileArrowUp size={26} />
              </div>
              <div>
                <strong>Enviar PDF</strong>
                <span>Faca o envio de novos documentos.</span>
              </div>
              <ArrowRight size={20} />
            </button>
          ) : null}

          {currentUser?.modules.includes("users") ? (
            <button className="quick-action-card" type="button" onClick={onOpenCreateUser}>
              <div className="quick-action-card__icon">
                <UserCirclePlus size={26} />
              </div>
              <div>
                <strong>Cadastrar Usuario</strong>
                <span>Adicione novos usuarios e niveis de acesso.</span>
              </div>
              <ArrowRight size={20} />
            </button>
          ) : null}
        </div>
      </section>

      <section className="stats-grid">
        {stats.map((item) => {
          const Icon = item.icon;
          return (
            <article className="stat-card" key={item.label}>
              <div className="stat-card__icon">
                <Icon size={30} />
              </div>
              <div>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
                <small>{item.detail}</small>
              </div>
            </article>
          );
        })}
      </section>

      <section className="dashboard-grid">
        <article className="panel panel--chart">
          <div className="panel__header">
            <div>
              <h3>Resumo Geral</h3>
              <p>Evolucao operacional da ultima semana</p>
            </div>
            <button className="ghost-button" type="button">
              Ultimos 7 dias
            </button>
          </div>

          <div className="chart">
            <div className="chart__labels">
              <span>100</span>
              <span>80</span>
              <span>60</span>
              <span>40</span>
              <span>20</span>
              <span>0</span>
            </div>

            <div className="chart__plot">
              <svg viewBox="0 0 520 280" className="chart__svg" role="img" aria-label="Grafico resumido">
                <defs>
                  <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="rgba(255, 95, 83, 0.35)" />
                    <stop offset="100%" stopColor="rgba(255, 95, 83, 0.02)" />
                  </linearGradient>
                </defs>
                <polyline
                  fill="none"
                  stroke="#ff5f53"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points="18,210 96,174 174,156 252,128 330,100 408,138 486,84"
                />
                <polygon
                  fill="url(#chartFill)"
                  points="18,240 18,210 96,174 174,156 252,128 330,100 408,138 486,84 486,240"
                />
                <circle cx="18" cy="210" r="5" fill="#ff5f53" />
                <circle cx="96" cy="174" r="5" fill="#ff5f53" />
                <circle cx="174" cy="156" r="5" fill="#ff5f53" />
                <circle cx="252" cy="128" r="5" fill="#ff5f53" />
                <circle cx="330" cy="100" r="5" fill="#ff5f53" />
                <circle cx="408" cy="138" r="5" fill="#ff5f53" />
                <circle cx="486" cy="84" r="5" fill="#ff5f53" />
              </svg>

              <div className="chart__days">
                <span>01 Mai</span>
                <span>02 Mai</span>
                <span>03 Mai</span>
                <span>04 Mai</span>
                <span>05 Mai</span>
                <span>06 Mai</span>
                <span>07 Mai</span>
              </div>
            </div>
          </div>
        </article>

        <article className="panel">
          <div className="panel__header">
            <div>
              <h3>Atividades Recentes</h3>
              <p>Ultimas acoes auditadas no sistema</p>
            </div>
          </div>

          <div className="activity-list">
            {activities.map((item) => (
              <div className="activity-item" key={`${item.title}-${item.time}`}>
                <div className="activity-item__icon">
                  {item.icon === "pdf" ? <FilePdf size={22} /> : null}
                  {item.icon === "user" ? <UserCirclePlus size={22} /> : null}
                  {item.icon === "view" ? <Eye size={22} /> : null}
                </div>
                <div className="activity-item__body">
                  <strong>{item.title}</strong>
                  <span>{item.subtitle}</span>
                </div>
                <div className="activity-item__meta">
                  <span>{item.date}</span>
                  <small>{item.time}</small>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}

function PeriodsScreen({
  currentUser,
  bases,
  periods,
  onCreatePeriod,
  onDeletePeriod
}: {
  currentUser: SessionUser | null;
  bases: PaymentBase[];
  periods: PaymentPeriod[];
  onCreatePeriod: (payload: {
    name: string;
    startDate: string;
    endDate: string;
    paymentType: "semanal" | "quinzenal" | "mensal";
  }) => Promise<boolean> | boolean;
  onDeletePeriod: (period: PaymentPeriod) => void;
}) {
  const [formValues, setFormValues] = useState({
    name: "",
    startDate: "",
    endDate: "",
    paymentType: "semanal" as "semanal" | "quinzenal" | "mensal"
  });

  const baseByType = useMemo(
    () =>
      bases.reduce<Record<string, PaymentBase[]>>((accumulator, base) => {
        const key = base.paymentType;
        accumulator[key] = [...(accumulator[key] || []), base];
        return accumulator;
      }, {}),
    [bases]
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const success = await onCreatePeriod(formValues);

    if (success) {
      setFormValues({
        name: "",
        startDate: "",
        endDate: "",
        paymentType: "semanal"
      });
    }
  };

  if (!currentUser || (currentUser.level !== "N3" && currentUser.level !== "N4")) {
    return (
      <div className="screen">
      <section className="panel">
          <h3>Acesso restrito</h3>
          <p>Esta funcionalidade esta liberada apenas para N3 e N4.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Administracao de periodos</p>
          <h1>Criacao de Periodo</h1>
          <p>Cadastre intervalos de pagamento e vincule automaticamente as bases corretas por tipo.</p>
        </div>
      </section>

      <section className="stats-grid stats-grid--three">
        <article className="stat-card">
          <div className="stat-card__icon">
            <CalendarBlank size={30} />
          </div>
          <div>
            <strong>{periods.length}</strong>
            <span>Periodos cadastrados</span>
            <small>Disponiveis para envio de PDFs</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <GearSix size={30} />
          </div>
          <div>
            <strong>{bases.length}</strong>
            <span>Bases ativas</span>
            <small>Carregadas do banco de dados</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <UsersThree size={30} />
          </div>
          <div>
            <strong>N3/N4</strong>
            <span>Autorizacao</span>
            <small>Controle administrativo total</small>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>Novo periodo de pagamento</h3>
            <p>Escolha o intervalo, a descricao e o tipo de periodicidade.</p>
          </div>
        </div>

        <form className="admin-form period-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Descricao do periodo</span>
            <input
              name="name"
              placeholder="Pagamento Semanal 1 a 7"
              required
              value={formValues.name}
              onChange={(event) =>
                setFormValues((current) => ({
                  ...current,
                  name: event.target.value
                }))
              }
            />
          </label>

          <label className="field">
            <span>Tipo de pagamento</span>
            <select
              name="paymentType"
              className="field__select"
              value={formValues.paymentType}
              onChange={(event) =>
                setFormValues((current) => ({
                  ...current,
                  paymentType: event.target.value as "semanal" | "quinzenal" | "mensal"
                }))
              }
            >
              <option value="semanal">SEMANAL</option>
              <option value="quinzenal">QUINZENAL</option>
              <option value="mensal">MENSAL</option>
            </select>
          </label>

          <label className="field">
            <span>Data de inicio</span>
            <input
              name="startDate"
              type="date"
              required
              value={formValues.startDate}
              onChange={(event) =>
                setFormValues((current) => ({
                  ...current,
                  startDate: event.target.value
                }))
              }
            />
          </label>

          <label className="field">
            <span>Data de fim</span>
            <input
              name="endDate"
              type="date"
              required
              value={formValues.endDate}
              onChange={(event) =>
                setFormValues((current) => ({
                  ...current,
                  endDate: event.target.value
                }))
              }
            />
          </label>

          <div className="field">
            <span>Bases vinculadas automaticamente</span>
            <div className="checkbox-grid">
              {(formValues.paymentType === "mensal" ? bases : baseByType[formValues.paymentType] || []).map(
                (base) => (
                  <span className="mini-chip" key={base.id}>
                    {base.name}
                  </span>
                )
              )}
            </div>
          </div>

          <div className="admin-form__actions">
            <button className="primary-button primary-button--inline" type="submit">
              Criar periodo
              <ArrowRight size={18} weight="bold" />
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>Periodos cadastrados</h3>
            <p>Os periodos aparecem aqui e tambem ficam disponiveis na tela de envio de PDFs.</p>
          </div>
        </div>

        <div className="period-list">
          {periods.map((period) => {
            const uploadedByBaseEntries = period.bases.map((base) => ({
              ...base,
              total: period.uploadedByBase[base.id] || 0
            }));
            return (
              <article className="period-card" key={period.id}>
                <div>
                  <p className="eyebrow">Periodo {period.paymentType.toUpperCase()}</p>
                  <h4>{period.name}</h4>
                  <p>
                    {formatDateOnly(period.startDate)} a {formatDateOnly(period.endDate)}
                  </p>
                </div>

                <div className="period-card__meta">
                  <span className={`status-pill ${period.status === "disponivel" ? "status-pill--active" : ""}`}>
                    {formatStatusLabel(period.status)}
                  </span>
                  <strong>{period.uploadedTotal}</strong>
                  <small>PDFs anexados</small>
                </div>

                <div className="module-chips">
                  {uploadedByBaseEntries.map((base) => (
                    <span className="mini-chip" key={`${period.id}-${base.id}`}>
                      {base.name} ({base.total} PDF{base.total === 1 ? "" : "s"})
                    </span>
                  ))}
                </div>

                <div className="period-card__actions">
                  <button
                    className="ghost-button ghost-button--small ghost-button--danger"
                    type="button"
                    onClick={() => onDeletePeriod(period)}
                  >
                    Excluir
                    <TrashSimple size={16} />
                  </button>
                  <button className="ghost-button ghost-button--small" type="button" disabled>
                    Aprovar periodo
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function PdfsScreen({
  uploads,
  uploadProgress,
  uploadHistory,
  onUploadFiles,
  onReplaceUpload,
  onDownloadUpload,
  onOpenUploadHistory,
  onDeleteUpload,
  onCloseHistory,
  periods,
  bases
}: {
  uploads: UploadRow[];
  uploadProgress: UploadProgressState | null;
  uploadHistory: UploadHistoryState;
  onUploadFiles: (files: File[], fields?: { periodId?: string; basePaymentId?: string }) => Promise<void> | void;
  onReplaceUpload: (uploadId: string, file: File) => Promise<void> | void;
  onDownloadUpload: (upload: UploadRow) => Promise<void> | void;
  onOpenUploadHistory: (uploadId: string) => Promise<void> | void;
  onDeleteUpload: (upload: UploadRow) => void;
  onCloseHistory: () => void;
  periods: PaymentPeriod[];
  bases: PaymentBase[];
}) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [selectedBaseId, setSelectedBaseId] = useState("");
  const [expandedBatchKey, setExpandedBatchKey] = useState("");

  const selectedPeriod = periods.find((period) => period.id === selectedPeriodId) || null;
  const allowedBases = selectedPeriod
    ? selectedPeriod.paymentType === "mensal"
      ? bases
      : bases.filter((base) => base.paymentType === selectedPeriod.paymentType)
    : [];

  useEffect(() => {
    if (selectedPeriod && !allowedBases.some((base) => base.id === selectedBaseId)) {
      setSelectedBaseId(allowedBases[0]?.id || "");
    }
  }, [allowedBases, selectedBaseId, selectedPeriod]);

  const visibleUploads = useMemo(() => {
    return uploads.filter((row) => {
      const matchesSearch =
        row.fileName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        row.owner.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === "todos" || row.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [searchTerm, statusFilter, uploads]);

  const uploadBatches = useMemo(() => {
    const grouped = new Map<
      string,
      {
        key: string;
        ownerName: string;
        periodName: string;
        baseName: string;
        lastSentAt: string;
        uploads: UploadRow[];
      }
    >();

    visibleUploads
      .slice()
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
      .forEach((row) => {
        const key = `${row.periodId || "sem-periodo"}|${row.baseId || "sem-base"}|${row.owner}|${row.sentAt}`;
        const existing = grouped.get(key);

        if (existing) {
          existing.uploads.push(row);
          if (new Date(row.sentAt).getTime() > new Date(existing.lastSentAt).getTime()) {
            existing.lastSentAt = row.sentAt;
          }

          return;
        }

        grouped.set(key, {
          key,
          periodName: row.periodName || "Periodo nao definido",
          baseName: row.baseName || "Base nao definida",
          ownerName: row.owner,
          lastSentAt: row.sentAt,
          uploads: [row]
        });
      });

    return Array.from(grouped.values()).sort(
      (batchA, batchB) => new Date(batchB.lastSentAt).getTime() - new Date(batchA.lastSentAt).getTime()
    );
  }, [visibleUploads]);

  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Operacao de documentos</p>
          <h1>Envio de PDFs</h1>
          <p>Upload multiplo, acompanhamento de status e substituicao de arquivos versionados.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>Periodo ativo para envio</h3>
            <p>Escolha o periodo e a base antes de anexar os PDFs.</p>
          </div>
        </div>

        <div className="filters-row filters-row--stack">
          <label className="filter-select">
            <CalendarBlank size={18} />
            <select value={selectedPeriodId} onChange={(event) => setSelectedPeriodId(event.target.value)}>
              <option value="">Selecione um periodo</option>
              {periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.name} - {formatStatusLabel(period.status)}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-select">
            <GearSix size={18} />
            <select value={selectedBaseId} onChange={(event) => setSelectedBaseId(event.target.value)}>
              <option value="">Selecione uma base</option>
              {allowedBases.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.name}
                </option>
              ))}
            </select>
          </label>

          <button
            className="primary-button primary-button--inline file-picker"
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!selectedPeriodId || !selectedBaseId}
          >
            Novo upload
            <FileArrowUp size={18} weight="bold" />
          </button>
        </div>

        <div className="period-tiles">
          {periods.map((period) => (
            <article className="period-tile" key={period.id}>
              <strong>{period.name}</strong>
              <span>{period.paymentType.toUpperCase()}</span>
              <small>{formatStatusLabel(period.status)}</small>
            </article>
          ))}
        </div>

        <input
          ref={uploadInputRef}
          className="file-picker__input"
          type="file"
          accept="application/pdf"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            void onUploadFiles(files, {
              periodId: selectedPeriodId,
              basePaymentId: selectedBaseId
            });
            event.currentTarget.value = "";
          }}
        />
      </section>

      <section className="panel panel--compact">
        <div className="filters-row">
          <label className="search-field">
            <MagnifyingGlass size={18} />
            <input
              placeholder="Buscar por arquivo ou responsavel"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>

          <label className="filter-select">
            <FunnelSimple size={18} />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="todos">Todos os status</option>
              <option value="pendente">Pendente</option>
              <option value="processado">Processado</option>
              <option value="substituido">Substituido</option>
              <option value="erro">Erro</option>
            </select>
          </label>
        </div>

        {uploadProgress ? (
          <div className="progress-card">
            <div className="progress-card__header">
              <strong>{uploadProgress.label}</strong>
              <span>{uploadProgress.percent}%</span>
            </div>
            <div className="progress-bar">
              <span style={{ width: `${uploadProgress.percent}%` }} />
            </div>
          </div>
        ) : null}
      </section>

        <section className="panel">
          <div className="panel__header">
            <div>
              <h3>Fila de documentos</h3>
              <p>
                {uploadBatches.length} lote(s) visivel(is) na fila operacional e {visibleUploads.length} documento(s) anexado(s)
              </p>
            </div>
          <div className="quick-meta">
            <span className="quick-meta__chip">Pendente</span>
            <span className="quick-meta__chip">Processado</span>
          </div>
        </div>

          <div className="upload-batches">
            {uploadBatches.map((batch) => (
              <article className="upload-batch" key={batch.key}>
                <div className="upload-batch__header">
                  <div>
                    <h4>Lote {batch.baseName}</h4>
                    <p>
                      {batch.ownerName} · {batch.periodName} ·{" "}
                      {new Date(batch.lastSentAt).toLocaleString("pt-BR")}
                    </p>
                  </div>
                  <button
                    className="ghost-button ghost-button--small"
                    type="button"
                    onClick={() =>
                      setExpandedBatchKey((current) => (current === batch.key ? "" : batch.key))
                    }
                  >
                    {expandedBatchKey === batch.key ? "Ocultar PDFs" : `Abrir lote (${batch.uploads.length})`}
                  </button>
                </div>

                <p className="upload-batch__meta">Total: {batch.uploads.length} PDF(s)</p>

                {expandedBatchKey === batch.key ? (
                  <div className="upload-batch__files">
                    {batch.uploads.map((row) => (
                      <div className="upload-batch__file" key={row.id}>
                        <div>
                          <strong>{row.fileName}</strong>
                          <span>
                            {row.status} · {new Date(row.sentAt).toLocaleString("pt-BR")}
                          </span>
                        </div>

                        <div className="table-actions">
                          <button
                            className="ghost-button ghost-button--small"
                            type="button"
                            onClick={() => void onDownloadUpload(row)}
                          >
                            Baixar
                          </button>
                          <button
                            className="ghost-button ghost-button--small"
                            type="button"
                            onClick={() => void onOpenUploadHistory(row.id)}
                          >
                            Historico
                          </button>
                          <label className="ghost-button ghost-button--small file-picker file-picker--ghost">
                            Substituir
                            <input
                              type="file"
                              accept="application/pdf"
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) {
                                  void onReplaceUpload(row.id, file);
                                }
                                event.currentTarget.value = "";
                              }}
                            />
                          </label>
                          <button
                            className="ghost-button ghost-button--small ghost-button--danger"
                            type="button"
                            onClick={() => onDeleteUpload(row)}
                          >
                            <TrashSimple size={16} />
                            Remover
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}

            {uploadBatches.length === 0 ? <div className="crm-empty">Nenhum PDF na fila operacional para os filtros atuais.</div> : null}
          </div>
        </section>

      {uploadHistory ? (
        <section className="panel">
          <div className="panel__header">
            <div>
              <h3>Historico de Versoes</h3>
              <p>Linha completa de substituicoes do PDF selecionado</p>
            </div>
            <button className="ghost-button" type="button" onClick={onCloseHistory}>
              Fechar
            </button>
          </div>

          <div className="history-list">
            {uploadHistory.entries.map((entry) => (
              <article className="history-item" key={entry.id}>
                <div className="history-item__badge">
                  <ClockCounterClockwise size={18} />
                </div>
                <div className="history-item__body">
                  <strong>
                    Versao {entry.version} · {entry.fileName}
                  </strong>
                  <span>
                    {entry.owner} · {new Date(entry.sentAt).toLocaleString("pt-BR")}
                  </span>
                </div>
                <span className="status-pill">{entry.status}</span>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function UsersScreen({
  users,
  onCreateUser,
  onDeleteUser,
  onUpdateUser,
  onToggleBlock,
  onToggleActive,
  onResetPassword,
  createUserSignal
}: {
  users: UserSummary[];
  onCreateUser: (payload: UserPayload) => Promise<boolean> | boolean;
  onDeleteUser: (user: UserSummary) => void;
  onUpdateUser: (userId: string, payload: UserPayload) => Promise<boolean> | boolean;
  onToggleBlock: (user: UserSummary) => Promise<void> | void;
  onToggleActive: (user: UserSummary) => Promise<void> | void;
  onResetPassword: (userId: string) => Promise<void> | void;
  createUserSignal: number;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [levelFilter, setLevelFilter] = useState("todos");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [formValues, setFormValues] = useState({
    name: "",
    email: "",
    level: "N1" as UserPayload["level"]
  });
  const [selectedModules, setSelectedModules] = useState<string[]>(["dashboard", "pdfs"]);
  const lastCreateSignal = useRef(0);

  const resetForm = () => {
    setEditingUserId(null);
    setFormValues({
      name: "",
      email: "",
      level: "N1"
    });
    setSelectedModules(["dashboard", "pdfs"]);
  };

  const openCreateModal = () => {
    resetForm();
    setIsModalOpen(true);
  };

  const openEditModal = (user: UserSummary) => {
    setEditingUserId(user.id);
    setFormValues({
      name: user.name,
      email: user.email,
      level: user.level
    });
    setSelectedModules(user.modules);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    resetForm();
  };

  useEffect(() => {
    if (createUserSignal > lastCreateSignal.current) {
      lastCreateSignal.current = createUserSignal;
      openCreateModal();
    }
  }, [createUserSignal]);

  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      const normalizedSearch = searchTerm.toLowerCase();
      const matchesSearch =
        user.name.toLowerCase().includes(normalizedSearch) ||
        user.email.toLowerCase().includes(normalizedSearch);
      const matchesLevel = levelFilter === "todos" || user.level === levelFilter;
      const computedStatus = !user.active ? "inativo" : user.blocked ? "bloqueado" : "ativo";
      const matchesStatus = statusFilter === "todos" || computedStatus === statusFilter;

      return matchesSearch && matchesLevel && matchesStatus;
    });
  }, [levelFilter, searchTerm, statusFilter, users]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload: UserPayload = {
      name: String(formData.get("name") || "").trim(),
      email: String(formData.get("email") || "").trim().toLowerCase(),
      level: String(formData.get("level") || "N1") as UserPayload["level"],
      modules: selectedModules
    };

    let success = false;
    if (editingUserId) {
      success = await onUpdateUser(editingUserId, payload);
    } else {
      success = await onCreateUser(payload);
    }

    if (success) {
      closeModal();
    }
  };

  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Administracao</p>
          <h1>Cadastro de Usuarios</h1>
          <p>Gestao de niveis, status, modulos liberados e historico operacional.</p>
        </div>
        <button className="primary-button primary-button--inline" type="button" onClick={openCreateModal}>
          Novo usuario
          <UserCirclePlus size={18} weight="bold" />
        </button>
      </section>

      <section className="stats-grid stats-grid--three">
        <article className="stat-card">
          <div className="stat-card__icon">
            <UsersThree size={30} />
          </div>
          <div>
            <strong>{users.length}</strong>
            <span>Usuarios na base</span>
            <small>Sincronizados com PostgreSQL</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <GearSix size={30} />
          </div>
          <div>
            <strong>RBAC</strong>
            <span>Controle por perfil e modulo</span>
            <small>Grant e deny por usuario</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <ChartLineUp size={30} />
          </div>
          <div>
            <strong>Auditoria</strong>
            <span>Trilha completa de operacoes</span>
            <small>Login, senha, upload e bloqueios</small>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>Busca e filtros</h3>
            <p>Refine a operacao por nome, e-mail, nivel e situacao</p>
          </div>
        </div>

        <div className="filters-row">
          <label className="search-field">
            <MagnifyingGlass size={18} />
            <input
              placeholder="Buscar usuario por nome ou e-mail"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>

          <label className="filter-select">
            <FunnelSimple size={18} />
            <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)}>
              <option value="todos">Todos os niveis</option>
              <option value="N1">N1</option>
              <option value="N2">N2</option>
              <option value="N3">N3</option>
              <option value="N4">N4</option>
            </select>
          </label>

          <label className="filter-select">
            <FunnelSimple size={18} />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="todos">Todos os status</option>
              <option value="ativo">Ativo</option>
              <option value="bloqueado">Bloqueado</option>
              <option value="inativo">Inativo</option>
            </select>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>Usuarios cadastrados</h3>
            <p>{filteredUsers.length} usuario(s) retornado(s) pelos filtros atuais</p>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Nivel</th>
                <th>Status</th>
                <th>Ultimo acesso</th>
                <th>Modulos</th>
                <th>Acoes</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{user.level}</td>
                  <td>
                    <span className={`status-pill ${user.active && !user.blocked ? "status-pill--active" : ""}`}>
                      {user.active ? (user.blocked ? "Bloqueado" : "Ativo") : "Desativado"}
                    </span>
                  </td>
                  <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("pt-BR") : "Sem acesso"}</td>
                  <td>
                    <div className="module-chips">
                      {user.modules.map((moduleCode) => (
                        <span className="mini-chip" key={`${user.id}-${moduleCode}`}>
                          {moduleCode}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="table-actions">
                      <button
                        className="ghost-button ghost-button--small"
                        type="button"
                        onClick={() => openEditModal(user)}
                      >
                        <PencilSimple size={16} />
                        Editar
                      </button>
                      <button
                        className="ghost-button ghost-button--small"
                        type="button"
                        onClick={() => void onToggleBlock(user)}
                      >
                        {user.blocked ? "Desbloquear" : "Bloquear"}
                      </button>
                      <button
                        className="ghost-button ghost-button--small ghost-button--danger"
                        type="button"
                        onClick={() => onDeleteUser(user)}
                      >
                        <TrashSimple size={16} />
                        Excluir
                      </button>
                      <button
                        className="ghost-button ghost-button--small"
                        type="button"
                        onClick={() => void onResetPassword(user.id)}
                      >
                        Resetar senha
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {isModalOpen ? (
        <div className="modal-overlay" onClick={closeModal}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Administracao</p>
                <h3 id="user-modal-title">{editingUserId ? "Editar usuario" : "Novo usuario"}</h3>
                <p>Cadastro com senha temporaria 0000 e controle de modulos por usuario</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={closeModal}>
                Fechar
              </button>
            </div>

            <form className="admin-form admin-form--modal" onSubmit={handleSubmit}>
              <label className="field">
                <span>Nome</span>
                <input
                  name="name"
                  placeholder="Nome completo"
                  required
                  value={formValues.name}
                  onChange={(event) =>
                    setFormValues((current) => ({
                      ...current,
                      name: event.target.value
                    }))
                  }
                />
              </label>

              <label className="field">
                <span>E-mail</span>
                <input
                  name="email"
                  type="email"
                  placeholder="email@empresa.com"
                  required
                  value={formValues.email}
                  onChange={(event) =>
                    setFormValues((current) => ({
                      ...current,
                      email: event.target.value
                    }))
                  }
                />
              </label>

              <label className="field">
                <span>Nivel</span>
                <select
                  name="level"
                  className="field__select"
                  value={formValues.level}
                  onChange={(event) =>
                    setFormValues((current) => ({
                      ...current,
                      level: event.target.value as UserPayload["level"]
                    }))
                  }
                >
                  <option value="N1">N1</option>
                  <option value="N2">N2</option>
                  <option value="N3">N3</option>
                  <option value="N4">N4</option>
                </select>
              </label>

              <div className="field">
                <span>Modulos</span>
                <div className="checkbox-grid">
                  {["dashboard", "pdfs", "users", "financeiro"].map((moduleCode) => (
                    <label className="checkbox-chip" key={moduleCode}>
                      <input
                        type="checkbox"
                        checked={selectedModules.includes(moduleCode)}
                        onChange={(event) => {
                          setSelectedModules((current) =>
                            event.target.checked
                              ? Array.from(new Set([...current, moduleCode]))
                              : current.filter((item) => item !== moduleCode)
                          );
                        }}
                      />
                      <span>{moduleCode}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="admin-form__actions">
                <button className="primary-button primary-button--inline" type="submit">
                  {editingUserId ? "Salvar alteracoes" : "Criar usuario"}
                  <ArrowRight size={18} weight="bold" />
                </button>

                <button className="ghost-button" type="button" onClick={closeModal}>
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AtendimentoScreen({
  token,
  currentUser
}: {
  token: string;
  currentUser: SessionUser | null;
}) {
  const isAdmin = currentUser?.level === "N3" || currentUser?.level === "N4";
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<AtendimentoMotoristaSearch[]>([]);
  const [selectedMotoristaId, setSelectedMotoristaId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AtendimentoDetail | null>(null);
  const [classificacoes, setClassificacoes] = useState<AtendimentoClassificacao[]>([]);
  const [selectedClassificacoes, setSelectedClassificacoes] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<AtendimentoDetail["chamados"][number]["status"] | "todos">(
    "todos"
  );
  const [loading, setLoading] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [editingNote, setEditingNote] = useState<{ id: string; content: string } | null>(null);
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [ticketAction, setTicketAction] = useState<
    | { mode: "move"; chamadoId: string; subject: string }
    | { mode: "close"; chamadoId: string; subject: string }
    | null
  >(null);
  const [ticketFiles, setTicketFiles] = useState<File[]>([]);
  const searchTimerRef = useRef<number | null>(null);

  const filteredChamados = useMemo(() => {
    if (!detail) {
      return [];
    }

    return detail.chamados.filter((ticket) => statusFilter === "todos" || ticket.status === statusFilter);
  }, [detail, statusFilter]);

  useEffect(() => {
    if (!token) {
      return;
    }

    void (async () => {
      try {
        const tags = await fetchAtendimentoClassificacoes(token);
        setClassificacoes(tags);
      } catch {
        setClassificacoes([]);
      }
    })();
  }, [token]);

  useEffect(() => {
    if (searchTimerRef.current) {
      window.clearTimeout(searchTimerRef.current);
    }

    const query = searchTerm.trim();

    if (query.length < 2) {
      setSearchResults([]);
      return;
    }

    searchTimerRef.current = window.setTimeout(() => {
      void (async () => {
        setLoading("Buscando motorista...");

        try {
          const results = await searchAtendimentoMotoristas(token, query);
          setSearchResults(results);

          if (results.length > 0 && !selectedMotoristaId) {
            setSelectedMotoristaId(results[0].id);
          }
        } catch (error) {
          setSearchResults([]);
          setDetail(null);
          setSelectedMotoristaId(null);
          setLoading(error instanceof Error ? error.message : "Falha ao buscar motorista.");
        } finally {
          setLoading("");
        }
      })();
    }, 250);

    return () => {
      if (searchTimerRef.current) {
        window.clearTimeout(searchTimerRef.current);
      }
    };
  }, [searchTerm, selectedMotoristaId, token]);

  useEffect(() => {
    if (!token || !selectedMotoristaId) {
      setDetail(null);
      return;
    }

    void (async () => {
      setLoading("Carregando atendimento do motorista...");

      try {
        const motorista = await fetchAtendimentoMotorista(token, selectedMotoristaId);
        setDetail(motorista);
        setSelectedClassificacoes(motorista.motorista.classificacoes.map((item) => item.id));
        setNoteContent("");
      } catch (error) {
        setDetail(null);
        setLoading(error instanceof Error ? error.message : "Falha ao carregar motorista.");
      } finally {
        setLoading("");
      }
    })();
  }, [selectedMotoristaId, token]);

  useEffect(() => {
    if (!detail) {
      setSelectedClassificacoes([]);
      return;
    }

    setSelectedClassificacoes(detail.motorista.classificacoes.map((item) => item.id));
  }, [detail]);

  const refreshDetail = async (motoristaId = selectedMotoristaId) => {
    if (!token || !motoristaId) {
      return;
    }

    const motorista = await fetchAtendimentoMotorista(token, motoristaId);
    setDetail(motorista);
    setSelectedClassificacoes(motorista.motorista.classificacoes.map((item) => item.id));
  };

  const handleToggleTag = (id: string) => {
    setSelectedClassificacoes((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const handleSaveTags = async () => {
    if (!detail) {
      return;
    }

    setLoading("Atualizando classificacoes...");

    try {
      const response = await updateMotoristaClassificacoes(
        token,
        detail.motorista.id,
        selectedClassificacoes
      );
      if (response.detail) {
        setDetail(response.detail);
        setSelectedClassificacoes(response.detail.motorista.classificacoes.map((item) => item.id));
      } else {
        await refreshDetail(detail.motorista.id);
      }
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao atualizar classificacoes.");
    } finally {
      setLoading("");
    }
  };

  const handleCreateNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!detail) {
      return;
    }

    const content = noteContent.trim();

    if (!content) {
      return;
    }

    setLoading("Salvando nota...");

    try {
      const response = await createAtendimentoNota(token, detail.motorista.id, content);
      if (response.detail) {
        setDetail(response.detail);
      } else {
        await refreshDetail(detail.motorista.id);
      }
      setNoteContent("");
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao salvar nota.");
    } finally {
      setLoading("");
    }
  };

  const handleUpdateNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!detail || !editingNote) {
      return;
    }

    setLoading("Atualizando nota...");

    try {
      const response = await updateAtendimentoNota(
        token,
        detail.motorista.id,
        editingNote.id,
        editingNote.content.trim()
      );

      if (response.detail) {
        setDetail(response.detail);
      } else {
        await refreshDetail(detail.motorista.id);
      }

      setEditingNote(null);
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao atualizar nota.");
    } finally {
      setLoading("");
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    if (!detail) {
      return;
    }

    setLoading("Excluindo nota...");

    try {
      await deleteAtendimentoNota(token, detail.motorista.id, noteId);
      await refreshDetail(detail.motorista.id);
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao excluir nota.");
    } finally {
      setLoading("");
    }
  };

  const handleCreateTicket = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!detail) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const assunto = String(formData.get("assunto") || "").trim();
    const categoria = String(formData.get("categoria") || "").trim();
    const prioridade = String(formData.get("prioridade") || "media") as
      | "baixa"
      | "media"
      | "alta"
      | "critica";
    const descricao = String(formData.get("descricao") || "").trim();
    const responsavelId = String(formData.get("responsavelId") || currentUser?.id || "").trim();

    if (!assunto || !categoria || !descricao) {
      return;
    }

    setLoading("Criando chamado...");

    try {
      const response = await createAtendimentoChamado(token, detail.motorista.id, {
        assunto,
        categoria,
        prioridade,
        descricao,
        responsavelId,
        attachments: ticketFiles
      });
      if (response.detail) {
        setDetail(response.detail);
      } else {
        await refreshDetail(detail.motorista.id);
      }
      setTicketFiles([]);
      setNewTicketOpen(false);
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao criar chamado.");
    } finally {
      setLoading("");
    }
  };

  const handleMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!ticketAction || !detail) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const description = String(formData.get("description") || "").trim();

    if (!description) {
      return;
    }

    setLoading("Registrando movimentacao...");

    try {
      await createAtendimentoMovimento(token, ticketAction.chamadoId, description, ticketFiles);
      await refreshDetail(detail.motorista.id);
      setTicketFiles([]);
      setTicketAction(null);
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao registrar movimentacao.");
    } finally {
      setLoading("");
    }
  };

  const handleCloseTicket = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!ticketAction || !detail) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const motivoConclusao = String(formData.get("motivoConclusao") || "").trim();
    const solucaoAplicada = String(formData.get("solucaoAplicada") || "").trim();
    const observacoesFinais = String(formData.get("observacoesFinais") || "").trim();

    setLoading("Encerrando chamado...");

    try {
      await closeAtendimentoChamado(token, ticketAction.chamadoId, {
        motivoConclusao,
        solucaoAplicada,
        observacoesFinais
      });
      await refreshDetail(detail.motorista.id);
      setTicketAction(null);
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao encerrar chamado.");
    } finally {
      setLoading("");
    }
  };

  return (
    <div className="screen screen--crm">
      <section className="screen__intro screen__intro--crm">
        <div>
          <p className="eyebrow">Atendimento</p>
          <h1>CRM do Motorista</h1>
          <p>
            Localize o motorista por nome ou CPF, acompanhe o historico completo e resolva os
            chamados em uma unica tela.
          </p>
        </div>
        <div className="quick-meta">
          <span className="quick-meta__chip">RBAC</span>
          <span className="quick-meta__chip">{isAdmin ? "N3/N4" : "Modulo liberado"}</span>
        </div>
      </section>

      <section className="panel panel--crm-search">
        <div className="panel__header">
          <div>
            <h3>Pesquisa do motorista</h3>
            <p>Busque por nome completo ou CPF para carregar todos os dados do cadastro.</p>
          </div>
        </div>

        <div className="filters-row filters-row--crm">
          <label className="search-field">
            <MagnifyingGlass size={18} />
            <input
              placeholder="Digite o nome ou CPF do motorista"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>

          <div className="crm-search-results">
            {searchResults.length > 0 ? (
              searchResults.map((result) => (
                <button
                  key={result.id}
                  className={`crm-search-card ${
                    selectedMotoristaId === result.id ? "crm-search-card--active" : ""
                  }`}
                  type="button"
                  onClick={() => setSelectedMotoristaId(result.id)}
                >
                  <strong>{result.name}</strong>
                  <span>{result.cpf}</span>
                  <small>
                    {result.city || "Sem cidade"} · {result.status}
                  </small>
                </button>
              ))
            ) : (
              <div className="crm-search-empty">Digite ao menos 2 caracteres para iniciar a busca.</div>
            )}
          </div>
        </div>
      </section>

      {loading ? (
        <section className="panel">
          <p className="loading-note">{loading}</p>
        </section>
      ) : null}

      {detail ? (
        <>
          <section className="crm-grid">
            <article className="panel crm-card">
              <div className="panel__header">
                <div>
                  <h3>Dados do Motorista</h3>
                  <p>Informacoes cadastrais carregadas diretamente do banco de dados.</p>
                </div>
                <span className="status-pill status-pill--active">{detail.motorista.statusCadastro}</span>
              </div>

              <div className="crm-driver">
                <div className="crm-driver__hero">
                  <div>
                    <p className="eyebrow">Motorista selecionado</p>
                    <h4>{detail.motorista.nome}</h4>
                    <p>{detail.motorista.cpf}</p>
                  </div>
                  <div className="crm-driver__meta">
                    <span>{detail.motorista.cidade || "Cidade nao informada"}</span>
                    <span>{detail.motorista.estado || "--"}</span>
                    <span>{detail.motorista.empresaVinculada || "Sem empresa vinculada"}</span>
                  </div>
                </div>

                <div className="crm-driver__grid">
                  <div><strong>CPF</strong><span>{detail.motorista.cpf}</span></div>
                  <div><strong>RG</strong><span>{detail.motorista.rg || "Nao informado"}</span></div>
                  <div><strong>Nascimento</strong><span>{detail.motorista.dataNascimento ? new Date(detail.motorista.dataNascimento).toLocaleDateString("pt-BR") : "Nao informado"}</span></div>
                  <div><strong>Telefone</strong><span>{detail.motorista.telefone || "Nao informado"}</span></div>
                  <div><strong>WhatsApp</strong><span>{detail.motorista.whatsapp || "Nao informado"}</span></div>
                  <div><strong>E-mail</strong><span>{detail.motorista.email || "Nao informado"}</span></div>
                  <div><strong>Endereco</strong><span>{detail.motorista.endereco || "Nao informado"}</span></div>
                  <div><strong>Cidade / UF</strong><span>{detail.motorista.cidade || "Nao informado"} {detail.motorista.estado ? `· ${detail.motorista.estado}` : ""}</span></div>
                  <div><strong>CEP</strong><span>{detail.motorista.cep || "Nao informado"}</span></div>
                  <div><strong>Criado em</strong><span>{new Date(detail.motorista.dataCriacao).toLocaleString("pt-BR")}</span></div>
                  <div><strong>Atualizado em</strong><span>{new Date(detail.motorista.ultimaAtualizacao).toLocaleString("pt-BR")}</span></div>
                  <div><strong>Observacoes</strong><span>{detail.motorista.observacoesGerais || "Sem observacoes"}</span></div>
                </div>
              </div>
            </article>

            <article className="panel crm-card">
              <div className="panel__header">
                <div>
                  <h3>Classificacoes do perfil</h3>
                  <p>Etiquetas comportamentais editaveis sem alterar codigo.</p>
                </div>
                <button className="ghost-button" type="button" onClick={handleSaveTags}>
                  Salvar tags
                </button>
              </div>

              <div className="checkbox-grid crm-tags">
                {classificacoes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`checkbox-chip ${
                      selectedClassificacoes.includes(item.id) ? "checkbox-chip--active" : ""
                    }`}
                    onClick={() => handleToggleTag(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </article>
          </section>

          <section className="crm-grid crm-grid--two">
            <article className="panel crm-card">
              <div className="panel__header">
                <div>
                  <h3>Historico de PDFs</h3>
                  <p>Arquivos mais recentes para os mais antigos.</p>
                </div>
              </div>

              <div className="crm-list">
                {detail.pdfs.length > 0 ? (
                  detail.pdfs.map((pdf) => (
                    <article className="crm-list__item" key={pdf.id}>
                      <div>
                        <strong>{pdf.nomeDocumento}</strong>
                        <span>
                          {pdf.tipo} · {new Date(pdf.dataEnvio).toLocaleString("pt-BR")}
                        </span>
                        <small>{pdf.usuarioResponsavel}</small>
                      </div>
                      <div className="table-actions">
                        <span className="status-pill">{formatStatusLabel(pdf.status)}</span>
                        <button
                          className="ghost-button ghost-button--small"
                          type="button"
                          onClick={() => window.open(`${pdf.downloadUrl}`, "_blank")}
                        >
                          Visualizar
                        </button>
                        <button
                          className="ghost-button ghost-button--small"
                          type="button"
                          onClick={() => window.open(`${pdf.downloadUrl}`, "_blank")}
                        >
                          Download
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="crm-empty">Nenhum PDF vinculado a este motorista.</div>
                )}
              </div>
            </article>

            <article className="panel crm-card">
              <div className="panel__header">
                <div>
                  <h3>Notas internas</h3>
                  <p>Conteudo restrito a equipe interna.</p>
                </div>
              </div>

              <form className="crm-note-form" onSubmit={handleCreateNote}>
                <textarea
                  className="crm-textarea"
                  placeholder="Escreva uma nota interna..."
                  value={noteContent}
                  onChange={(event) => setNoteContent(event.target.value)}
                />
                <div className="crm-note-form__actions">
                  <button className="primary-button primary-button--inline" type="submit">
                    Salvar nota
                  </button>
                </div>
              </form>

              <div className="crm-list">
                {detail.notas.length > 0 ? (
                  detail.notas.map((note) => (
                    <article className="crm-list__item" key={note.id}>
                      <div>
                        <strong>{note.usuario}</strong>
                        <span>{new Date(note.dataHora).toLocaleString("pt-BR")}</span>
                        <p>{note.conteudo}</p>
                      </div>
                      <div className="table-actions">
                        <button
                          className="ghost-button ghost-button--small"
                          type="button"
                          onClick={() => setEditingNote({ id: note.id, content: note.conteudo })}
                        >
                          Editar
                        </button>
                        {isAdmin ? (
                          <button
                            className="ghost-button ghost-button--small ghost-button--danger"
                            type="button"
                            onClick={() => void handleDeleteNote(note.id)}
                          >
                            Excluir
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="crm-empty">Nenhuma nota interna registrada.</div>
                )}
              </div>
            </article>
          </section>

          <section className="crm-grid crm-grid--two">
            <article className="panel crm-card">
              <div className="panel__header">
                <div>
                  <h3>Historico de Atendimento</h3>
                  <p>Timeline unica com chamadas, PDFs, notas e logs.</p>
                </div>
              </div>

              <div className="timeline">
                {detail.timeline.length > 0 ? (
                  detail.timeline.map((item) => (
                    <article className={`timeline-item timeline-item--${item.type}`} key={item.id}>
                      <div className="timeline-item__marker" />
                      <div className="timeline-item__content">
                        <strong>{item.title}</strong>
                        <span>{item.subtitle}</span>
                      </div>
                      <div className="timeline-item__meta">
                        <strong>{item.date}</strong>
                        <span>{item.time}</span>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="crm-empty">Sem eventos no historico ainda.</div>
                )}
              </div>
            </article>

            <article className="panel crm-card">
              <div className="panel__header">
                <div>
                  <h3>Chamados</h3>
                  <p>Abertos, em andamento e resolvidos.</p>
                </div>
                <button className="primary-button primary-button--inline" type="button" onClick={() => setNewTicketOpen(true)}>
                  Novo Chamado
                </button>
              </div>

              <div className="quick-meta">
                {(["todos", "aberto", "em_andamento", "aguardando_motorista", "concluido", "cancelado"] as const).map(
                  (status) => (
                    <button
                      key={status}
                      type="button"
                      className={`quick-meta__chip ${statusFilter === status ? "quick-meta__chip--active" : ""}`}
                      onClick={() => setStatusFilter(status)}
                    >
                      {status === "todos" ? "Todos" : formatStatusLabel(status)}
                    </button>
                  )
                )}
              </div>

              <div className="crm-list crm-list--tickets">
                {filteredChamados.length > 0 ? (
                  filteredChamados.map((ticket) => (
                    <article className="crm-ticket" key={ticket.id}>
                      <div className="crm-ticket__header">
                        <div>
                          <strong>{ticket.assunto}</strong>
                          <span>
                            #{ticket.numero} · {ticket.categoria} · {ticket.responsavel || "Sem responsavel"}
                          </span>
                        </div>
                        <div className="crm-ticket__badges">
                          <span className="status-pill">{formatStatusLabel(ticket.status)}</span>
                          <span className="status-pill">{formatStatusLabel(ticket.prioridade)}</span>
                        </div>
                      </div>

                      <p>{ticket.titulo}</p>

                      <div className="crm-ticket__meta">
                        <small>
                          Abertura: {new Date(ticket.dataAbertura).toLocaleString("pt-BR")} · Atualizacao:{" "}
                          {new Date(ticket.ultimaAtualizacao).toLocaleString("pt-BR")}
                        </small>
                      </div>

                      <div className="crm-ticket__history">
                        {ticket.historico.slice(0, 2).map((entry) => (
                          <div key={entry.id} className="crm-ticket__history-item">
                            <span>{entry.usuario}</span>
                            <small>{entry.descricao}</small>
                          </div>
                        ))}
                      </div>

                      <div className="table-actions">
                        <button
                          className="ghost-button ghost-button--small"
                          type="button"
                          onClick={() => setTicketAction({ mode: "move", chamadoId: ticket.id, subject: ticket.assunto })}
                        >
                          Atualizar
                        </button>
                        <button
                          className="ghost-button ghost-button--small"
                          type="button"
                          onClick={() => setTicketAction({ mode: "close", chamadoId: ticket.id, subject: ticket.assunto })}
                        >
                          Encerrar
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="crm-empty">Nenhum chamado para o filtro selecionado.</div>
                )}
              </div>
            </article>
          </section>
        </>
      ) : (
        <section className="panel crm-empty-screen">
          <h3>Sem motorista carregado</h3>
          <p>Pesquise por nome ou CPF para abrir o painel completo do motorista.</p>
        </section>
      )}

      {newTicketOpen && detail ? (
        <div className="modal-overlay" onClick={() => setNewTicketOpen(false)}>
          <div
            className="modal-card modal-card--crm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-ticket-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Chamados</p>
                <h3 id="new-ticket-title">Novo Chamado</h3>
                <p>O atendimento sera registrado e refletido na timeline do motorista.</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={() => setNewTicketOpen(false)}>
                Fechar
              </button>
            </div>

            <form className="admin-form admin-form--modal" onSubmit={handleCreateTicket}>
              <label className="field">
                <span>Assunto</span>
                <input name="assunto" placeholder="Ex.: Duvida sobre rota" required />
              </label>
              <label className="field">
                <span>Categoria</span>
                <input name="categoria" placeholder="Ex.: Documentacao" required />
              </label>
              <label className="field">
                <span>Prioridade</span>
                <select className="field__select" name="prioridade" defaultValue="media">
                  <option value="baixa">Baixa</option>
                  <option value="media">Media</option>
                  <option value="alta">Alta</option>
                  <option value="critica">Critica</option>
                </select>
              </label>
              <label className="field">
                <span>Responsavel</span>
                <input name="responsavelId" defaultValue={currentUser?.id} placeholder={currentUser?.name || "Responsavel"} />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Descricao</span>
                <textarea className="crm-textarea" name="descricao" placeholder="Descreva o chamado" required />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Anexos</span>
                <input
                  className="field__select"
                  type="file"
                  multiple
                  onChange={(event) => setTicketFiles(Array.from(event.target.files || []))}
                />
              </label>
              <div className="admin-form__actions">
                <button className="ghost-button" type="button" onClick={() => setNewTicketOpen(false)}>
                  Cancelar
                </button>
                <button className="primary-button primary-button--inline" type="submit">
                  Criar chamado
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {ticketAction?.mode === "move" ? (
        <div className="modal-overlay" onClick={() => setTicketAction(null)}>
          <div
            className="modal-card modal-card--crm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="move-ticket-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Chamados</p>
                <h3 id="move-ticket-title">Atualizar chamado</h3>
                <p>{ticketAction.subject}</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={() => setTicketAction(null)}>
                Fechar
              </button>
            </div>

            <form className="admin-form admin-form--modal" onSubmit={handleMovement}>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Texto da atualizacao</span>
                <textarea className="crm-textarea" name="description" placeholder="Atualizacao do chamado" required />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Anexos opcionais</span>
                <input className="field__select" type="file" multiple onChange={(event) => setTicketFiles(Array.from(event.target.files || []))} />
              </label>
              <div className="admin-form__actions">
                <button className="ghost-button" type="button" onClick={() => setTicketAction(null)}>
                  Cancelar
                </button>
                <button className="primary-button primary-button--inline" type="submit">
                  Registrar movimentacao
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {ticketAction?.mode === "close" ? (
        <div className="modal-overlay" onClick={() => setTicketAction(null)}>
          <div
            className="modal-card modal-card--crm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-ticket-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Chamados</p>
                <h3 id="close-ticket-title">Encerrar chamado</h3>
                <p>{ticketAction.subject}</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={() => setTicketAction(null)}>
                Fechar
              </button>
            </div>

            <form className="admin-form admin-form--modal" onSubmit={handleCloseTicket}>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Motivo da conclusao</span>
                <textarea className="crm-textarea" name="motivoConclusao" required />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Solucao aplicada</span>
                <textarea className="crm-textarea" name="solucaoAplicada" required />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Observacoes finais</span>
                <textarea className="crm-textarea" name="observacoesFinais" />
              </label>
              <div className="admin-form__actions">
                <button className="ghost-button" type="button" onClick={() => setTicketAction(null)}>
                  Cancelar
                </button>
                <button className="primary-button primary-button--inline" type="submit">
                  Encerrar chamado
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {editingNote ? (
        <div className="modal-overlay" onClick={() => setEditingNote(null)}>
          <div
            className="modal-card modal-card--confirm modal-card--crm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-note-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Notas</p>
                <h3 id="edit-note-title">Editar nota</h3>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={() => setEditingNote(null)}>
                Fechar
              </button>
            </div>

            <form className="admin-form admin-form--modal" onSubmit={handleUpdateNote}>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Conteudo</span>
                <textarea
                  className="crm-textarea"
                  value={editingNote.content}
                  onChange={(event) =>
                    setEditingNote((current) => (current ? { ...current, content: event.target.value } : current))
                  }
                  required
                />
              </label>
              <div className="admin-form__actions">
                <button className="ghost-button" type="button" onClick={() => setEditingNote(null)}>
                  Cancelar
                </button>
                <button className="primary-button primary-button--inline" type="submit">
                  Salvar alteracao
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
