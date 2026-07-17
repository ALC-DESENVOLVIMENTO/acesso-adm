import {
  ArrowRight,
  Camera,
  CaretDown,
  Bell,
  CalendarBlank,
  ChatCenteredDots,
  ChartBar,
  Coins,
  Database,
  EnvelopeSimple,
  ChartLineUp,
  ClockCounterClockwise,
  Eye,
  FileArrowUp,
  FilePdf,
  FunnelSimple,
  GearSix,
  HouseLine,
  LockKey,
  LockSimple,
  MagnifyingGlass,
  PencilSimple,
  Receipt,
  List,
  SignOut,
  TrashSimple,
  UserCirclePlus,
  UsersThree
} from "@phosphor-icons/react";
import { FormEvent, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  changeFirstAccessPassword,
  createUser,
  createPaymentPeriod,
  createPaymentBase,
  deletePaymentPeriod,
  deleteUser,
  deleteUpload,
  downloadUpload,
  fetchDashboardActivities,
  fetchDashboardSummary,
  fetchAtendimentoClassificacoes,
  fetchAtendimentoMotorista,
  fetchPaymentBases,
  fetchPaymentPeriods,
  fetchPeriodBaseReviews,
  fetchSession,
  fetchUploadHistory,
  fetchUploads,
  searchAtendimentoMotoristas,
  fetchUsers,
  loginRequest,
  logoutRequest,
  updateCurrentUserProfile,
  updateMotoristaClassificacoes,
  updatePaymentPeriodLifecycle,
  updatePaymentPeriodStatus,
  updatePaymentBase,
  reviewPeriodBaseUpload,
  createAtendimentoNota,
  updateAtendimentoNota,
  deleteAtendimentoNota,
  createAtendimentoChamado,
  createAtendimentoMovimento,
  closeAtendimentoChamado,
  updateAtendimentoMotorista,
  replaceUpload,
  resetUserPassword,
  updateUser,
  updateUserStatus,
  uploadPdfs,
  type DashboardActivity,
  type DashboardSummary,
  type AtendimentoClassificacao,
  type AtendimentoDetail,
  type AtendimentoMotoristaSearch,
  type AtendimentoMotoristaUpdatePayload,
  type LoginResponse,
  type PaymentBase,
  type PaymentPeriod,
  type PeriodBaseReviewItem,
  type UploadProgressState,
  type UploadRow,
  type UserPayload,
  type UserSummary
} from "./lib/api";
import { ApiError } from "./lib/api";

const FinanceiroScreen = lazy(() =>
  import("./FinanceiroScreen").then((module) => ({ default: module.FinanceiroScreen }))
);

type AccessLevel = "N1" | "N2" | "N3" | "N4";
type AuthView = "login" | "first-access";
type ViewState = AuthView | RouteView;
type RouteView = "dashboard" | "pdfs" | "users" | "periods" | "financeiro" | "atendimento";
type QuickActionRoute = Exclude<RouteView, "dashboard">;

type SessionUser = LoginResponse["user"];

type FlashMessage = {
  type: "success" | "error";
  text: string;
};

type AppNotification = {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
};

type ProfileModalMode = "name" | "photo" | "password" | null;
type ThemeMode = "light" | "dark";

type UploadHistoryState = {
  uploadId: string;
  entries: UploadRow[];
} | null;

type AccessDeniedState = {
  route: RouteView;
} | null;

const routePaths: Record<RouteView, string> = {
  dashboard: "/dashboard",
  pdfs: "/envio-pdfs",
  users: "/usuarios",
  periods: "/periodos",
  financeiro: "/financeiro",
  atendimento: "/atendimento"
};

const menuItems = [
  { key: "dashboard", label: "Dashboard", icon: HouseLine },
  { key: "pdfs", label: "Envio de PDFs", icon: FileArrowUp },
  { key: "users", label: "Cadastro de Usuários", icon: UserCirclePlus },
  { key: "periods", label: "Criação de Período", icon: CalendarBlank },
  { key: "financeiro", label: "Financeiro", icon: FilePdf },
  { key: "atendimento", label: "Atendimento", icon: ChatCenteredDots }
] as const;

const moduleLabels: Record<string, string> = {
  dashboard: "Dashboard",
  pdfs: "Envio de PDFs",
  users: "Cadastro de Usuários",
  periods: "Criação de Período",
  financeiro: "Financeiro",
  atendimento: "Atendimento"
};

const userModuleOptions = [
  { code: "dashboard", label: "Dashboard" },
  { code: "pdfs", label: "Envio de PDFs" },
  { code: "users", label: "Cadastro de Usuários" },
  { code: "periods", label: "Criação de Período" },
  { code: "financeiro", label: "Financeiro" },
  { code: "atendimento", label: "Atendimento" }
] as const;

const loginPreviewImages = ["/login-preview-dashboard.png", "/login-preview-pdfs.png"];

const quickActionStorageKey = "portal-adm.quick-actions";
const themeStorageKey = "portal-adm.theme";
const quickActionLabels: Record<RouteView, { title: string; description: string; icon: typeof FileArrowUp }> = {
  dashboard: { title: "Dashboard", description: "Visão geral do portal.", icon: HouseLine },
  pdfs: { title: "Enviar PDF", description: "Faça o envio de novos documentos.", icon: FileArrowUp },
  users: { title: "Cadastrar Usuário", description: "Adicione novos usuários e níveis de acesso.", icon: UserCirclePlus },
  periods: { title: "Criação de Período", description: "Gerencie períodos e bases.", icon: CalendarBlank },
  financeiro: { title: "Financeiro", description: "Acompanhe notas fiscais, espelho e importação financeira.", icon: FilePdf },
  atendimento: { title: "Atendimento", description: "Abra o CRM do motorista.", icon: ChatCenteredDots }
};

function isQuickActionRoute(route: RouteView): route is QuickActionRoute {
  return route !== "dashboard";
}

function readStoredTheme(): ThemeMode {
  try {
    return window.localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const initialSummary: DashboardSummary = {
  pdfsSent: 0,
  pendingPdfs: 0,
  processedPdfs: 0,
  pendingInvoices: 0,
  ticketsWaiting: 0,
  closedTickets: 0,
  usersCount: 0,
  periodSummaries: [],
  recentActivities: [],
  recentActivitiesTotal: 0
};

const logoSrc = "/alc-logotipo-dark.png";

function formatStatusLabel(status: string) {
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateOnly(dateValue?: string | null) {
  if (!dateValue) {
    return "Data não informada";
  }

  const datePart = dateValue.includes("T") ? dateValue.split("T")[0] : dateValue;
  const [year, month, day] = datePart.split("-");

  if (!year || !month || !day) {
    return "Data não informada";
  }

  return `${day}/${month}/${year}`;
}

function formatDateTimeParts(dateValue?: string | null) {
  if (!dateValue) {
    return {
      date: "Data não informada",
      time: "--:--"
    };
  }

  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return {
      date: "Data não informada",
      time: "--:--"
    };
  }

  return {
    date: new Intl.DateTimeFormat("pt-BR").format(date),
    time: new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(date)
  };
}

function formatDurationMinutes(minutes?: number | null) {
  if (!minutes || minutes <= 0) {
    return "menos de 1 min";
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours <= 0) {
    return `${remainingMinutes} min`;
  }

  if (remainingMinutes <= 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}min`;
}

function getRouteViewFromPath(pathname: string): RouteView {
  const normalized = pathname.replace(/\/+$/, "") || "/";

  if (normalized === "/" || normalized === "/dashboard") {
    return "dashboard";
  }

  if (normalized === "/envio-pdfs") {
    return "pdfs";
  }

  if (normalized === "/usuarios") {
    return "users";
  }

  if (normalized === "/periodos") {
    return "periods";
  }

  if (normalized === "/financeiro" || normalized === "/notas-fiscais") {
    return "financeiro";
  }

  if (normalized === "/atendimento") {
    return "atendimento";
  }

  return "dashboard";
}

function getRoutePath(view: RouteView) {
  return routePaths[view];
}

function getRouteLabel(view: RouteView) {
  const labels: Record<RouteView, string> = {
    dashboard: "Dashboard",
    pdfs: "Envio de PDFs",
    users: "Cadastro de Usuários",
    periods: "Criação de Período",
    financeiro: "Financeiro",
    atendimento: "Atendimento"
  };

  return labels[view];
}

function getDefaultRoute(user: SessionUser | null) {
  if (!user) {
    return "dashboard";
  }

  if (user.level === "N3" || user.level === "N4") {
    return "dashboard";
  }

  if (user.modules.includes("dashboard")) {
    return "dashboard";
  }

  return (user.modules.find((module) => module in routePaths) || "dashboard") as RouteView;
}

function canAccessRoute(user: SessionUser | null, route: RouteView) {
  if (!user) {
    return false;
  }

  if (user.level === "N3" || user.level === "N4") {
    return true;
  }

  if (route === "periods") {
    return false;
  }

  return user.modules.includes(route);
}

function App() {
  const initialRoute = getRouteViewFromPath(window.location.pathname);
  const [view, setView] = useState<ViewState>("login");
  const [activeView, setActiveView] = useState<RouteView>(initialRoute);
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [loadingMessage, setLoadingMessage] = useState("");
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [activitiesModalOpen, setActivitiesModalOpen] = useState(false);
  const [activitiesSearch, setActivitiesSearch] = useState("");
  const [activitiesLoading, setActivitiesLoading] = useState(false);
  const [activitiesResult, setActivitiesResult] = useState<DashboardActivity[]>([]);
  const [profileModalMode, setProfileModalMode] = useState<ProfileModalMode>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredTheme());
  const [profileActionError, setProfileActionError] = useState("");
  const [profileActionLoading, setProfileActionLoading] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quickActions, setQuickActions] = useState<RouteView[]>([]);
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary>(initialSummary);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [paymentPeriods, setPaymentPeriods] = useState<PaymentPeriod[]>([]);
  const [paymentBases, setPaymentBases] = useState<PaymentBase[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);
  const [uploadHistory, setUploadHistory] = useState<UploadHistoryState>(null);
  const [baseEditorOpen, setBaseEditorOpen] = useState(false);
  const [editingBase, setEditingBase] = useState<PaymentBase | null>(null);
  const [baseFormValues, setBaseFormValues] = useState({
    name: "",
    paymentType: "semanal" as "semanal" | "quinzenal" | "mensal",
    active: true
  });
  const [createUserSignal, setCreateUserSignal] = useState(0);
  const [deleteUserTarget, setDeleteUserTarget] = useState<UserSummary | null>(null);
  const [deleteUploadTarget, setDeleteUploadTarget] = useState<UploadRow | null>(null);
  const [deletePeriodTarget, setDeletePeriodTarget] = useState<PaymentPeriod | null>(null);
  const [financeMotoristaTarget, setFinanceMotoristaTarget] = useState<string | null>(null);
  const [reviewingUploadId, setReviewingUploadId] = useState<string | null>(null);
  const [periodApprovalBlockedMessage, setPeriodApprovalBlockedMessage] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState<AccessDeniedState>(null);
  const [profilePhotoBroken, setProfilePhotoBroken] = useState(false);
  const [loginPreviewIndex, setLoginPreviewIndex] = useState(0);
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [uploadsLoaded, setUploadsLoaded] = useState(false);
  const [periodDataLoaded, setPeriodDataLoaded] = useState(false);
  const requestedRouteRef = useRef<RouteView | null>(null);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const notificationsRef = useRef<HTMLDivElement | null>(null);
  const shouldUseDarkTheme = Boolean(currentUser) && themeMode === "dark";
  const unreadNotifications = notifications.filter((item) => !item.read).length;

  const allowedMenu = useMemo(() => {
    if (!currentUser) {
      return [];
    }

    if (currentUser.level === "N3" || currentUser.level === "N4") {
      return menuItems;
    }

    return menuItems.filter((item) => {
      if (item.key === "periods") {
        return false;
      }

      return currentUser.modules.includes(item.key);
    });
  }, [currentUser]);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", shouldUseDarkTheme);

    return () => {
      document.body.classList.remove("theme-dark");
    };
  }, [shouldUseDarkTheme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(themeStorageKey, themeMode);
    } catch {
      // Ignore storage restrictions and keep the selected theme in memory.
    }
  }, [themeMode]);

  useEffect(() => {
    if (!currentUser) {
      setQuickActions([]);
      return;
    }

    try {
      const raw = window.localStorage.getItem(`${quickActionStorageKey}:${currentUser.id}`);
      const parsed = raw ? (JSON.parse(raw) as RouteView[]) : [];
      const permitted = allowedMenu
        .map((item) => item.key)
        .filter(isQuickActionRoute);

      const normalized = parsed.filter((route) => isQuickActionRoute(route) && permitted.includes(route));
      setQuickActions(normalized.length > 0 ? normalized : permitted.slice(0, 2));
    } catch {
      const permitted = allowedMenu
        .map((item) => item.key)
        .filter(isQuickActionRoute);
      setQuickActions(permitted.slice(0, 2));
    }
  }, [allowedMenu, currentUser]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    window.localStorage.setItem(`${quickActionStorageKey}:${currentUser.id}`, JSON.stringify(quickActions));
  }, [currentUser, quickActions]);

  useEffect(() => {
    if (view !== "login") {
      return;
    }

    setLoginPreviewIndex(0);
    const timer = window.setInterval(() => {
      setLoginPreviewIndex((current) => (current + 1) % loginPreviewImages.length);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [view]);

  const canSeePdfData = useMemo(() => currentUser?.modules.includes("pdfs") ?? false, [currentUser]);
  const canSeeUsersData = useMemo(() => currentUser?.modules.includes("users") ?? false, [currentUser]);
  const canSeePeriodData = useMemo(
    () => canSeePdfData || currentUser?.modules.includes("financeiro") || currentUser?.level === "N3" || currentUser?.level === "N4",
    [canSeePdfData, currentUser]
  );

  const clearLoadedState = () => {
    setDashboardLoaded(false);
    setUsersLoaded(false);
    setUploadsLoaded(false);
    setPeriodDataLoaded(false);
  };

  const clearSessionAndGoLogin = (message?: string) => {
    localStorage.removeItem("portal-admin-session");
    setCurrentUser(null);
    setToken("");
    setUsers([]);
    setUploads([]);
    setPaymentPeriods([]);
    setPaymentBases([]);
    setDashboardSummary(initialSummary);
    setLoginError(message || "");
    setPasswordError("");
    setProfileActionError("");
    setProfileActionLoading(false);
    setProfileMenuOpen(false);
    setNotificationsOpen(false);
    setNotifications([]);
    setActivitiesModalOpen(false);
    setActivitiesSearch("");
    setActivitiesResult([]);
    setProfileModalMode(null);
    setLoadingMessage("");
    setFlashMessage(null);
    setUploadProgress(null);
    setUploadHistory(null);
    setCreateUserSignal(0);
    setDeleteUserTarget(null);
    setDeleteUploadTarget(null);
    setDeletePeriodTarget(null);
    setFinanceMotoristaTarget(null);
    setAccessDenied(null);
    setProfilePhotoBroken(false);
    setReviewingUploadId(null);
    setPeriodApprovalBlockedMessage(null);
    setSidebarOpen(false);
    clearLoadedState();
    setActiveView("dashboard");
    setView("login");
    window.history.replaceState({}, "", "/login");
  };

  const isSessionExpiredError = (error: unknown) =>
    error instanceof ApiError &&
    (error.status === 401 ||
      /sessao invalida|sessao nao informada|sessão inválida|sessão não informada|invalid or expired/i.test(error.message));

  useEffect(() => {
    const handleSessionExpired = () => {
      clearSessionAndGoLogin("Sua sessão expirou. Faça login novamente para continuar.");
    };

    window.addEventListener("portal-admin-session-expired", handleSessionExpired);
    return () => window.removeEventListener("portal-admin-session-expired", handleSessionExpired);
  }, []);

  const navigateToRoute = (route: RouteView) => {
    setAccessDenied(null);
    setActiveView(route);
    setSidebarOpen(false);
    window.history.pushState({}, "", getRoutePath(route));
  };

  const loadDashboardSummary = async () => {
    const summary = await fetchDashboardSummary(token);
    setDashboardSummary(summary);
    setDashboardLoaded(true);
  };

  const loadDashboardActivities = async (search = activitiesSearch) => {
    if (!token) {
      return;
    }

    setActivitiesLoading(true);

    try {
      const response = await fetchDashboardActivities(token, search);
      setActivitiesResult(response.activities);
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao carregar atividades."
      });
    } finally {
      setActivitiesLoading(false);
    }
  };

  const pushNotification = (notification: Omit<AppNotification, "read">) => {
    setNotifications((current) => [
      {
        ...notification,
        read: false
      },
      ...current.filter((item) => item.id !== notification.id)
    ].slice(0, 12));
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
      if (window.location.pathname !== "/login" && window.location.pathname !== "/first-access") {
        requestedRouteRef.current = getRouteViewFromPath(window.location.pathname);
        window.history.replaceState({}, "", "/login");
      }
      setAccessDenied(null);
      setView("login");
      return;
    }

    void (async () => {
      try {
        const { token: storedToken } = JSON.parse(storedSession) as { token: string; user: SessionUser };
        const session = await fetchSession(storedToken);
        setToken(session.token);
        setCurrentUser(session.user);
        setProfilePhotoBroken(false);
        localStorage.setItem(
          "portal-admin-session",
          JSON.stringify({
            token: session.token,
            user: session.user
          })
        );

        if (session.firstAccess) {
          setView("first-access");
          window.history.replaceState({}, "", "/first-access");
          return;
        }

        const requestedRoute = requestedRouteRef.current || getRouteViewFromPath(window.location.pathname);
        const requestedPath = window.location.pathname;
        const nextRoute =
          requestedPath === "/"
            ? "dashboard"
            : requestedPath === "/login"
              ? "dashboard"
              : canAccessRoute(session.user, requestedRoute)
                ? requestedRoute
                : getDefaultRoute(session.user);

        const safeRoute = nextRoute;
        setActiveView(safeRoute);
        setView(safeRoute);
        window.history.replaceState({}, "", getRoutePath(safeRoute));
        requestedRouteRef.current = null;
      } catch (error) {
        if (isSessionExpiredError(error)) {
          clearSessionAndGoLogin("Sua sessão expirou. Faça login novamente para continuar.");
          return;
        }

        clearSessionAndGoLogin("Não foi possível recuperar sua sessão. Faça login novamente.");
      }
    })();
  }, []);

  useEffect(() => {
    if (!flashMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setFlashMessage(null);
    }, 3800);

    return () => window.clearTimeout(timeout);
  }, [flashMessage]);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = getRouteViewFromPath(window.location.pathname);
      setActiveView(nextRoute);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!profileMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;

      if (target && profileMenuRef.current && !profileMenuRef.current.contains(target)) {
        setProfileMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!notificationsOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;

      if (target && notificationsRef.current && !notificationsRef.current.contains(target)) {
        setNotificationsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [notificationsOpen]);

  useEffect(() => {
    if (!activitiesModalOpen || !token) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void loadDashboardActivities(activitiesSearch);
    }, 220);

    return () => window.clearTimeout(timeout);
  }, [activitiesModalOpen, activitiesSearch, token]);

  useEffect(() => {
    if (!token || !currentUser || view === "login" || view === "first-access") {
      return;
    }

    if (!canAccessRoute(currentUser, activeView)) {
      setAccessDenied({ route: activeView });
      return;
    }

    setAccessDenied(null);

    let cancelled = false;
    const loadData = async () => {
      setLoadingMessage("Carregando dados do portal...");

      try {
        if (activeView === "dashboard") {
          await loadDashboardSummary();

          return;
        }

        const tasks: Promise<unknown>[] = [];

        if (activeView === "users") {
          if (canSeeUsersData) {
            tasks.push(loadUsersData());
          }
        }

        if (activeView === "pdfs") {
          if (canSeePdfData) {
            tasks.push(loadUploadsData());
          }

          if (canSeePeriodData) {
            tasks.push(loadPeriodData());
          }
        }

        if ((activeView === "periods" || activeView === "financeiro") && canSeePeriodData) {
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

        if (isSessionExpiredError(error)) {
          clearSessionAndGoLogin("Sua sessão expirou. Faça login novamente para continuar.");
          return;
        }

        setLoginError(error instanceof Error ? error.message : "Falha ao carregar os dados do portal.");
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
    token,
    view
  ]);

  useEffect(() => {
    if (!token || !currentUser || view !== "dashboard" || activeView !== "dashboard") {
      return;
    }

    if (!canAccessRoute(currentUser, "dashboard")) {
      return;
    }

    let cancelled = false;

    const refreshDashboard = async () => {
      try {
        const summary = await fetchDashboardSummary(token);

        if (!cancelled) {
          setDashboardSummary(summary);
          setDashboardLoaded(true);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (isSessionExpiredError(error)) {
          clearSessionAndGoLogin("Sua sessão expirou. Faça login novamente para continuar.");
        }
      }
    };

    const intervalId = window.setInterval(() => {
      void refreshDashboard();
    }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeView, currentUser, token, view]);


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
      setFinanceMotoristaTarget(null);
      setProfileMenuOpen(false);
      setProfileModalMode(null);
      setProfileActionError("");
      localStorage.setItem(
        "portal-admin-session",
        JSON.stringify({
          token: response.token,
          user: response.user
        })
      );

      if (response.firstAccess) {
        setView("first-access");
        window.history.replaceState({}, "", "/first-access");
        return;
      }

      const requestedRoute = requestedRouteRef.current || getRouteViewFromPath(window.location.pathname);
      const nextView = canAccessRoute(response.user, requestedRoute) ? requestedRoute : getDefaultRoute(response.user);

      setActiveView(nextView);
      setView(nextView);
      window.history.replaceState({}, "", getRoutePath(nextView));
      requestedRouteRef.current = null;
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Falha ao autenticar o usuário.");
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
      setProfilePhotoBroken(false);
      localStorage.setItem(
        "portal-admin-session",
        JSON.stringify({
          token,
          user: updatedUser
        })
      );
      navigateToRoute("dashboard");
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
    setProfileActionError("");
    setProfileActionLoading(false);
    setProfileMenuOpen(false);
    setNotificationsOpen(false);
    setNotifications([]);
    setActivitiesModalOpen(false);
    setActivitiesSearch("");
    setActivitiesResult([]);
    setProfileModalMode(null);
    setLoadingMessage("");
    setFlashMessage(null);
    setUploadProgress(null);
    setUploadHistory(null);
    setProfileMenuOpen(false);
    setProfileModalMode(null);
    setProfileActionError("");
    setDeleteUserTarget(null);
    setDeleteUploadTarget(null);
    setDeletePeriodTarget(null);
    setFinanceMotoristaTarget(null);
    setAccessDenied(null);
    setProfilePhotoBroken(false);
    requestedRouteRef.current = null;
    setView("login");
    window.history.replaceState({}, "", "/login");
    clearLoadedState();
    localStorage.removeItem("portal-admin-session");
  };

  const closeProfileModal = () => {
    setProfileModalMode(null);
    setProfileActionError("");
  };

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!token || !currentUser || !profileModalMode) {
      return;
    }

    const data = new FormData(event.currentTarget);
    const profilePayload = new FormData();

    if (profileModalMode === "name") {
      const nextName = String(data.get("name") || "").trim();

      if (!nextName) {
        setProfileActionError("Informe um nome valido.");
        return;
      }

      profilePayload.append("name", nextName);
    }

    if (profileModalMode === "photo") {
      const photoFile = data.get("photo");

      if (!(photoFile instanceof File) || photoFile.size === 0) {
        setProfileActionError("Selecione uma foto para atualizar.");
        return;
      }

      profilePayload.append("photo", photoFile);
    }

    if (profileModalMode === "password") {
      const currentPassword = String(data.get("currentPassword") || "").trim();
      const newPassword = String(data.get("newPassword") || "").trim();
      const confirmPassword = String(data.get("confirmPassword") || "").trim();

      if (!currentPassword || !newPassword || !confirmPassword) {
        setProfileActionError("Preencha a senha atual e a nova senha.");
        return;
      }

      if (newPassword !== confirmPassword) {
        setProfileActionError("A confirmacao da senha precisa ser igual a nova senha.");
        return;
      }

      profilePayload.append("currentPassword", currentPassword);
      profilePayload.append("newPassword", newPassword);
    }

    setProfileActionLoading(true);
    setProfileActionError("");

    try {
      const response = await updateCurrentUserProfile(token, profilePayload);
      setCurrentUser(response.user);
      localStorage.setItem(
        "portal-admin-session",
        JSON.stringify({
          token,
          user: response.user
        })
      );
      setFlashMessage({ type: "success", text: response.message });
      closeProfileModal();
      setProfileMenuOpen(false);
    } catch (error) {
      setProfileActionError(error instanceof Error ? error.message : "Falha ao atualizar o perfil.");
    } finally {
      setProfileActionLoading(false);
    }
  };

  const handleCreateUser = async (payload: UserPayload) => {
    if (!token) {
      return false;
    }

    setLoadingMessage("Criando usuário...");

    try {
      const response = await createUser(token, payload);
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao criar o usuário."
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

    setLoadingMessage("Atualizando usuário...");

    try {
      const response = await updateUser(token, userId, payload);
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao atualizar o usuário."
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

    setLoadingMessage("Excluindo usuário...");

    try {
      const response = await deleteUser(token, user.id);
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadUsersData(), loadDashboardSummary()]);
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao excluir o usuário."
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

    setLoadingMessage("Criando período...");

    try {
      const response = await createPaymentPeriod(token, payload);
      const periodName = response.period?.name || payload.name;

      pushNotification({
        id: `period-created-${response.period?.id || Date.now()}`,
        title: "Periodo criado",
        message: `${periodName} ja esta disponivel para envio de espelhos.`,
        createdAt: new Date().toISOString()
      });
      setFlashMessage({
        type: "success",
        text: `${response.message} ${periodName} ja esta disponivel para envio.`
      });
      await loadPeriodData();
      await loadDashboardSummary();
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao criar o período."
      });
      return false;
    } finally {
      setLoadingMessage("");
    }
  };

  const openUsersCreateModal = () => {
    navigateToRoute("users");
    setCreateUserSignal((current) => current + 1);
  };

  const openPdfUploadShortcut = () => {
    navigateToRoute("pdfs");
    setFlashMessage({
      type: "success",
      text: "A tela de envio de PDFs foi aberta."
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openMotoristaInAtendimento = (motoristaId: string) => {
    setFinanceMotoristaTarget(motoristaId);
    navigateToRoute("atendimento");
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
      const uploadBatchSize = 10;
      const fileBatches: File[][] = [];
      for (let index = 0; index < files.length; index += uploadBatchSize) {
        fileBatches.push(files.slice(index, index + uploadBatchSize));
      }

      let uploadedTotal = 0;
      const failedFiles: Array<{ fileName: string; message: string }> = [];

      for (let index = 0; index < fileBatches.length; index += 1) {
        const batch = fileBatches[index];
        const response = await uploadPdfs(token, batch, fields, (progress) => {
          setUploadProgress({
            ...progress,
            label: `Enviando lote ${index + 1}/${fileBatches.length}...`
          });
        });

        uploadedTotal += response.uploaded ?? batch.length;
        if (response.failed?.length) {
          failedFiles.push(...response.failed);
        }
      }

      setFlashMessage({
        type: uploadedTotal > 0 ? "success" : "error",
        text:
          failedFiles.length > 0
            ? `${uploadedTotal} PDF(s) enviado(s). ${failedFiles.length} arquivo(s) precisam de revisao. ${failedFiles
                .slice(0, 3)
                .map((file) => `${file.fileName}: ${file.message}`)
                .join(" | ")}`
            : `${uploadedTotal} PDF(s) enviado(s) com sucesso.`
      });
      await Promise.all([loadUploadsData(), loadDashboardSummary()]);
      navigateToRoute("pdfs");
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
        text: error instanceof Error ? error.message : "Falha ao baixar o arquivo."
      });
    }
  };

  const handleOpenUploadHistory = async (uploadId: string) => {
    if (!token) {
      return;
    }

    setLoadingMessage("Carregando histórico do PDF...");

    try {
      const entries = await fetchUploadHistory(token, uploadId);
      setUploadHistory({
        uploadId,
        entries
      });
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao carregar o histórico do PDF."
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

    setLoadingMessage("Excluindo período...");

    try {
      const response = await deletePaymentPeriod(token, periodId);
      setFlashMessage({ type: "success", text: response.message });
      await loadPeriodData();
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao excluir o período."
      });
    } finally {
      setLoadingMessage("");
    }
  };

  const handleUpdatePeriodStatus = async (
    periodId: string,
    status: "disponivel" | "aguardando_aprovacao" | "aprovado"
  ) => {
    if (!token) {
      return;
    }

    const statusLabel =
      status === "disponivel" ? "Reabrindo período..." : status === "aguardando_aprovacao" ? "Finalizando período..." : "Aprovando período...";

    setLoadingMessage(statusLabel);

    try {
      const response = await updatePaymentPeriodStatus(token, periodId, { status });
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadPeriodData(), loadDashboardSummary(), loadUploadsData()]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Falha ao atualizar o status do período.";

      if (status === "aprovado" && /duplicados|analise|análise/i.test(errorMessage)) {
        setPeriodApprovalBlockedMessage(errorMessage);
      }

      setFlashMessage({
        type: "error",
        text: errorMessage
      });
    } finally {
      setLoadingMessage("");
    }
  };

  const handleUpdatePeriodLifecycle = async (periodId: string, active: boolean) => {
    if (!token) {
      return;
    }

    setLoadingMessage(active ? "Reativando período..." : "Finalizando período...");

    try {
      const response = await updatePaymentPeriodLifecycle(token, periodId, active);
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadPeriodData(), loadDashboardSummary()]);
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao alterar a situação do período."
      });
    } finally {
      setLoadingMessage("");
    }
  };

  const handleReviewDuplicateUpload = async (
    uploadId: string,
    action: "aprovar" | "reprovar" | "redirecionar",
    targetBaseId?: string
  ) => {
    if (!token) {
      return;
    }

    setReviewingUploadId(uploadId);

    try {
      const response = await reviewPeriodBaseUpload(token, uploadId, {
        action,
        targetBaseId
      });
      setFlashMessage({ type: "success", text: response.message });
      await Promise.all([loadPeriodData(), loadUploadsData(), loadDashboardSummary()]);
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao revisar PDF."
      });
    } finally {
      setReviewingUploadId(null);
    }
  };

  const openBaseEditor = (base: PaymentBase | null = null) => {
    setEditingBase(base);
    setBaseFormValues(
      base
        ? {
            name: base.name,
            paymentType: base.paymentType,
            active: base.active
          }
        : {
            name: "",
            paymentType: "semanal",
            active: true
          }
    );
    setBaseEditorOpen(true);
  };

  const handleSaveBase = async () => {
    if (!token) {
      return false;
    }

    setLoadingMessage(editingBase ? "Atualizando base..." : "Criando base...");

    try {
      const payload = {
        name: baseFormValues.name.trim(),
        paymentType: baseFormValues.paymentType,
        active: baseFormValues.active
      };

      if (editingBase) {
        const response = await updatePaymentBase(token, editingBase.id, payload);
        setFlashMessage({ type: "success", text: response.message });
      } else {
        const response = await createPaymentBase(token, payload);
        setFlashMessage({ type: "success", text: response.message });
      }

      await loadPeriodData();
      setBaseEditorOpen(false);
      setEditingBase(null);
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao salvar base."
      });
      return false;
    } finally {
      setLoadingMessage("");
    }
  };

  const handleToggleBaseActive = async (base: PaymentBase) => {
    if (!token) {
      return false;
    }

    setLoadingMessage("Excluindo base...");

    try {
      const response = await updatePaymentBase(token, base.id, {
        name: base.name,
        paymentType: base.paymentType,
        active: !base.active
      });

      setFlashMessage({ type: "success", text: response.message });
      await loadPeriodData();
      return true;
    } catch (error) {
      setFlashMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Falha ao atualizar base."
      });
      return false;
    } finally {
      setLoadingMessage("");
    }
  };

  if (view === "login") {
    return (
      <main className="auth-page">
        <section className="auth-hero">
          <div className="auth-dot-grid" aria-hidden="true" />
          <div className="auth-truck-glow" aria-hidden="true" />

          <div className="auth-headline auth-headline--login">
            <img className="auth-brand__logo" src={logoSrc} alt="ALC Pereira Filho Transportes" />
            <h1>
              <span>Portal</span>
              <strong>Administrativo</strong>
            </h1>
            <div className="auth-headline__copy-row">
              <span className="auth-red-line" aria-hidden="true" />
              <p className="auth-copy">
                Gerencie documentos, usuários, bases e rotinas operacionais em um único ambiente.
              </p>
            </div>
          </div>

          <div className="auth-feature-grid" aria-label="Módulos do portal administrativo">
            <article className="auth-feature-card">
              <Receipt size={34} />
              <div>
                <strong>Documentos</strong>
                <span>Upload, gestão e compartilhamento de arquivos.</span>
              </div>
            </article>
            <article className="auth-feature-card">
              <Coins size={34} />
              <div>
                <strong>Financeiro</strong>
                <span>Contas, recebimentos e movimentações financeiras.</span>
              </div>
            </article>
            <article className="auth-feature-card">
              <UsersThree size={34} />
              <div>
                <strong>Usuários</strong>
                <span>Gerencie perfis, permissões e acessos ao sistema.</span>
              </div>
            </article>
            <article className="auth-feature-card">
              <ChartBar size={34} />
              <div>
                <strong>Relatórios</strong>
                <span>Indicadores, gráficos e performance operacional.</span>
              </div>
            </article>
            <article className="auth-feature-card">
              <Database size={34} />
              <div>
                <strong>Bases</strong>
                <span>Gerencie bases de dados e cadastros da operação.</span>
              </div>
            </article>
          </div>

          <div className="hero-preview">
            <div className="hero-preview__window">
              <div className="hero-preview__content hero-preview__content--image">
                {loginPreviewImages.map((src, index) => (
                  <img
                    key={src}
                    className={`hero-preview__image hero-preview__image--layer ${
                      index === loginPreviewIndex ? "hero-preview__image--active" : ""
                    }`}
                    src={src}
                    alt="Prévia do painel administrativo"
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="auth-panel">
          <div className="auth-card auth-card--login">
            <img className="auth-card__logo" src={logoSrc} alt="ALC Pereira Filho Transportes" />
            <h2>Acessar Portal Administrativo</h2>
            <p className="auth-copy">
              Acesso ao sistema
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
                  <Eye size={18} />
                </span>
              </label>

              <div className="auth-form-row">
                <label className="auth-remember">
                  <input type="checkbox" />
                  <span>Lembrar acesso</span>
                </label>
                <button className="auth-forgot-button" type="button">
                  Esqueci minha senha
                </button>
              </div>

              {loadingMessage ? <p className="loading-note">{loadingMessage}</p> : null}
              {loginError ? <p className="form-error">{loginError}</p> : null}

              <button className="primary-button auth-login-button cta-motion" type="submit">
                Entrar
              </button>
            </form>

            <div className="auth-note">
              <LockKey size={18} />
              <span>Ambiente restrito a usuários autorizados</span>
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
          <p className="eyebrow">Segurança obrigatória</p>
          <h2>Altere sua senha para continuar</h2>
          <p className="panel-copy">
            No primeiro acesso, o sistema exige a substituição da senha padrão antes de liberar os
            demais módulos.
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
    <main className={`shell-page ${sidebarOpen ? "shell-page--sidebar-open" : ""}`}>
      <button
        className="shell-mobile-toggle"
        type="button"
        aria-label={sidebarOpen ? "Fechar menu" : "Abrir menu"}
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen((current) => !current)}
      >
        <List size={22} />
      </button>
      {sidebarOpen ? (
        <button
          className="shell-mobile-backdrop"
          type="button"
          aria-label="Fechar menu"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <aside className="sidebar" aria-label="Menu principal">
        <div>
          <nav className="sidebar__nav" aria-label="Navegação principal">
            {allowedMenu.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeView === item.key;
                  return (
                    <button
                      key={item.key}
                      className={`sidebar__item ${isActive ? "sidebar__item--active" : ""}`}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => navigateToRoute(item.key)}
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
          <div className="topbar__brand" aria-label="ALC Pereira Filho Transportes">
            <img src={logoSrc} alt="ALC Pereira Filho Transportes" />
          </div>
          <div className="topbar__actions">
            <div className="notification-area" ref={notificationsRef}>
              <button
                className={`icon-button notification-button ${unreadNotifications ? "notification-button--has-items" : ""}`}
                type="button"
                aria-label="Notificacoes"
                aria-expanded={notificationsOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setNotificationsOpen((current) => !current);
                  setNotifications((current) => current.map((item) => ({ ...item, read: true })));
                }}
              >
                <Bell size={22} />
                {unreadNotifications ? <span className="notification-button__badge">{unreadNotifications}</span> : null}
              </button>

              {notificationsOpen ? (
                <div className="notification-menu" role="menu" aria-label="Notificacoes recentes">
                  <div className="notification-menu__header">
                    <strong>Notificacoes</strong>
                    <span>{notifications.length} registro(s)</span>
                  </div>
                  <div className="notification-menu__list">
                    {notifications.length > 0 ? (
                      notifications.map((item) => {
                        const createdAt = formatDateTimeParts(item.createdAt);

                        return (
                          <div className="notification-menu__item" key={item.id} role="menuitem">
                            <CalendarBlank size={18} />
                            <div>
                              <strong>{item.title}</strong>
                              <span>{item.message}</span>
                              <small>
                                {createdAt.date} as {createdAt.time}
                              </small>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="notification-menu__empty">
                        <strong>Nenhuma notificacao nova</strong>
                        <span>Novos periodos criados vao aparecer aqui.</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="topbar__profile" ref={profileMenuRef}>
              <button
                className="profile-chip cta-motion cta-motion--profile"
                type="button"
                aria-expanded={profileMenuOpen}
                aria-haspopup="menu"
                onClick={() => setProfileMenuOpen((current) => !current)}
              >
                {currentUser?.photoUrl && !profilePhotoBroken ? (
                  <img
                    className="profile-chip__avatar profile-chip__avatar--image"
                    src={currentUser.photoUrl}
                    alt=""
                    onError={() => setProfilePhotoBroken(true)}
                  />
                ) : (
                  <span className="profile-chip__avatar">
                    {currentUser?.name.slice(0, 2).toUpperCase()}
                  </span>
                )}
                <span>
                  <strong>{currentUser?.name}</strong>
                  <small>{currentUser?.email}</small>
                </span>
                <CaretDown size={18} className="profile-chip__chevron" />
              </button>

              {profileMenuOpen ? (
                <div className="profile-menu" role="menu" aria-label="Ações do perfil">
                  <button
                    className="profile-menu__item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      setProfileModalMode("photo");
                      setProfileActionError("");
                    }}
                  >
                    <Camera size={18} />
                    <span>Alterar foto</span>
                  </button>
                  <button
                    className="profile-menu__item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      setProfileModalMode("name");
                      setProfileActionError("");
                    }}
                  >
                    <PencilSimple size={18} />
                    <span>Alterar nome</span>
                  </button>
                  <button
                    className="profile-menu__item"
                    type="button"
                    role="menuitem"
                    aria-pressed={themeMode === "dark"}
                    onClick={() => {
                      setThemeMode((current) => (current === "dark" ? "light" : "dark"));
                      setProfileMenuOpen(false);
                    }}
                  >
                    <GearSix size={18} />
                    <span>{themeMode === "dark" ? "Alterar modo para claro" : "Alterar modo para escuro"}</span>
                  </button>
                  <button
                    className="profile-menu__item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      setProfileModalMode("password");
                      setProfileActionError("");
                    }}
                  >
                    <LockKey size={18} />
                    <span>Alterar senha</span>
                  </button>
                </div>
              ) : null}
            </div>
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
          <div className={`toast-message toast-message--${flashMessage.type}`}>
            <span>{flashMessage.text}</span>
          </div>
        ) : null}

        {activitiesModalOpen ? (
          <div
            className="modal-overlay"
            role="presentation"
            onClick={() => {
              setActivitiesModalOpen(false);
              setActivitiesSearch("");
            }}
          >
            <div
              className="modal-card modal-card--activities"
              role="dialog"
              aria-modal="true"
              aria-labelledby="activities-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-card__header">
                <div>
                  <p className="eyebrow">Auditoria operacional</p>
                  <h3 id="activities-title">Todas as atividades</h3>
                  <p>Pesquise por periodo, arquivo, motorista ou tipo de movimentacao.</p>
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => {
                    setActivitiesModalOpen(false);
                    setActivitiesSearch("");
                  }}
                >
                  Fechar
                </button>
              </div>

              <label className="search-field activity-search-field">
                <MagnifyingGlass size={18} />
                <input
                  value={activitiesSearch}
                  onChange={(event) => setActivitiesSearch(event.target.value)}
                  placeholder="Buscar atividade"
                />
              </label>

              <div className="activity-list activity-list--modal">
                {activitiesLoading ? <p className="loading-note">Carregando atividades...</p> : null}
                {!activitiesLoading && activitiesResult.length > 0 ? (
                  activitiesResult.map((item) => {
                    const occurredAt = formatDateTimeParts(item.occurredAt);

                    return (
                      <div className="activity-item" key={item.id}>
                        <div className="activity-item__icon">
                          {item.icon === "pdf" ? <FilePdf size={22} /> : null}
                          {item.icon === "calendar" ? <CalendarBlank size={22} /> : null}
                          {item.icon === "view" ? <Eye size={22} /> : null}
                        </div>
                        <div className="activity-item__body">
                          <strong>{item.title}</strong>
                          <span>{item.subtitle}</span>
                        </div>
                        <div className="activity-item__meta">
                          <span>{occurredAt.date}</span>
                          <small>{occurredAt.time}</small>
                        </div>
                      </div>
                    );
                  })
                ) : null}
                {!activitiesLoading && activitiesResult.length === 0 ? (
                  <div className="empty-state">
                    <strong>Nenhuma atividade encontrada</strong>
                    <span>Tente buscar por outro periodo, arquivo ou motorista.</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {accessDenied ? (
          <AccessDeniedScreen
            route={accessDenied.route}
            onGoHome={() => navigateToRoute(currentUser ? getDefaultRoute(currentUser) : "dashboard")}
          />
        ) : null}

        {!accessDenied && activeView === "dashboard" ? (
          <DashboardScreen
            currentUser={currentUser}
            summary={dashboardSummary}
            allowedRoutes={allowedMenu.map((item) => item.key)}
            onNavigate={navigateToRoute}
            onOpenCreateUser={openUsersCreateModal}
            onOpenPdfUpload={openPdfUploadShortcut}
            onOpenActivities={() => {
              setActivitiesModalOpen(true);
              void loadDashboardActivities("");
            }}
            onUpdateQuickActions={setQuickActions}
            onCloseQuickActions={() => setQuickActionsOpen(false)}
            onOpenQuickActions={() => setQuickActionsOpen(true)}
            quickActionsOpen={quickActionsOpen}
            quickActions={quickActions}
          />
        ) : null}
        {!accessDenied && activeView === "periods" ? (
          <PeriodsScreen
            token={token}
            currentUser={currentUser}
            bases={paymentBases}
            periods={paymentPeriods}
            onCreatePeriod={handleCreatePeriod}
            onSaveBase={handleSaveBase}
            onOpenBaseEditor={openBaseEditor}
            onToggleBaseActive={handleToggleBaseActive}
            onUpdatePeriodLifecycle={handleUpdatePeriodLifecycle}
            onUpdatePeriodStatus={handleUpdatePeriodStatus}
            onDeletePeriod={requestDeletePeriod}
            onReviewDuplicateUpload={handleReviewDuplicateUpload}
            reviewingUploadId={reviewingUploadId}
          />
        ) : null}
        {periodApprovalBlockedMessage ? (
          <div className="modal-overlay" onClick={() => setPeriodApprovalBlockedMessage(null)}>
            <div
              className="modal-card modal-card--confirm modal-card--periods modal-card--bases"
              role="dialog"
              aria-modal="true"
              aria-labelledby="period-approval-blocked-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-card__header">
                <div>
                  <p className="eyebrow">Aprovacao bloqueada</p>
                  <h3 id="period-approval-blocked-title">Existem motoristas duplicados pendentes</h3>
                  <p>{periodApprovalBlockedMessage}</p>
                </div>
                <button
                  className="ghost-button ghost-button--small"
                  type="button"
                  onClick={() => setPeriodApprovalBlockedMessage(null)}
                >
                  Fechar
                </button>
              </div>
              <div className="crm-empty-screen">
                <strong>Antes de aprovar o período, conclua a revisão dos motoristas duplicados.</strong>
                <p>Você precisa aprovar, reprovar ou redirecionar os itens pendentes para liberar o período.</p>
              </div>
            </div>
          </div>
        ) : null}
        {!accessDenied && activeView === "financeiro" ? (
          <Suspense
            fallback={
              <section className="panel" aria-live="polite">
                <p className="loading-note">Carregando financeiro...</p>
              </section>
            }
          >
            <FinanceiroScreen
              token={token}
              currentUser={currentUser}
              periods={paymentPeriods}
              bases={paymentBases}
              onRefreshPeriods={loadPeriodData}
              onOpenMotorista={openMotoristaInAtendimento}
            />
          </Suspense>
        ) : null}
        {!accessDenied && activeView === "pdfs" ? (
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
        {!accessDenied && activeView === "users" ? (
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
        {!accessDenied && activeView === "atendimento" ? (
          <AtendimentoScreen
            token={token}
            currentUser={currentUser}
            focusMotoristaId={financeMotoristaTarget}
            onConsumeFocusMotorista={() => setFinanceMotoristaTarget(null)}
          />
        ) : null}

        {baseEditorOpen ? (
          <div className="modal-overlay" onClick={() => setBaseEditorOpen(false)}>
            <div
              className="modal-card modal-card--confirm modal-card--periods modal-card--create"
              role="dialog"
              aria-modal="true"
              aria-labelledby="base-editor-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-card__header">
                <div>
                  <p className="eyebrow">Bases do sistema</p>
                  <h3 id="base-editor-title">{editingBase ? "Editar base" : "Nova base"}</h3>
                  <p>Altere o nome, o tipo de pagamento e a situação da base.</p>
                </div>
                <button className="ghost-button ghost-button--small" type="button" onClick={() => setBaseEditorOpen(false)}>
                  Fechar
                </button>
              </div>

              <form
                className="admin-form period-form admin-form--modal base-editor-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveBase();
                }}
              >
                <label className="field">
                  <span>Nome da base</span>
                  <input
                    name="baseName"
                    placeholder="Ex.: ARACATUBA"
                    required
                    value={baseFormValues.name}
                    onChange={(event) =>
                      setBaseFormValues((current) => ({
                        ...current,
                        name: event.target.value
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Tipo de pagamento</span>
                  <select
                    className="field__select"
                    value={baseFormValues.paymentType}
                    onChange={(event) =>
                      setBaseFormValues((current) => ({
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
                  <span>Status da base</span>
                  <select
                    className="field__select"
                    value={baseFormValues.active ? "true" : "false"}
                    onChange={(event) =>
                      setBaseFormValues((current) => ({
                        ...current,
                        active: event.target.value === "true"
                      }))
                    }
                  >
                    <option value="true">Ativa</option>
                    <option value="false">Inativa</option>
                  </select>
                </label>

                <div className="admin-form__actions">
                  <button className="primary-button primary-button--inline" type="submit">
                    {editingBase ? "Salvar base" : "Criar base"}
                    <ArrowRight size={18} weight="bold" />
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : null}
      </section>

      {profileModalMode ? (
        <div className="modal-overlay" onClick={closeProfileModal}>
          <div
            className="modal-card modal-card--profile"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Meu perfil</p>
                <h3 id="profile-modal-title">
                  {profileModalMode === "name"
                    ? "Alterar nome"
                    : profileModalMode === "photo"
                      ? "Alterar foto"
                      : "Alterar senha"}
                </h3>
                <p>As alterações são gravadas diretamente no cadastro do usuário.</p>
              </div>
            </div>

            <form className="form-stack" onSubmit={handleProfileSubmit}>
              {profileModalMode === "name" ? (
                <label className="field">
                  <span>Nome</span>
                  <span className="field__control">
                    <PencilSimple size={18} />
                    <input name="name" type="text" defaultValue={currentUser?.name || ""} required />
                  </span>
                </label>
              ) : null}

              {profileModalMode === "photo" ? (
                <>
                  <div className="profile-photo-preview">
                    {currentUser?.photoUrl && !profilePhotoBroken ? (
                      <img
                        src={currentUser.photoUrl}
                        alt="Foto atual do usuário"
                        onError={() => setProfilePhotoBroken(true)}
                      />
                    ) : (
                      <span>{currentUser?.name.slice(0, 2).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="field">
                    <span>Foto</span>
                    <label className="upload-chooser">
                      <FileArrowUp size={18} weight="bold" />
                      <span>Escolher foto</span>
                      <input name="photo" type="file" accept="image/*" required />
                    </label>
                    <small className="upload-chooser__filename">Selecione uma imagem do perfil</small>
                  </div>
                </>
              ) : null}

              {profileModalMode === "password" ? (
                <>
                  <label className="field">
                    <span>Senha atual</span>
                    <span className="field__control">
                      <LockSimple size={18} />
                      <input name="currentPassword" type="password" required />
                    </span>
                  </label>
                  <label className="field">
                    <span>Nova senha</span>
                    <span className="field__control">
                      <LockSimple size={18} />
                      <input name="newPassword" type="password" minLength={6} required />
                    </span>
                  </label>
                  <label className="field">
                    <span>Confirmar nova senha</span>
                    <span className="field__control">
                      <LockSimple size={18} />
                      <input name="confirmPassword" type="password" minLength={6} required />
                    </span>
                  </label>
                </>
              ) : null}

              {profileActionError ? <p className="form-error">{profileActionError}</p> : null}
              {profileActionLoading ? <p className="loading-note">Salvando alterações...</p> : null}

              <div className="confirm-actions">
                <button className="ghost-button" type="button" onClick={closeProfileModal}>
                  Cancelar
                </button>
                <button className="primary-button primary-button--inline cta-motion" type="submit" disabled={profileActionLoading}>
                  Salvar alterações
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

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
                <p className="eyebrow">Confirmação</p>
                <h3 id="delete-user-title">Excluir usuário</h3>
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
                className="primary-button primary-button--inline cta-motion"
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
                <p className="eyebrow">Confirmação</p>
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
                className="primary-button primary-button--inline cta-motion"
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
                <p className="eyebrow">Confirmação</p>
                <h3 id="delete-period-title">Excluir período</h3>
                <p>
                  Excluir permanentemente o período <strong>{deletePeriodTarget.name}</strong>?
                </p>
              </div>
            </div>

            <div className="confirm-actions">
              <button className="ghost-button" type="button" onClick={() => setDeletePeriodTarget(null)}>
                Cancelar
              </button>
              <button
                className="primary-button primary-button--inline cta-motion"
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
  allowedRoutes,
  onNavigate,
  onOpenCreateUser,
  onOpenPdfUpload,
  onOpenActivities,
  onUpdateQuickActions,
  onCloseQuickActions,
  onOpenQuickActions,
  quickActionsOpen,
  quickActions
}: {
  currentUser: SessionUser | null;
  summary: DashboardSummary;
  allowedRoutes: RouteView[];
  onNavigate: (route: RouteView) => void;
  onOpenCreateUser: () => void;
  onOpenPdfUpload: () => void;
  onOpenActivities: () => void;
  onUpdateQuickActions: (routes: RouteView[]) => void;
  onCloseQuickActions: () => void;
  onOpenQuickActions: () => void;
  quickActionsOpen: boolean;
  quickActions: RouteView[];
}) {
  const stats = [
    {
      label: "PDFs Enviados",
      value: String(summary.pdfsSent),
      detail: `${summary.processedPdfs} finalizados`,
      icon: FilePdf
    },
    {
      label: "Usuários Ativos",
      value: String(summary.usersCount),
      detail: "Base operacional do portal",
      icon: UsersThree
    },
    {
      label: "Pendencias",
      value: String(summary.pendingPdfs),
      detail: "Aguardando processamento",
      icon: Eye
    }
  ];

  const quickActionOptions = allowedRoutes.filter((route) => route !== "dashboard");

  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Visao geral</p>
          <h1>Bem-vindo ao Portal Administrativo!</h1>
          <p>
            Gerencie informações, documentos e usuários do sistema com uma experiência corporativa
            clara e modular.
          </p>
        </div>
        <div className="quick-meta">
          <span className="quick-meta__chip">Nivel {currentUser?.level as AccessLevel}</span>
          <span className="quick-meta__chip">Ultimos 7 dias</span>
        </div>
      </section>

      {quickActionsOpen ? (
        <div className="modal-overlay" onClick={onCloseQuickActions}>
          <div
            className="modal-card modal-card--confirm modal-card--user modal-card--quick-actions"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quick-actions-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Acesso rápido</p>
                <h3 id="quick-actions-title">Editar atalhos</h3>
                <p>Selecione apenas as telas que este usuário pode acessar.</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={onCloseQuickActions}>
                Fechar
              </button>
            </div>

            <div className="quick-actions-editor">
              {quickActionOptions.map((route) => {
                const config = quickActionLabels[route];
                const checked = quickActions.includes(route);
                const Icon = config.icon;

                return (
                  <label className="quick-actions-editor__item" key={route}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        onUpdateQuickActions(
                          event.target.checked
                            ? Array.from(new Set([...quickActions, route]))
                            : quickActions.filter((item) => item !== route)
                        );
                      }}
                    />
                    <span className="quick-actions-editor__icon">
                      <Icon size={18} />
                    </span>
                    <span className="quick-actions-editor__text">
                      <strong>{config.title}</strong>
                      <small>{config.description}</small>
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="modal-card__actions">
              <button className="ghost-button" type="button" onClick={onCloseQuickActions}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel__header panel__header--split">
          <div>
            <h3>Acesso Rápido</h3>
            <p>Atalhos operacionais para a equipe administrativa</p>
          </div>
          <button className="ghost-button ghost-button--small" type="button" onClick={onOpenQuickActions}>
            Editar atalhos
          </button>
        </div>

        <div className="quick-actions">
          {quickActions.map((route) => {
            const config = quickActionLabels[route];
            const Icon = config.icon;

            return (
              <button
                className="quick-action-card"
                type="button"
                key={route}
                onClick={() => {
                  if (route === "pdfs") {
                    onOpenPdfUpload();
                    return;
                  }

                  if (route === "users") {
                    onOpenCreateUser();
                    return;
                  }

                  onNavigate(route);
                }}
              >
                <div className="quick-action-card__icon">
                  <Icon size={26} />
                </div>
                <div>
                  <strong>{config.title}</strong>
                  <span>{config.description}</span>
                </div>
                <ArrowRight size={20} />
              </button>
            );
          })}
        </div>
      </section>

      <section className="stats-grid stats-grid--three">
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
        <article className="panel panel--period-summary">
          <div className="panel__header">
            <div>
              <h3>Resumo Geral</h3>
              <p>Status operacional dos periodos de pagamento mais recentes</p>
            </div>
            <button className="ghost-button" type="button" onClick={() => onNavigate("financeiro")}>
              Ver financeiro
            </button>
          </div>

          <div className="dashboard-period-list">
            {summary.periodSummaries.length > 0 ? (
              summary.periodSummaries.map((period) => (
                <article className="dashboard-period-card" key={period.id}>
                  <div className="dashboard-period-card__header">
                    <div>
                      <strong>{period.name}</strong>
                      <span>
                        {formatDateOnly(period.startDate)} ate {formatDateOnly(period.endDate)}
                      </span>
                    </div>
                    <span className="status-pill">{formatStatusLabel(period.status)}</span>
                  </div>

                  <div className="dashboard-period-card__metrics">
                    <span>
                      <strong>{period.pdfsSent}</strong>
                      <small>PDFs enviados</small>
                    </span>
                    <span>
                      <strong>{period.notesReceived}</strong>
                      <small>Notas fiscais recebidas</small>
                    </span>
                    <span>
                      <strong>{period.notesPending}</strong>
                      <small>Notas fiscais pendentes</small>
                    </span>
                    <span>
                      <strong>{period.paidDrivers}</strong>
                      <small>Motoristas pagos</small>
                    </span>
                  </div>
                </article>
              ))
            ) : (
              <div className="empty-state">
                <strong>Nenhum periodo com movimentacao</strong>
                <span>Crie um periodo ou envie PDFs para acompanhar o resumo aqui.</span>
              </div>
            )}
          </div>
        </article>

        <article className="panel">
          <div className="panel__header">
            <div>
              <h3>Atividades Recentes</h3>
              <p>Movimentacoes operacionais auditadas no sistema</p>
            </div>
            <button className="ghost-button" type="button" onClick={onOpenActivities}>
              Ver todas
            </button>
          </div>

          <div className="activity-list">
            {summary.recentActivities.length > 0 ? (
              summary.recentActivities.map((item) => {
                const occurredAt = formatDateTimeParts(item.occurredAt);

                return (
                  <div className="activity-item" key={item.id}>
                    <div className="activity-item__icon">
                      {item.icon === "pdf" ? <FilePdf size={22} /> : null}
                      {item.icon === "calendar" ? <CalendarBlank size={22} /> : null}
                      {item.icon === "view" ? <Eye size={22} /> : null}
                    </div>
                    <div className="activity-item__body">
                      <strong>{item.title}</strong>
                      <span>{item.subtitle}</span>
                    </div>
                    <div className="activity-item__meta">
                      <span>{occurredAt.date}</span>
                      <small>{occurredAt.time}</small>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="empty-state">
                <strong>Nenhuma atividade recente</strong>
                <span>Envios, periodos e alteracoes de espelho vao aparecer aqui.</span>
              </div>
            )}
          </div>
        </article>
      </section>
    </div>
  );
}

function PeriodsScreen({
  token,
  currentUser,
  bases,
  periods,
  onCreatePeriod,
  onSaveBase,
  onOpenBaseEditor,
  onToggleBaseActive,
  onUpdatePeriodLifecycle,
  onUpdatePeriodStatus,
  onDeletePeriod,
  onReviewDuplicateUpload,
  reviewingUploadId
}: {
  token: string;
  currentUser: SessionUser | null;
  bases: PaymentBase[];
  periods: PaymentPeriod[];
  onCreatePeriod: (payload: {
    name: string;
    startDate: string;
    endDate: string;
    paymentType: "semanal" | "quinzenal" | "mensal";
  }) => Promise<boolean> | boolean;
  onSaveBase: () => Promise<boolean> | boolean;
  onOpenBaseEditor: (base: PaymentBase | null) => void;
  onToggleBaseActive: (base: PaymentBase) => Promise<boolean> | boolean;
  onUpdatePeriodLifecycle: (periodId: string, active: boolean) => Promise<void> | void;
  onUpdatePeriodStatus: (
    periodId: string,
    status: "disponivel" | "aguardando_aprovacao" | "aprovado"
  ) => Promise<void> | void;
  onDeletePeriod: (period: PaymentPeriod) => void;
  onReviewDuplicateUpload: (
    uploadId: string,
    action: "aprovar" | "reprovar" | "redirecionar",
    targetBaseId?: string
  ) => Promise<void> | void;
  reviewingUploadId: string | null;
}) {
  const [formValues, setFormValues] = useState({
    name: "",
    startDate: "",
    endDate: "",
    paymentType: "semanal" as "semanal" | "quinzenal" | "mensal"
  });
  const [isCreatePeriodModalOpen, setIsCreatePeriodModalOpen] = useState(false);
  const [isBasePanelOpen, setIsBasePanelOpen] = useState(false);
  const [isDuplicateReviewModalOpen, setIsDuplicateReviewModalOpen] = useState(false);
  const [duplicateReviewPeriodId, setDuplicateReviewPeriodId] = useState<string | null>(null);
  const [duplicateReviewPeriodName, setDuplicateReviewPeriodName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"created" | "financeActive" | "financeFinished">("created");
  const [financeFinishedSearch, setFinanceFinishedSearch] = useState("");
  const [duplicateReviews, setDuplicateReviews] = useState<PeriodBaseReviewItem[]>([]);
  const [duplicateRedirectTargets, setDuplicateRedirectTargets] = useState<Record<string, string>>({});

  const activeBases = useMemo(() => bases.filter((base) => base.active), [bases]);

  const baseByType = useMemo(
    () =>
      activeBases.reduce<Record<string, PaymentBase[]>>((accumulator, base) => {
        const key = base.paymentType;
        accumulator[key] = [...(accumulator[key] || []), base];
        return accumulator;
      }, {}),
    [activeBases]
  );

  const createdPeriods = useMemo(
    () => periods.filter((period) => period.status === "disponivel" && period.active !== false),
    [periods]
  );

  const financeActivePeriods = useMemo(
    () => periods.filter((period) => period.status !== "disponivel" && period.active !== false),
    [periods]
  );

  const financeFinishedPeriods = useMemo(() => periods.filter((period) => period.active === false), [periods]);

  const filteredFinanceFinishedPeriods = useMemo(() => {
    const normalizedSearch = financeFinishedSearch.trim().toLowerCase();

    if (!normalizedSearch) {
      return financeFinishedPeriods;
    }

    return financeFinishedPeriods.filter((period) => {
      const dateRange = `${formatDateOnly(period.startDate)} ${formatDateOnly(period.endDate)}`.toLowerCase();
      return period.name.toLowerCase().includes(normalizedSearch) || dateRange.includes(normalizedSearch);
    });
  }, [financeFinishedPeriods, financeFinishedSearch]);

  const visiblePeriods = useMemo(() => {
    if (activeTab === "created") {
      return createdPeriods;
    }

    if (activeTab === "financeActive") {
      return financeActivePeriods;
    }

    return filteredFinanceFinishedPeriods;
  }, [activeTab, createdPeriods, financeActivePeriods, filteredFinanceFinishedPeriods]);

  const loadDuplicateReviews = async (periodId?: string | null) => {
    const data = await fetchPeriodBaseReviews(token, periodId || null);
    setDuplicateReviews(data);
  };

  const openDuplicateReviewModal = async (periodId?: string | null, periodName?: string | null) => {
    setDuplicateReviewPeriodId(periodId || null);
    setDuplicateReviewPeriodName(periodName || null);
    setDuplicateRedirectTargets({});
    setIsDuplicateReviewModalOpen(true);
    try {
      await loadDuplicateReviews(periodId || null);
    } catch {
      setDuplicateReviews([]);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const success = await onCreatePeriod(formValues);

    if (success) {
      setIsCreatePeriodModalOpen(false);
      setFormValues({
        name: "",
        startDate: "",
        endDate: "",
        paymentType: "semanal"
      });
      await loadDuplicateReviews();
    }
  };

  if (!currentUser || (currentUser.level !== "N3" && currentUser.level !== "N4")) {
    return (
      <div className="screen">
      <section className="panel">
          <h3>Acesso restrito</h3>
          <p>Esta funcionalidade está liberada apenas para N3 e N4.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Administração de períodos</p>
          <h1>Criação de Período</h1>
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
            <span>Períodos cadastrados</span>
            <small>Disponíveis para envio de PDFs</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <GearSix size={30} />
          </div>
          <div>
            <strong>{activeBases.length}</strong>
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
            <span>Autorização</span>
            <small>Controle administrativo total</small>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel__header panel__header--split">
          <div>
            <h3>Novo período de pagamento</h3>
            <p>Abra o pop-up para criar um novo período com o mesmo fluxo visual já usado no sistema.</p>
          </div>
          <button
            className="primary-button primary-button--inline cta-motion"
            type="button"
            onClick={() => setIsCreatePeriodModalOpen(true)}
          >
            Novo período de pagamento
            <ArrowRight size={18} weight="bold" />
          </button>
        </div>

        <div className="period-launch-card">
          <div>
            <strong>Bases cadastradas</strong>
            <p>Edite nome, tipo e status das bases sem sair do módulo de períodos.</p>
          </div>
          <div className="period-launch-card__actions">
            <button className="ghost-button cta-motion cta-motion--ghost" type="button" onClick={() => setIsBasePanelOpen(true)}>
              Gerenciar bases
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel__header panel__header--split">
          <div>
            <h3>Períodos cadastrados</h3>
            <p>Visualize os períodos criados, os períodos ativos no Financeiro e os períodos finalizados em abas separadas.</p>
          </div>
          <div className="period-tabs" role="tablist" aria-label="Filtro de períodos">
            <button
              className={`period-tab ${activeTab === "created" ? "period-tab--active" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeTab === "created"}
              onClick={() => setActiveTab("created")}
            >
              Períodos criados
            </button>
            <button
              className={`period-tab ${activeTab === "financeActive" ? "period-tab--active" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeTab === "financeActive"}
              onClick={() => setActiveTab("financeActive")}
            >
              Períodos ativos
            </button>
            <button
              className={`period-tab ${activeTab === "financeFinished" ? "period-tab--active" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeTab === "financeFinished"}
              onClick={() => setActiveTab("financeFinished")}
            >
              Períodos finalizados
            </button>
          </div>
        </div>

        {activeTab === "financeFinished" ? (
          <div className="period-list__toolbar">
            <label className="search-field period-list__search">
              <MagnifyingGlass size={18} />
              <input
                type="search"
                value={financeFinishedSearch}
                onChange={(event) => setFinanceFinishedSearch(event.target.value)}
                placeholder="Buscar período finalizado no Financeiro"
                aria-label="Buscar período finalizado no Financeiro"
              />
            </label>
          </div>
        ) : null}

        <div className="period-list">
          {visiblePeriods.map((period) => {
            const uploadedByBaseEntries = period.bases.map((base) => ({
              ...base,
              total: period.uploadedByBase[base.id] || 0
            }));
            return (
              <article className="period-card" key={period.id}>
                <div>
                  <p className="eyebrow">Período {period.paymentType.toUpperCase()}</p>
                  <h4>{period.name}</h4>
                  <p>
                    {formatDateOnly(period.startDate)} a {formatDateOnly(period.endDate)}
                  </p>
                </div>

                <div className="period-card__meta">
                  <span className={`status-pill ${period.status === "disponivel" ? "status-pill--active" : ""}`}>
                    {formatStatusLabel(period.status)}
                  </span>
                  <div className="period-card__totals">
                    <div className="period-card__metric">
                      <strong>{period.uploadedTotal}</strong>
                      <small>PDFs anexados</small>
                    </div>
                  </div>
                </div>

                <div className="module-chips">
                  {uploadedByBaseEntries.map((base) => (
                    <div className="base-summary-chip" key={`${period.id}-${base.id}`}>
                      <span className="base-summary-chip__name">{base.name}</span>
                      <span className="base-summary-chip__count">{base.total} PDF{base.total === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                </div>

                <div className="period-card__actions">
                  {activeTab !== "created" ? (
                    <label className="period-lifecycle-control">
                      <span>Visibilidade no Financeiro</span>
                      <select
                        aria-label={`Visibilidade do período ${period.name} no Financeiro`}
                        value={period.active !== false ? "active" : "finished"}
                        onChange={(event) => void onUpdatePeriodLifecycle(period.id, event.target.value === "active")}
                      >
                        <option value="active">Ativo</option>
                        <option value="finished">Finalizado</option>
                      </select>
                    </label>
                  ) : null}
                  <button
                    className="ghost-button ghost-button--small ghost-button--danger"
                    type="button"
                    onClick={() => onDeletePeriod(period)}
                  >
                    Excluir
                    <TrashSimple size={16} />
                  </button>
                  <button
                    className="ghost-button ghost-button--small"
                    type="button"
                    onClick={() => void openDuplicateReviewModal(period.id, period.name)}
                  >
                    Motoristas duplicados
                  </button>
                  <button
                    className="ghost-button ghost-button--small"
                    type="button"
                    onClick={() =>
                      void onUpdatePeriodStatus(
                        period.id,
                        period.status === "disponivel" ? "aguardando_aprovacao" : "disponivel"
                      )
                    }
                  >
                    {period.status === "disponivel" ? "Finalizar período" : "Reabrir período"}
                  </button>
                  {period.status === "disponivel" ? (
                    <button
                      className="ghost-button ghost-button--small"
                      type="button"
                      onClick={() => void onUpdatePeriodStatus(period.id, "aprovado")}
                    >
                      Aprovar período
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
          {visiblePeriods.length === 0 ? (
            <div className="empty-state">
              <strong>
                {activeTab === "created"
                  ? "Nenhum período criado encontrado"
                  : activeTab === "financeActive"
                    ? "Nenhum período ativo encontrado no Financeiro"
                    : "Nenhum período finalizado encontrado no Financeiro"}
              </strong>
              <p>
                {activeTab === "financeFinished"
                  ? "Ajuste a busca ou finalize a visibilidade de um período no Financeiro para vê-lo aqui."
                  : "Crie um novo período ou altere o status de um registro existente para vê-lo aqui."}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {isBasePanelOpen ? (
        <div className="modal-overlay" onClick={() => setIsBasePanelOpen(false)}>
          <div
            className="modal-card modal-card--confirm modal-card--periods modal-card--bases"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bases-panel-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Bases do sistema</p>
                <h3 id="bases-panel-title">Gerenciar bases</h3>
                <p>Altere o tipo de pagamento ou adicione uma nova base.</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={() => setIsBasePanelOpen(false)}>
                Fechar
              </button>
            </div>

            <div className="base-management-toolbar">
              <button className="primary-button primary-button--inline" type="button" onClick={() => onOpenBaseEditor(null)}>
                Nova base
                <ArrowRight size={18} weight="bold" />
              </button>
            </div>

            <div className="base-management-list">
              <div className="base-management-head">
                <span>Base</span>
                <span>Tipo</span>
                <span>Status</span>
                <span>Ações</span>
              </div>
              {activeBases.map((base) => (
                <div className="base-management-row" key={base.id}>
                  <div className="base-management-cell base-management-cell--strong">
                    <strong>{base.name}</strong>
                  </div>
                  <div className="base-management-cell">
                    <span>{formatStatusLabel(base.paymentType)}</span>
                  </div>
                  <div className="base-management-cell">
                    <span className={`status-pill ${base.active ? "status-pill--active" : ""}`}>
                      {base.active ? "Ativa" : "Inativa"}
                    </span>
                  </div>
                  <div className="base-management-cell base-management-cell--actions">
                    <button className="ghost-button ghost-button--small" type="button" onClick={() => onOpenBaseEditor(base)}>
                      Editar
                      <PencilSimple size={16} />
                    </button>
                    <button className="ghost-button ghost-button--small ghost-button--danger" type="button" onClick={() => void onToggleBaseActive(base)}>
                      Excluir
                      <TrashSimple size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="modal-card__actions">
              <button className="ghost-button" type="button" onClick={() => setIsBasePanelOpen(false)}>
                Fechar painel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isDuplicateReviewModalOpen ? (
        <div
          className="modal-overlay"
          onClick={() => {
            setIsDuplicateReviewModalOpen(false);
            setDuplicateReviewPeriodId(null);
            setDuplicateReviewPeriodName(null);
          }}
        >
          <div
            className="modal-card modal-card--confirm modal-card--periods modal-card--bases"
            role="dialog"
            aria-modal="true"
            aria-labelledby="duplicate-review-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Motoristas duplicados</p>
                <h3 id="duplicate-review-title">Revisão de base dos uploads</h3>
                <p>
                  {duplicateReviewPeriodName
                    ? `Período selecionado: ${duplicateReviewPeriodName}`
                    : "Confira os arquivos com base divergente e decida com N3/N4."}
                </p>
              </div>
              <button
                className="ghost-button ghost-button--small"
                type="button"
                onClick={() => {
                  setIsDuplicateReviewModalOpen(false);
                  setDuplicateReviewPeriodId(null);
                  setDuplicateReviewPeriodName(null);
                }}
              >
                Fechar
              </button>
            </div>

            <div className="duplicate-review-list">
              {duplicateReviews.length > 0 ? (
                duplicateReviews.map((item) => {
                  const cases = item.cases || [];

                  return (
                    <article className="duplicate-review-card" key={item.id}>
                      <div className="duplicate-review-card__main">
                        <div>
                          <strong>{item.motoristaNome}</strong>
                          <span>{item.motoristaCpf}</span>
                          <p>Base cadastrada: {item.baseCadastrada || item.baseRegistrada}</p>
                        </div>
                      </div>

                      <div className="duplicate-review-group">
                        {cases.map((duplicateCase) => {
                          const selectedRedirectBaseId = duplicateRedirectTargets[duplicateCase.id] || "";
                          const canRedirect = Boolean(selectedRedirectBaseId);

                          return (
                            <div className="duplicate-review-case" key={duplicateCase.id}>
                              <div className="duplicate-review-case__summary">
                                <strong>Base enviada: {duplicateCase.baseEnviada}</strong>
                                <span>{duplicateCase.periodName}</span>
                                <small>{new Date(duplicateCase.uploadedAt).toLocaleString("pt-BR")}</small>
                              </div>

                              <div className="duplicate-review-card__redirect">
                                <label htmlFor={`redirect-base-${duplicateCase.id}`}>Base de destino</label>
                                <select
                                  id={`redirect-base-${duplicateCase.id}`}
                                  value={selectedRedirectBaseId}
                                  onChange={(event) =>
                                    setDuplicateRedirectTargets((current) => ({
                                      ...current,
                                      [duplicateCase.id]: event.target.value
                                    }))
                                  }
                                >
                                  <option value="">Selecione a base para redirecionar</option>
                                  {activeBases
                                    .filter(
                                      (base) =>
                                        base.name.toLowerCase().trim() !== (item.baseCadastrada || item.baseRegistrada).toLowerCase().trim()
                                    )
                                    .map((base) => (
                                      <option key={base.id} value={base.id}>
                                        {base.name} ({base.paymentType})
                                      </option>
                                    ))}
                                </select>
                              </div>

                              <div className="table-actions">
                                <button
                                  className="ghost-button ghost-button--small"
                                  type="button"
                                  disabled={reviewingUploadId === duplicateCase.id}
                                  onClick={() => void onReviewDuplicateUpload(duplicateCase.id, "aprovar")}
                                >
                                  Aprovar
                                </button>
                                <button
                                  className="ghost-button ghost-button--small ghost-button--danger"
                                  type="button"
                                  disabled={reviewingUploadId === duplicateCase.id}
                                  onClick={() => void onReviewDuplicateUpload(duplicateCase.id, "reprovar")}
                                >
                                  Reprovar
                                </button>
                                <button
                                  className="ghost-button ghost-button--small"
                                  type="button"
                                  disabled={reviewingUploadId === duplicateCase.id || !canRedirect}
                                  onClick={() => void onReviewDuplicateUpload(duplicateCase.id, "redirecionar", selectedRedirectBaseId)}
                                >
                                  Redirecionar
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="crm-empty-screen">
                  <strong>Nenhum motorista duplicado pendente</strong>
                  <p>Quando houver divergencia de base, os itens aparecem aqui para revisao.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {isCreatePeriodModalOpen ? (
        <div className="modal-overlay" onClick={() => setIsCreatePeriodModalOpen(false)}>
          <div
            className="modal-card modal-card--confirm modal-card--periods modal-card--create"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-period-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Administração de períodos</p>
                <h3 id="create-period-title">Novo período de pagamento</h3>
                <p>Defina a descrição, o tipo e o intervalo para gerar o período.</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={() => setIsCreatePeriodModalOpen(false)}>
                Fechar
              </button>
            </div>

            <form className="admin-form period-form admin-form--modal" onSubmit={handleSubmit}>
              <label className="field">
                <span>Descrição do período</span>
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

              <div className="field field--full field--bases">
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
                  Criar período
                  <ArrowRight size={18} weight="bold" />
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

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

  const availablePeriods = useMemo(() => periods.filter((period) => period.active !== false), [periods]);
  const selectedPeriod = availablePeriods.find((period) => period.id === selectedPeriodId) || null;
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
        const key = `${row.periodId || "sem-periodo"}|${row.baseId || "sem-base"}|${row.owner}`;
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
          periodName: row.periodName || "Período não definido",
          baseName: row.baseName || "Base não definida",
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
            <h3>Período ativo para envio</h3>
            <p>Escolha o período e a base antes de anexar os PDFs.</p>
          </div>
        </div>

        <div className="filters-row filters-row--stack">
          <label className="filter-select">
            <CalendarBlank size={18} />
            <select value={selectedPeriodId} onChange={(event) => setSelectedPeriodId(event.target.value)}>
              <option value="">Selecione um período</option>
              {availablePeriods.map((period) => (
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
            className="primary-button primary-button--inline file-picker cta-motion cta-motion--upload"
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!selectedPeriodId || !selectedBaseId}
          >
            Novo upload
            <FileArrowUp size={18} weight="bold" />
          </button>
        </div>

        <div className="period-tiles">
          {availablePeriods.map((period) => (
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
              placeholder="Buscar por arquivo ou responsável"
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
                      {batch.ownerName} - {batch.periodName} -{" "}
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
                            {row.status} - {new Date(row.sentAt).toLocaleString("pt-BR")}
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
                            Histórico
                          </button>
                          <label className="ghost-button ghost-button--small file-picker file-picker--ghost cta-motion cta-motion--ghost">
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
              <h3>Histórico de Versões</h3>
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
                    Versao {entry.version} - {entry.fileName}
                  </strong>
                  <span>
                    {entry.owner} - {new Date(entry.sentAt).toLocaleString("pt-BR")}
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
          <p className="eyebrow">Administração</p>
          <h1>Cadastro de Usuários</h1>
          <p>Gestão de níveis, status, módulos liberados e histórico operacional.</p>
        </div>
        <button className="primary-button primary-button--inline cta-motion" type="button" onClick={openCreateModal}>
          Novo usuário
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
            <span>Usuários na base</span>
            <small>Sincronizados com PostgreSQL</small>
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-card__icon">
            <GearSix size={30} />
          </div>
          <div>
            <strong>RBAC</strong>
            <span>Controle por perfil e módulo</span>
            <small>Grant e deny por usuário</small>
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
            <p>Refine a operação por nome, e-mail, nível e situação</p>
          </div>
        </div>

        <div className="filters-row">
          <label className="search-field">
            <MagnifyingGlass size={18} />
            <input
              placeholder="Buscar usuário por nome ou e-mail"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>

          <label className="filter-select">
            <FunnelSimple size={18} />
            <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)}>
              <option value="todos">Todos os níveis</option>
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
            <h3>Usuários cadastrados</h3>
            <p>{filteredUsers.length} usuário(s) retornado(s) pelos filtros atuais</p>
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
                <th>Módulos</th>
                <th>Ações</th>
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
                          {moduleLabels[moduleCode] || moduleCode}
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
            className="modal-card modal-card--user"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Administração</p>
                <h3 id="user-modal-title">{editingUserId ? "Editar usuário" : "Novo usuário"}</h3>
                <p>Cadastro com senha temporária 0000 e controle de módulos por usuário</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={closeModal}>
                Fechar
              </button>
            </div>

            <form className="admin-form admin-form--modal user-form--modal" onSubmit={handleSubmit}>
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

              <div className="field field--full user-modules-field">
                <span>Módulos</span>
                <div className="checkbox-grid">
                  {userModuleOptions.map((module) => (
                    <label className="checkbox-chip" key={module.code}>
                      <input
                        type="checkbox"
                        checked={selectedModules.includes(module.code)}
                        onChange={(event) => {
                          setSelectedModules((current) =>
                            event.target.checked
                              ? Array.from(new Set([...current, module.code]))
                              : current.filter((item) => item !== module.code)
                          );
                        }}
                      />
                      <span>{module.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="admin-form__actions">
                <button className="primary-button primary-button--inline" type="submit">
                  {editingUserId ? "Salvar alterações" : "Criar usuário"}
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
  currentUser,
  focusMotoristaId,
  onConsumeFocusMotorista
}: {
  token: string;
  currentUser: SessionUser | null;
  focusMotoristaId?: string | null;
  onConsumeFocusMotorista?: () => void;
}) {
  const isAdmin = currentUser?.level === "N3" || currentUser?.level === "N4";
  const detailTabs = [
    { key: "dados", label: "Dados do Motorista" },
    { key: "classificacoes", label: "Classificações" },
    { key: "notas", label: "Notas internas" },
    { key: "pdfs", label: "Histórico de PDFs" },
    { key: "pagamentos", label: "Histórico de Pagamentos" },
    { key: "historico", label: "Histórico de Atendimento" },
    { key: "chamados", label: "Chamados" }
  ] as const;
  type DetailTab = (typeof detailTabs)[number]["key"];

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<AtendimentoMotoristaSearch[]>([]);
  const [selectedMotoristaId, setSelectedMotoristaId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AtendimentoDetail | null>(null);
  const [classificacoes, setClassificacoes] = useState<AtendimentoClassificacao[]>([]);
  const [selectedClassificacoes, setSelectedClassificacoes] = useState<string[]>([]);
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>("dados");
  const [statusFilter, setStatusFilter] = useState<AtendimentoDetail["chamados"][number]["status"] | "todos">(
    "todos"
  );
  const [paymentHistoryQuery, setPaymentHistoryQuery] = useState("");
  const [loading, setLoading] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [editingNote, setEditingNote] = useState<{ id: string; content: string } | null>(null);
  const [motoristaEditOpen, setMotoristaEditOpen] = useState(false);
  const [motoristaEditForm, setMotoristaEditForm] = useState<AtendimentoMotoristaUpdatePayload | null>(null);
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

  const filteredPaymentHistory = useMemo(() => {
    if (!detail) {
      return [];
    }

    const query = paymentHistoryQuery.trim().toLowerCase();

    if (!query) {
      return detail.historicoPagamentos;
    }

      return detail.historicoPagamentos.filter((item) => {
        const haystack = [
          item.periodoPagamento,
          item.basePagamento,
          item.statusProcesso,
          item.pdfStatus,
          item.notaFiscalStatus,
          item.pago ? "pago" : "em aberto",
          item.pdfEnviadoEm,
          item.pdfVisualizadoEm,
          item.notaFiscalEnviadaEm,
          item.notaFiscalRecebidaEm
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [detail, paymentHistoryQuery]);

  const selectedMotoristaBase = detail?.motorista.base || detail?.motorista.empresaVinculada || "Base não informada";

  const buildMotoristaEditForm = (motorista: AtendimentoDetail["motorista"]): AtendimentoMotoristaUpdatePayload => ({
    nome: motorista.nome || "",
    cpf: motorista.cpf || "",
    rg: motorista.rg || "",
    dataNascimento: motorista.dataNascimento ? new Date(motorista.dataNascimento).toISOString().slice(0, 10) : "",
    telefone: motorista.telefone || "",
    whatsapp: motorista.whatsapp || "",
    email: motorista.email || "",
    endereco: motorista.endereco || "",
    cidade: motorista.cidade || "",
    estado: motorista.estado || "",
    cep: motorista.cep || "",
    statusCadastro: motorista.statusCadastro,
    empresaVinculada: motorista.empresaVinculada || "",
    observacoesGerais: motorista.observacoesGerais || ""
  });

  useEffect(() => {
    if (focusMotoristaId) {
      setSearchTerm("");
      setSelectedMotoristaId(focusMotoristaId);
      onConsumeFocusMotorista?.();
    }
  }, [focusMotoristaId, onConsumeFocusMotorista]);

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
          setLoading(error instanceof Error ? error.message : "Falha ao buscar o motorista.");
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
        setLoading(error instanceof Error ? error.message : "Falha ao carregar o motorista.");
      } finally {
        setLoading("");
      }
    })();
  }, [selectedMotoristaId, token]);

  useEffect(() => {
    if (!detail) {
      setSelectedClassificacoes([]);
      setMotoristaEditOpen(false);
      setMotoristaEditForm(null);
      setActiveDetailTab("dados");
      setPaymentHistoryQuery("");
      return;
    }

    setSelectedClassificacoes(detail.motorista.classificacoes.map((item) => item.id));
    setMotoristaEditForm(buildMotoristaEditForm(detail.motorista));
  }, [detail]);

  useEffect(() => {
    if (!selectedMotoristaId) {
      return;
    }

    setActiveDetailTab("dados");
    setTicketAction(null);
    setNewTicketOpen(false);
    setEditingNote(null);
    setMotoristaEditOpen(false);
    setPaymentHistoryQuery("");
  }, [selectedMotoristaId]);

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

  const handleOpenMotoristaEdit = () => {
    if (!detail) {
      return;
    }

    setMotoristaEditForm(buildMotoristaEditForm(detail.motorista));
    setMotoristaEditOpen(true);
  };

  const handleMotoristaEditSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!detail || !motoristaEditForm) {
      return;
    }

    setLoading("Atualizando motorista...");

    try {
      const response = await updateAtendimentoMotorista(token, detail.motorista.id, motoristaEditForm);

      if (response.detail) {
        setDetail(response.detail);
      } else {
        await refreshDetail(detail.motorista.id);
      }

      setMotoristaEditOpen(false);
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao atualizar motorista.");
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

    setLoading("Registrando movimentação...");

    try {
      await createAtendimentoMovimento(token, ticketAction.chamadoId, description, ticketFiles);
      await refreshDetail(detail.motorista.id);
      setTicketFiles([]);
      setTicketAction(null);
    } catch (error) {
      setLoading(error instanceof Error ? error.message : "Falha ao registrar movimentação.");
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
            Localize o motorista por nome ou CPF, acompanhe o histórico completo e resolva os
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
                    {result.base || result.company || "Sem base"} - {result.status}
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
          <section className="panel crm-card crm-card--detail">
            <div className="panel__header panel__header--split">
              <div>
                <h3>Dados do Motorista</h3>
                <p>Informacoes cadastrais carregadas diretamente do banco de dados.</p>
              </div>
              <div className="crm-card__header-actions">
                <span className="status-pill status-pill--active">{detail.motorista.statusCadastro}</span>
                {isAdmin ? (
                  <button className="ghost-button ghost-button--small" type="button" onClick={handleOpenMotoristaEdit}>
                    Editar cadastro
                    <PencilSimple size={16} />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="crm-detail-tabs" role="tablist" aria-label="Detalhes do motorista">
              {detailTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={activeDetailTab === tab.key}
                  className={`crm-detail-tab ${activeDetailTab === tab.key ? "crm-detail-tab--active" : ""}`}
                  onClick={() => setActiveDetailTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="crm-detail-content">
              {activeDetailTab === 'dados' ? (
                <div className="crm-driver">
                  <div className="crm-driver__hero">
                    <div>
                      <p className="eyebrow">Motorista selecionado</p>
                      <h4>{detail.motorista.nome}</h4>
                      <p>{detail.motorista.cpf}</p>
                    </div>
                    <div className="crm-driver__meta">
                      <span>{selectedMotoristaBase}</span>
                      <span>{detail.motorista.estado || '--'}</span>
                      <span>{detail.motorista.empresaVinculada || 'Sem empresa vinculada'}</span>
                    </div>
                  </div>

                  <div className="crm-driver__grid">
                    <div><strong>CPF</strong><span>{detail.motorista.cpf}</span></div>
                    <div><strong>RG</strong><span>{detail.motorista.rg || 'Não informado'}</span></div>
                    <div><strong>Nascimento</strong><span>{detail.motorista.dataNascimento ? new Date(detail.motorista.dataNascimento).toLocaleDateString('pt-BR') : 'Não informado'}</span></div>
                    <div><strong>Telefone</strong><span>{detail.motorista.telefone || 'Não informado'}</span></div>
                    <div><strong>WhatsApp</strong><span>{detail.motorista.whatsapp || 'Não informado'}</span></div>
                    <div><strong>E-mail</strong><span>{detail.motorista.email || 'Não informado'}</span></div>
                    <div><strong>Endereço</strong><span>{detail.motorista.endereco || 'Não informado'}</span></div>
                    <div><strong>Base</strong><span>{selectedMotoristaBase}</span></div>
                    <div><strong>Favorecido</strong><span>{detail.motorista.nomeFavorecido || 'Não informado'}</span></div>
                    <div><strong>CPF/CNPJ favorecido</strong><span>{detail.motorista.cpfFavorecido || detail.motorista.cnpjFavorecido || 'Não informado'}</span></div>
                    <div><strong>CEP</strong><span>{detail.motorista.cep || 'Não informado'}</span></div>
                    <div><strong>Criado em</strong><span>{new Date(detail.motorista.dataCriacao).toLocaleString('pt-BR')}</span></div>
                    <div><strong>Atualizado em</strong><span>{new Date(detail.motorista.ultimaAtualizacao).toLocaleString('pt-BR')}</span></div>
                    <div><strong>Observações</strong><span>{detail.motorista.observacoesGerais || 'Sem observações'}</span></div>
                  </div>
                </div>
              ) : null}

              {activeDetailTab === 'classificacoes' ? (
                <div className="crm-tab-panel-content">
                  <div className="crm-tab-panel__header">
                    <div>
                      <strong>Classificacoes do perfil</strong>
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
                </div>
              ) : null}

              {activeDetailTab === 'notas' ? (
                <div className="crm-tab-panel-content">
                  <div className="crm-tab-panel__header">
                    <div>
                      <strong>Notas internas</strong>
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
                            <span>{new Date(note.dataHora).toLocaleString('pt-BR')}</span>
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
                </div>
              ) : null}

              {activeDetailTab === 'pdfs' ? (
                <div className="crm-tab-panel-content">
                  <div className="crm-tab-panel__header">
                    <div>
                      <strong>Histórico de PDFs</strong>
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
                              {pdf.tipo} - {new Date(pdf.dataEnvio).toLocaleString('pt-BR')}
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
                </div>
              ) : null}

              {activeDetailTab === 'pagamentos' ? (
                <div className="crm-tab-panel-content">
                  <div className="crm-tab-panel__header">
                    <div>
                      <strong>Histórico de Pagamentos</strong>
                      <p>Período, PDF, nota fiscal e situação completa do processo.</p>
                    </div>
                  </div>

                  <div className="crm-payment-toolbar">
                    <label className="search-field search-field--compact">
                      <MagnifyingGlass size={18} />
                      <input
                        placeholder="Buscar por período, base, status ou data"
                        value={paymentHistoryQuery}
                        onChange={(event) => setPaymentHistoryQuery(event.target.value)}
                      />
                    </label>
                    <div className="quick-meta">
                      <span className="quick-meta__chip">{filteredPaymentHistory.length} itens</span>
                    </div>
                  </div>

                  <div className="crm-payment-list">
                    {filteredPaymentHistory.length > 0 ? (
                      filteredPaymentHistory.map((item) => (
                        <article className="crm-payment-card" key={item.id}>
                          <div className="crm-payment-card__header">
                            <div>
                              <strong>{item.periodoPagamento || "Período não informado"}</strong>
                              <span>{item.basePagamento || "Base não informada"}</span>
                            </div>
                            <div className="crm-payment-card__badges">
                              <span className={`status-pill ${item.pago ? "status-pill--active" : ""}`}>
                                {item.statusProcesso}
                              </span>
                            </div>
                          </div>

                          <div className="crm-payment-card__grid">
                            <div><strong>Espelho de pagamento enviado</strong><span>{item.pdfEnviadoEm ? new Date(item.pdfEnviadoEm).toLocaleString("pt-BR") : "Não informado"}</span></div>
                            <div><strong>Espelho de pagamento visualizado</strong><span>{item.pdfVisualizadoEm ? new Date(item.pdfVisualizadoEm).toLocaleString("pt-BR") : "Não informado"}</span></div>
                            <div><strong>NF enviada</strong><span>{item.notaFiscalEnviadaEm ? new Date(item.notaFiscalEnviadaEm).toLocaleString("pt-BR") : "Não informado"}</span></div>
                            <div><strong>NF recebida</strong><span>{item.notaFiscalRecebidaEm ? new Date(item.notaFiscalRecebidaEm).toLocaleString("pt-BR") : "Não informado"}</span></div>
                            <div><strong>Data de pagamento</strong><span>{item.dataPagamento ? new Date(item.dataPagamento).toLocaleString("pt-BR") : "Não informado"}</span></div>
                          </div>

                          <div className="crm-payment-card__actions">
                            {item.pdfDownloadUrl ? (
                              <button
                                className="ghost-button ghost-button--small"
                                type="button"
                                onClick={() => window.open(item.pdfDownloadUrl || "", "_blank", "noopener,noreferrer")}
                              >
                                Abrir Espelho
                              </button>
                            ) : null}
                            {item.notaFiscalDownloadUrl ? (
                              <button
                                className="ghost-button ghost-button--small"
                                type="button"
                                onClick={() => window.open(item.notaFiscalDownloadUrl || "", "_blank", "noopener,noreferrer")}
                              >
                                Abrir NF
                              </button>
                            ) : null}
                          </div>
                        </article>
                      ))
                    ) : (
                      <div className="crm-empty">Nenhum histórico de pagamento disponível para este motorista.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {activeDetailTab === 'historico' ? (
                <div className="crm-tab-panel-content">
                  <div className="crm-tab-panel__header">
                    <div>
                      <strong>Histórico de Atendimento</strong>
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
                      <div className="crm-empty">Sem eventos no histórico ainda.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {activeDetailTab === 'chamados' ? (
                <div className="crm-tab-panel-content">
                  <div className="crm-tab-panel__header">
                    <div>
                      <strong>Chamados</strong>
                      <p>Abertos, em andamento e resolvidos.</p>
                    </div>
                    <button className="primary-button primary-button--inline" type="button" onClick={() => setNewTicketOpen(true)}>
                      Novo Chamado
                    </button>
                  </div>

                  <div className="quick-meta">
                    {(['todos', 'aberto', 'em_andamento', 'aguardando_motorista', 'concluido', 'cancelado'] as const).map(
                      (status) => (
                        <button
                          key={status}
                          type="button"
                          className={`quick-meta__chip ${statusFilter === status ? "quick-meta__chip--active" : ""}`}
                          onClick={() => setStatusFilter(status)}
                        >
                          {status === 'todos' ? 'Todos' : formatStatusLabel(status)}
                        </button>
                      )
                    )}
                  </div>

                  <div className="crm-list crm-list--tickets">
                    {filteredChamados.length > 0 ? (
                      filteredChamados.map((ticket) => {
                        const canMutateTicket = !['concluido', 'cancelado', 'resolvido'].includes(ticket.status);

                        return (
                          <article className="crm-ticket" key={ticket.id}>
                            <div className="crm-ticket__header">
                              <div>
                                <strong>{ticket.assunto}</strong>
                                <span>
                                  #{ticket.numero} - {ticket.categoria} - {ticket.responsavel || 'Sem responsável'}
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
                                Abertura: {new Date(ticket.dataAbertura).toLocaleString('pt-BR')} - Atualização:{' '}
                                {new Date(ticket.ultimaAtualizacao).toLocaleString('pt-BR')}
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

                            {canMutateTicket ? (
                              <div className="table-actions">
                                <button
                                  className="ghost-button ghost-button--small"
                                  type="button"
                                  onClick={() =>
                                    setTicketAction({ mode: 'move', chamadoId: ticket.id, subject: ticket.assunto })
                                  }
                                >
                                  Atualizar
                                </button>
                                <button
                                  className="ghost-button ghost-button--small"
                                  type="button"
                                  onClick={() =>
                                    setTicketAction({ mode: 'close', chamadoId: ticket.id, subject: ticket.assunto })
                                  }
                                >
                                  Encerrar
                                </button>
                              </div>
                            ) : null}
                          </article>
                        );
                      })
                    ) : (
                      <div className="crm-empty">Nenhum chamado para o filtro selecionado.</div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
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
                <p>O atendimento será registrado e refletido na timeline do motorista.</p>
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
                <input name="categoria" placeholder="Ex.: Documentação" required />
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
                <span>Responsável</span>
                <input name="responsavelId" defaultValue={currentUser?.id} placeholder={currentUser?.name || "Responsável"} />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Descrição</span>
                <textarea className="crm-textarea" name="descricao" placeholder="Descreva o chamado" required />
              </label>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Anexos</span>
                <label className="upload-chooser">
                  <FileArrowUp size={18} weight="bold" />
                  <span>Escolher arquivos</span>
                  <input
                    type="file"
                    multiple
                    onChange={(event) => setTicketFiles(Array.from(event.target.files || []))}
                  />
                </label>
                <small className="upload-chooser__filename">
                  {ticketFiles.length > 0
                    ? `${ticketFiles.length} arquivo(s) selecionado(s)`
                    : "Nenhum arquivo escolhido"}
                </small>
              </div>
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
                <span>Texto da atualização</span>
                <textarea className="crm-textarea" name="description" placeholder="Atualização do chamado" required />
              </label>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Anexos opcionais</span>
                <label className="upload-chooser">
                  <FileArrowUp size={18} weight="bold" />
                  <span>Escolher arquivos</span>
                  <input type="file" multiple onChange={(event) => setTicketFiles(Array.from(event.target.files || []))} />
                </label>
                <small className="upload-chooser__filename">
                  {ticketFiles.length > 0
                    ? `${ticketFiles.length} arquivo(s) selecionado(s)`
                    : "Nenhum arquivo escolhido"}
                </small>
              </div>
              <div className="admin-form__actions">
                <button className="ghost-button" type="button" onClick={() => setTicketAction(null)}>
                  Cancelar
                </button>
                <button className="primary-button primary-button--inline" type="submit">
                  Registrar movimentação
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

      {motoristaEditOpen && motoristaEditForm ? (
        <div className="modal-overlay" onClick={() => setMotoristaEditOpen(false)}>
          <div
            className="modal-card modal-card--crm modal-card--motorista-edit"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-motorista-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-card__header">
              <div>
                <p className="eyebrow">Dados do motorista</p>
                <h3 id="edit-motorista-title">Editar cadastro</h3>
                <p>Atualize os dados e grave diretamente no banco.</p>
              </div>
              <button className="ghost-button ghost-button--small" type="button" onClick={() => setMotoristaEditOpen(false)}>
                Fechar
              </button>
            </div>

            <form className="admin-form admin-form--modal admin-form--motorista-edit" onSubmit={handleMotoristaEditSubmit}>
              <label className="field field--full">
                <span>Nome</span>
                <input
                  value={motoristaEditForm.nome}
                  onChange={(event) =>
                    setMotoristaEditForm((current) => (current ? { ...current, nome: event.target.value } : current))
                  }
                  required
                />
              </label>
              <label className="field">
                <span>CPF</span>
                <input
                  value={motoristaEditForm.cpf}
                  onChange={(event) =>
                    setMotoristaEditForm((current) => (current ? { ...current, cpf: event.target.value } : current))
                  }
                  required
                />
              </label>
              <label className="field">
                <span>RG</span>
                <input
                  value={motoristaEditForm.rg}
                  onChange={(event) =>
                    setMotoristaEditForm((current) => (current ? { ...current, rg: event.target.value } : current))
                  }
                />
              </label>
              <label className="field">
                <span>Data de nascimento</span>
                <input
                  type="date"
                  value={motoristaEditForm.dataNascimento}
                  onChange={(event) =>
                    setMotoristaEditForm((current) =>
                      current ? { ...current, dataNascimento: event.target.value } : current
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Status do cadastro</span>
                <select
                  className="field__select"
                  value={motoristaEditForm.statusCadastro}
                  onChange={(event) =>
                    setMotoristaEditForm((current) =>
                      current ? { ...current, statusCadastro: event.target.value as "ativo" | "inativo" | "bloqueado" } : current
                    )
                  }
                >
                  <option value="ativo">Ativo</option>
                  <option value="inativo">Inativo</option>
                  <option value="bloqueado">Bloqueado</option>
                </select>
              </label>
              <label className="field">
                <span>Telefone</span>
                <input
                  value={motoristaEditForm.telefone}
                  onChange={(event) =>
                    setMotoristaEditForm((current) =>
                      current ? { ...current, telefone: event.target.value } : current
                    )
                  }
                />
              </label>
              <label className="field">
                <span>WhatsApp</span>
                <input
                  value={motoristaEditForm.whatsapp}
                  onChange={(event) =>
                    setMotoristaEditForm((current) =>
                      current ? { ...current, whatsapp: event.target.value } : current
                    )
                  }
                />
              </label>
              <label className="field">
                <span>E-mail</span>
                <input
                  type="email"
                  value={motoristaEditForm.email}
                  onChange={(event) =>
                    setMotoristaEditForm((current) =>
                      current ? { ...current, email: event.target.value } : current
                    )
                  }
                />
              </label>
              <label className="field">
                <span>CEP</span>
                <input
                  value={motoristaEditForm.cep}
                  onChange={(event) =>
                    setMotoristaEditForm((current) => (current ? { ...current, cep: event.target.value } : current))
                  }
                />
              </label>
              <label className="field field--full">
                <span>Endereço</span>
                <input
                  value={motoristaEditForm.endereco}
                  onChange={(event) =>
                    setMotoristaEditForm((current) =>
                      current ? { ...current, endereco: event.target.value } : current
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Cidade</span>
                <input
                  value={motoristaEditForm.cidade}
                  onChange={(event) =>
                    setMotoristaEditForm((current) => (current ? { ...current, cidade: event.target.value } : current))
                  }
                />
              </label>
              <label className="field">
                <span>Estado</span>
                <input
                  value={motoristaEditForm.estado}
                  onChange={(event) =>
                    setMotoristaEditForm((current) => (current ? { ...current, estado: event.target.value } : current))
                  }
                />
              </label>
              <label className="field field--full">
                <span>Empresa vinculada</span>
                <input
                  value={motoristaEditForm.empresaVinculada}
                  onChange={(event) =>
                    setMotoristaEditForm((current) =>
                      current ? { ...current, empresaVinculada: event.target.value } : current
                    )
                  }
                />
              </label>
              <label className="field field--full">
                <span>Observacoes gerais</span>
                <textarea
                  className="crm-textarea"
                  value={motoristaEditForm.observacoesGerais}
                  onChange={(event) =>
                    setMotoristaEditForm((current) =>
                      current ? { ...current, observacoesGerais: event.target.value } : current
                    )
                  }
                />
              </label>
              <div className="admin-form__actions">
                <button className="ghost-button" type="button" onClick={() => setMotoristaEditOpen(false)}>
                  Cancelar
                </button>
                <button className="primary-button primary-button--inline" type="submit">
                  Salvar alterações
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
                  Salvar alteração
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AccessDeniedScreen({
  route,
  onGoHome
}: {
  route: RouteView;
  onGoHome: () => void;
}) {
  return (
    <div className="screen">
      <section className="screen__intro">
        <div>
          <p className="eyebrow">Acesso restrito</p>
          <h1>Acesso negado</h1>
          <p>
            Você tentou abrir a tela <strong>{getRouteLabel(route)}</strong>, mas seu perfil não possui
            permissão para esse módulo.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="crm-empty-screen">
          <strong>Você não tem permissão para acessar esta página.</strong>
          <p>Use o menu liberado para o seu perfil ou volte para uma tela permitida.</p>
          <button className="primary-button primary-button--inline" type="button" onClick={onGoHome}>
            Voltar para a tela inicial
          </button>
        </div>
      </section>
    </div>
  );
}

export default App;
