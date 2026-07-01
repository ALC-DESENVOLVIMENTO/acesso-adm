import {
  ArrowRight,
  Bell,
  CalendarBlank,
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
  deleteUser,
  deleteUpload,
  downloadUpload,
  fetchDashboardSummary,
  fetchPaymentBases,
  fetchPaymentPeriods,
  fetchSession,
  fetchUploadHistory,
  fetchUploads,
  fetchUsers,
  loginRequest,
  logoutRequest,
  replaceUpload,
  resetUserPassword,
  updateUser,
  updateUserStatus,
  uploadPdfs,
  type DashboardSummary,
  type LoginResponse,
  type PaymentBase,
  type PaymentPeriod,
  type UploadProgressState,
  type UploadRow,
  type UserPayload,
  type UserSummary
} from "./lib/api";

type AccessLevel = "N1" | "N2" | "N3" | "N4";
type View = "login" | "first-access" | "dashboard" | "pdfs" | "users" | "periods";

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
  { key: "periods", label: "Criação de Periodo", icon: CalendarBlank }
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
    const canSeePdfData = currentUser.modules.includes("pdfs");
    const canSeePeriodData = canSeePdfData || currentUser.level === "N3" || currentUser.level === "N4";

    const loadData = async () => {
      setLoadingMessage("Carregando dados do portal...");

      try {
        const [summary, uploadsData, usersData] = await Promise.all([
          fetchDashboardSummary(token),
          canSeePdfData ? fetchUploads(token) : Promise.resolve([]),
          currentUser.modules.includes("users") ? fetchUsers(token) : Promise.resolve([])
        ]);
        const periodsData: PaymentPeriod[] = canSeePeriodData
          ? await fetchPaymentPeriods(token)
          : [];
        const basesData: PaymentBase[] = canSeePeriodData ? await fetchPaymentBases(token) : [];

        if (cancelled) {
          return;
        }

        setDashboardSummary(summary);
        setUploads(uploadsData);
        setUsers(usersData);
        setPaymentPeriods(periodsData);
        setPaymentBases(basesData);
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
  }, [currentUser, token, view]);

  const refreshPortalData = async () => {
    if (!token || !currentUser) {
      return;
    }

    const canSeePdfData = currentUser.modules.includes("pdfs");
    const canSeePeriodData = canSeePdfData || currentUser.level === "N3" || currentUser.level === "N4";

    const [summary, uploadsData, usersData] = await Promise.all([
      fetchDashboardSummary(token),
      canSeePdfData ? fetchUploads(token) : Promise.resolve([]),
      currentUser.modules.includes("users") ? fetchUsers(token) : Promise.resolve([])
    ]);
    const periodsData: PaymentPeriod[] = canSeePeriodData ? await fetchPaymentPeriods(token) : [];
    const basesData: PaymentBase[] = canSeePeriodData ? await fetchPaymentBases(token) : [];

    setDashboardSummary(summary);
    setUploads(uploadsData);
    setUsers(usersData);
    setPaymentPeriods(periodsData);
    setPaymentBases(basesData);
  };

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
    setActiveView("dashboard");
    setView("login");
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
      await refreshPortalData();
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
      await refreshPortalData();
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
      await refreshPortalData();
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
      await refreshPortalData();
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
      await refreshPortalData();
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
      await refreshPortalData();
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
      await refreshPortalData();
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
      await refreshPortalData();
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
      await refreshPortalData();

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

      await refreshPortalData();
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao remover PDF."
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
  onCreatePeriod
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

        <form className="admin-form" onSubmit={handleSubmit}>
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
            const totalBases = period.bases.length;
            const completion = totalBases > 0 ? `${period.uploadedTotal}/${totalBases}` : "0/0";
            return (
              <article className="period-card" key={period.id}>
                <div>
                  <p className="eyebrow">Periodo {period.paymentType.toUpperCase()}</p>
                  <h4>{period.name}</h4>
                  <p>
                    {new Date(period.startDate).toLocaleDateString("pt-BR")} a{" "}
                    {new Date(period.endDate).toLocaleDateString("pt-BR")}
                  </p>
                </div>

                <div className="period-card__meta">
                  <span className={`status-pill ${period.status === "disponivel" ? "status-pill--active" : ""}`}>
                    {formatStatusLabel(period.status)}
                  </span>
                  <strong>{completion}</strong>
                  <small>PDFs por base</small>
                </div>

                <div className="module-chips">
                  {period.bases.map((base) => (
                    <span className="mini-chip" key={`${period.id}-${base.id}`}>
                      {base.name}
                    </span>
                  ))}
                </div>

                <div className="period-card__actions">
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

  const filteredUploads = useMemo(() => {
    return uploads.filter((row) => {
      const matchesSearch =
        row.fileName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        row.owner.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === "todos" || row.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [searchTerm, statusFilter, uploads]);

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
            <p>{filteredUploads.length} documento(s) visivel(is) na fila operacional</p>
          </div>
          <div className="quick-meta">
            <span className="quick-meta__chip">Pendente</span>
            <span className="quick-meta__chip">Processado</span>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Status</th>
                <th>Data de envio</th>
                <th>Responsavel</th>
                <th>Acoes</th>
              </tr>
            </thead>
            <tbody>
              {filteredUploads.map((row) => (
                <tr key={row.id}>
                  <td>{row.fileName}</td>
                  <td>
                    <span className="status-pill">{row.status}</span>
                  </td>
                  <td>{new Date(row.sentAt).toLocaleString("pt-BR")}</td>
                  <td>{row.owner}</td>
                  <td>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

export default App;
