import {
  ArrowRight,
  Bell,
  CalendarBlank,
  ChartLineUp,
  Eye,
  FileArrowUp,
  FilePdf,
  GearSix,
  HouseLine,
  List,
  LockKey,
  SignOut,
  UserCirclePlus,
  UsersThree
} from "@phosphor-icons/react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  changeFirstAccessPassword,
  fetchDashboardSummary,
  fetchUploads,
  fetchUsers,
  loginRequest,
  type DashboardSummary,
  type LoginResponse,
  type UploadRow,
  type UserSummary
} from "./lib/api";

type AccessLevel = "N1" | "N2" | "N3" | "N4";
type View = "login" | "first-access" | "dashboard" | "pdfs" | "users";

type Activity = {
  icon: "pdf" | "user" | "view";
  title: string;
  subtitle: string;
  date: string;
  time: string;
};

type SessionUser = LoginResponse["user"];

const menuItems = [
  { key: "dashboard", label: "Dashboard", icon: HouseLine },
  { key: "pdfs", label: "Envio de PDFs", icon: FileArrowUp },
  { key: "users", label: "Cadastro de Usuarios", icon: UserCirclePlus }
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

function App() {
  const [view, setView] = useState<View>("login");
  const [activeView, setActiveView] = useState<Exclude<View, "login" | "first-access">>("dashboard");
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [loadingMessage, setLoadingMessage] = useState("");
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary>(initialSummary);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [uploads, setUploads] = useState<UploadRow[]>([]);

  const allowedMenu = useMemo(() => {
    if (!currentUser) {
      return [];
    }

    return menuItems.filter((item) => currentUser.modules.includes(item.key));
  }, [currentUser]);

  useEffect(() => {
    const storedSession = localStorage.getItem("portal-admin-session");

    if (!storedSession) {
      return;
    }

    try {
      const parsed = JSON.parse(storedSession) as { token: string; user: SessionUser };
      setToken(parsed.token);
      setCurrentUser(parsed.user);

      if (parsed.user.firstAccess) {
        setView("first-access");
        return;
      }

      setActiveView("dashboard");
      setView("dashboard");
    } catch {
      localStorage.removeItem("portal-admin-session");
    }
  }, []);

  useEffect(() => {
    if (!token || !currentUser || view === "login" || view === "first-access") {
      return;
    }

    let cancelled = false;

    const loadData = async () => {
      setLoadingMessage("Carregando dados do portal...");

      try {
        const [summary, uploadsData, usersData] = await Promise.all([
          fetchDashboardSummary(token),
          fetchUploads(token),
          currentUser.modules.includes("users") ? fetchUsers(token) : Promise.resolve([])
        ]);

        if (cancelled) {
          return;
        }

        setDashboardSummary(summary);
        setUploads(uploadsData);
        setUsers(usersData);
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
    setCurrentUser(null);
    setToken("");
    setUsers([]);
    setUploads([]);
    setDashboardSummary(initialSummary);
    setLoginError("");
    setPasswordError("");
    setLoadingMessage("");
    setActiveView("dashboard");
    setView("login");
    localStorage.removeItem("portal-admin-session");
  };

  if (view === "login") {
    return (
      <main className="auth-page">
        <section className="auth-hero">
          <div className="brand-mark">
            <span className="brand-mark__title">ALC</span>
            <span className="brand-mark__caption">Portal Administrativo</span>
          </div>
          <p className="eyebrow">Administracao simplificada</p>
          <h1>Bem-vindo ao Portal Administrativo!</h1>
          <p className="auth-copy">
            Acesse sua conta para gerenciar operacoes, acompanhar informacoes e utilizar os
            recursos do sistema com seguranca.
          </p>
          <p className="auth-copy auth-copy--muted">
            Este ambiente e exclusivo para usuarios autorizados.
          </p>
          <div className="hero-preview">
            <div className="hero-preview__window">
              <div className="hero-preview__sidebar" />
              <div className="hero-preview__content">
                <div className="hero-preview__topline" />
                <div className="hero-preview__chart" />
                <div className="hero-preview__cards">
                  <span />
                  <span />
                </div>
              </div>
            </div>
          </div>
          <div className="hero-watermark">
            <span>ALC</span>
            <span>TRANSPORTES</span>
          </div>
        </section>

        <section className="auth-panel">
          <div className="auth-card">
            <p className="eyebrow">Acesso seguro</p>
            <h2>Entrar no sistema</h2>
            <p className="panel-copy">
              Use um dos e-mails cadastrados na base inicial e a senha temporaria `0000`.
            </p>

            <form className="form-stack" onSubmit={handleLogin}>
              <label className="field">
                <span>E-mail</span>
                <input name="email" type="email" placeholder="seuemail@empresa.com" required />
              </label>
              <label className="field">
                <span>Senha</span>
                <input name="password" type="password" placeholder="Digite sua senha" required />
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
          <p className="eyebrow">Seguranca obrigatoria</p>
          <h2>Altere sua senha para continuar</h2>
          <p className="panel-copy">
            No primeiro acesso, o sistema exige a substituicao da senha padrao antes de liberar os
            demais modulos.
          </p>

          <form className="form-stack" onSubmit={handleChangePassword}>
            <label className="field">
              <span>Senha atual</span>
              <input name="currentPassword" type="password" placeholder="Informe a senha atual" required />
            </label>
            <label className="field">
              <span>Nova senha</span>
              <input name="newPassword" type="password" placeholder="Minimo de 6 caracteres" required />
            </label>
            <label className="field">
              <span>Confirmar nova senha</span>
              <input
                name="confirmPassword"
                type="password"
                placeholder="Repita a nova senha"
                required
              />
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
          <div className="sidebar__brand">
            <div className="brand-mark brand-mark--compact">
              <span className="brand-mark__title">ALC</span>
              <span className="brand-mark__caption">Portal</span>
            </div>
          </div>

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

        {loadingMessage && view !== "login" && view !== "first-access" ? (
          <div className="panel">
            <p className="loading-note">{loadingMessage}</p>
          </div>
        ) : null}

        {loginError && view !== "login" ? (
          <div className="panel">
            <p className="form-error">{loginError}</p>
          </div>
        ) : null}

        {activeView === "dashboard" ? (
          <DashboardScreen currentUser={currentUser} summary={dashboardSummary} />
        ) : null}
        {activeView === "pdfs" ? <PdfsScreen uploads={uploads} /> : null}
        {activeView === "users" ? <UsersScreen users={users} /> : null}
      </section>
    </main>
  );
}

function DashboardScreen({
  currentUser,
  summary
}: {
  currentUser: SessionUser | null;
  summary: DashboardSummary;
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

      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>Acesso Rapido</h3>
            <p>Atalhos operacionais para a equipe administrativa</p>
          </div>
        </div>

        <div className="quick-actions">
          <button className="quick-action-card" type="button">
            <div className="quick-action-card__icon">
              <FileArrowUp size={26} />
            </div>
            <div>
              <strong>Enviar PDF</strong>
              <span>Faca o envio de novos documentos.</span>
            </div>
            <ArrowRight size={20} />
          </button>

          <button className="quick-action-card" type="button">
            <div className="quick-action-card__icon">
              <UserCirclePlus size={26} />
            </div>
            <div>
              <strong>Cadastrar Usuario</strong>
              <span>Adicione novos usuarios e niveis de acesso.</span>
            </div>
            <ArrowRight size={20} />
          </button>
        </div>
      </section>
    </div>
  );
}

function PdfsScreen({ uploads }: { uploads: UploadRow[] }) {
  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Operacao de documentos</p>
          <h1>Envio de PDFs</h1>
          <p>Upload multiplo, acompanhamento de status e substituicao de arquivos versionados.</p>
        </div>
        <button className="primary-button primary-button--inline" type="button">
          Novo upload
          <FileArrowUp size={18} weight="bold" />
        </button>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>Fila de documentos</h3>
            <p>Base inicial de acompanhamento com status e responsavel</p>
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
              {uploads.map((row) => (
                <tr key={row.id}>
                  <td>{row.fileName}</td>
                  <td>
                    <span className="status-pill">{row.status}</span>
                  </td>
                  <td>{new Date(row.sentAt).toLocaleString("pt-BR")}</td>
                  <td>{row.owner}</td>
                  <td>
                    <div className="table-actions">
                      <button className="ghost-button ghost-button--small" type="button">
                        Visualizar
                      </button>
                      <button className="ghost-button ghost-button--small" type="button">
                        Substituir
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function UsersScreen({ users }: { users: UserSummary[] }) {
  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Administracao</p>
          <h1>Cadastro de Usuarios</h1>
          <p>Gestao de niveis, status, modulos liberados e historico operacional.</p>
        </div>
        <button className="primary-button primary-button--inline" type="button">
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
            <h3>Usuarios cadastrados</h3>
            <p>Base de perfis administrativos e operacionais</p>
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
                <th>Modulos</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{user.level}</td>
                  <td>
                    <span className="status-pill">{user.blocked ? "Bloqueado" : "Ativo"}</span>
                  </td>
                  <td>{user.modules.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default App;
