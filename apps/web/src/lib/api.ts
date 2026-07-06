const API_BASE_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

export type LoginResponse = {
  token: string;
  firstAccess: boolean;
  user: {
    id: string;
    name: string;
    email: string;
    photoUrl?: string | null;
    level: "N1" | "N2" | "N3" | "N4";
    active: boolean;
    blocked: boolean;
    firstAccess: boolean;
    modules: string[];
  };
};

export type SessionResponse = LoginResponse;

export type DashboardSummary = {
  pdfsSent: number;
  pendingPdfs: number;
  processedPdfs: number;
  pendingInvoices: number;
  ticketsWaiting: number;
  closedTickets: number;
  usersCount: number;
};

export type UploadRow = {
  id: string;
  fileName: string;
  storageFileName: string;
  status: string;
  sentAt: string;
  version: number;
  owner: string;
  periodId?: string | null;
  periodName?: string | null;
  baseId?: string | null;
  baseName?: string | null;
  replacedUploadId?: string | null;
};

export type UserSummary = {
  id: string;
  name: string;
  email: string;
  photoUrl?: string | null;
  level: "N1" | "N2" | "N3" | "N4";
  active: boolean;
  blocked: boolean;
  firstAccess: boolean;
  lastLoginAt: string | null;
  modules: string[];
};

type JsonBody = Record<string, unknown>;

export type UserPayload = {
  name: string;
  email: string;
  level: "N1" | "N2" | "N3" | "N4";
  modules: string[];
};

export type ProfileUpdateResponse = {
  message: string;
  user: LoginResponse["user"];
};

export type PaymentFrequency = "semanal" | "quinzenal" | "mensal";

export type PeriodBase = {
  id: string;
  name: string;
  paymentType: PaymentFrequency;
};

export type PaymentBase = PeriodBase & {
  active: boolean;
};

export type PaymentBasePayload = {
  name: string;
  paymentType: PaymentFrequency;
  active: boolean;
};

export type PaymentPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  paymentType: PaymentFrequency;
  status: "disponivel" | "aguardando_aprovacao" | "aprovado";
  bases: PeriodBase[];
  uploadedTotal: number;
  uploadedByBase: Record<string, number>;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
};

export type FinanceiroSummary = {
  activePeriods: number;
  bases: number;
  motoristas: number;
  pdfsSent: number;
  notesReceived: number;
  notesPending: number;
  inAnalysis: number;
  rejected: number;
  inAttendance: number;
  concluded: number;
};

export type FinanceiroBaseCard = {
  id: string;
  name: string;
  paymentType: PaymentFrequency;
  motoristas: number;
  pdfsSent: number;
  pdfsPending: number;
  notesReceived: number;
  notesPending: number;
};

export type FinanceiroMotoristaRow = {
  id: string;
  motoristaId: string;
  nome: string;
  cpf: string;
  base: string;
  periodoPagamento: string;
  pdfEnviadoEm: string | null;
  pdfVisualizadoEm: string | null;
  notaFiscalEnviadaEm: string | null;
  notaFiscalRecebidaEm: string | null;
  status: string;
  statusLabel: string;
  situacaoAtendimento: string;
  ultimaAtualizacao: string | null;
  atendimentoStatus: string;
  statusNotaFiscal: string;
  caminhoArquivo: string | null;
  notaFiscalDownloadUrl: string | null;
};

export type AtendimentoClassificacao = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
};

export type AtendimentoMotoristaSearch = {
  id: string;
  name: string;
  cpf: string;
  status: "ativo" | "inativo" | "bloqueado";
  base: string | null;
  city: string | null;
  state: string | null;
  company: string | null;
  classifiedAs: string[];
  totalPdfs: number;
  totalChamados: number;
};

export type AtendimentoPdf = {
  id: string;
  nomeDocumento: string;
  tipo: string;
  dataEnvio: string;
  dataAprovacao: string | null;
  status: string;
  usuarioResponsavel: string;
  periodName: string | null;
  baseName: string | null;
  downloadUrl: string;
};

export type AtendimentoTimelineItem = {
  id: string;
  type: "upload" | "atendimento" | "chamado" | "nota" | "log";
  title: string;
  subtitle: string;
  status: string;
  iso: string;
  date: string;
  time: string;
};

export type AtendimentoDetail = {
  motorista: {
    id: string;
    nome: string;
    cpf: string;
    rg: string | null;
    dataNascimento: string | null;
    telefone: string | null;
    whatsapp: string | null;
    email: string | null;
    endereco: string | null;
    cidade: string | null;
    estado: string | null;
    cep: string | null;
    statusCadastro: "ativo" | "inativo" | "bloqueado";
    dataCriacao: string;
    ultimaAtualizacao: string;
    empresaVinculada: string | null;
    base: string | null;
    nomeFavorecido: string | null;
    cpfFavorecido: string | null;
    cnpjFavorecido: string | null;
    observacoesGerais: string | null;
    classificacoes: AtendimentoClassificacao[];
  };
  pdfs: AtendimentoPdf[];
  atendimentos: Array<{
    id: string;
    dataHora: string;
    atendente: string;
    canal: string;
    resumo: string;
    observacoes: string | null;
    tempoAtendimento: number | null;
  }>;
  chamados: Array<{
    id: string;
    numero: string;
    assunto: string;
    titulo: string;
    categoria: string;
    prioridade: "baixa" | "media" | "alta" | "critica";
    status: "aberto" | "em_andamento" | "aguardando" | "aguardando_motorista" | "resolvido" | "cancelado" | "concluido";
    responsavel: string | null;
    dataAbertura: string;
    ultimaAtualizacao: string;
    encerradoEm: string | null;
    motivoConclusao: string | null;
    solucaoAplicada: string | null;
    observacoesFinais: string | null;
    historico: Array<{
      id: string;
      dataHora: string;
      usuario: string;
      descricao: string;
    }>;
    anexos: Array<{
      id: string;
      fileName: string;
      storageFileName: string;
      downloadUrl: string;
      createdAt: string;
    }>;
  }>;
  notas: Array<{
    id: string;
    conteudo: string;
    usuario: string;
    dataHora: string;
  }>;
  timeline: AtendimentoTimelineItem[];
  logs: Array<{
    id: string;
    acao: string;
    entidade: string;
    entidadeId: string | null;
    detalhes: unknown;
    usuario: string;
    dataHora: string;
  }>;
};

export type CreatePaymentPeriodPayload = {
  name: string;
  startDate: string;
  endDate: string;
  paymentType: PaymentFrequency;
};

export type UploadProgressState = {
  loaded: number;
  total: number;
  percent: number;
  label: string;
};

async function request<T>(path: string, options?: RequestInit & { body?: JsonBody }) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {})
    },
    body: options?.body ? JSON.stringify(options.body) : undefined
  });

  const payload = (await response.json().catch(() => null)) as { message?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.message || "Falha na comunicacao com a API.");
  }

  return payload as T;
}

async function requestFormData<T>(path: string, options: RequestInit & { body: FormData }) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    body: options.body
  });

  const payload = (await response.json().catch(() => null)) as { message?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.message || "Falha na comunicacao com a API.");
  }

  return payload as T;
}

async function requestUpload<T>(params: {
  path: string;
  token: string;
  body: FormData;
  fields?: Record<string, string>;
  onProgress?: (progress: UploadProgressState) => void;
}) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}${params.path}`);
    xhr.setRequestHeader("Authorization", `Bearer ${params.token}`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !params.onProgress) {
        return;
      }

      params.onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: Math.round((event.loaded / event.total) * 100),
        label: "Enviando arquivos..."
      });
    };

    xhr.onload = () => {
      const payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as T);
        return;
      }

      reject(new Error(payload?.message || "Falha no upload."));
    };

    xhr.onerror = () => {
      reject(new Error("Falha de rede durante o upload."));
    };

    if (params.fields) {
      Object.entries(params.fields).forEach(([key, value]) => {
        params.body.append(key, value);
      });
    }

    xhr.send(params.body);
  });
}

async function requestMultipart<T>(params: {
  path: string;
  token: string;
  body: FormData;
  fields?: Record<string, string>;
  onProgress?: (progress: UploadProgressState) => void;
}) {
  return requestUpload<T>(params);
}

async function requestBlob(path: string, token: string) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message || "Falha na comunicacao com a API.");
  }

  const contentDisposition = response.headers.get("content-disposition") || "";
  const filenameMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);

  return {
    blob: await response.blob(),
    filename: filenameMatch?.[1] || null
  };
}

export function loginRequest(body: { email: string; password: string }) {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body
  });
}

export function fetchSession(token: string) {
  return request<SessionResponse>("/auth/me", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function changeFirstAccessPassword(body: {
  email: string;
  currentPassword: string;
  newPassword: string;
}) {
  return request<{ message: string }>("/auth/first-access/change-password", {
    method: "POST",
    body
  });
}

export function updateCurrentUserProfile(
  token: string,
  body: FormData
) {
  return requestFormData<ProfileUpdateResponse>("/auth/me/profile", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body
  });
}

export function fetchDashboardSummary(token: string) {
  return request<DashboardSummary>("/dashboard/summary", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchUploads(token: string) {
  return request<UploadRow[]>("/uploads", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchPaymentPeriods(token: string) {
  return request<PaymentPeriod[]>("/periods", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchPaymentBases(token: string) {
  return request<PaymentBase[]>("/periods/bases", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function createPaymentBase(token: string, body: PaymentBasePayload) {
  return request<{ message: string }>("/periods/bases", {
    method: "POST",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function updatePaymentBase(token: string, baseId: string, body: PaymentBasePayload) {
  return request<{ message: string }>(`/periods/bases/${baseId}`, {
    method: "PATCH",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function deletePaymentBase(token: string, baseId: string) {
  return request<{ message: string }>(`/periods/bases/${baseId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchFinanceiroSummary(token: string) {
  return request<FinanceiroSummary>("/financeiro/summary", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchFinanceiroBases(token: string, periodId: string) {
  return request<FinanceiroBaseCard[]>(`/financeiro/periods/${periodId}/bases`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchFinanceiroMotoristas(
  token: string,
  periodId: string,
  baseId: string,
  filters?: {
    search?: string;
    cpf?: string;
    status?: string;
  }
) {
  const params = new URLSearchParams();

  if (filters?.search) {
    params.set("search", filters.search);
  }

  if (filters?.cpf) {
    params.set("cpf", filters.cpf);
  }

  if (filters?.status) {
    params.set("status", filters.status);
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";

  return request<FinanceiroMotoristaRow[]>(`/financeiro/periods/${periodId}/bases/${baseId}/motoristas${suffix}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchFinanceiroNotaFiscalContent(token: string, receivedId: string) {
  return requestBlob(`/financeiro/driver-pdfs/${receivedId}/content`, token);
}

export function exportFinanceiroNotasFiscais(token: string, periodId: string, baseId?: string | null) {
  const params = new URLSearchParams();

  if (baseId && baseId !== "all") {
    params.set("baseId", baseId);
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";

  return requestBlob(`/financeiro/periods/${periodId}/export${suffix}`, token);
}

export function createPaymentPeriod(token: string, body: CreatePaymentPeriodPayload) {
  return request<{ message: string }>("/periods", {
    method: "POST",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function updatePaymentPeriod(token: string, periodId: string, body: CreatePaymentPeriodPayload) {
  return request<{ message: string }>(`/periods/${periodId}`, {
    method: "PATCH",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function updatePaymentPeriodStatus(
  token: string,
  periodId: string,
  body: { status: "disponivel" | "aguardando_aprovacao" | "aprovado" }
) {
  return request<{ message: string }>(`/periods/${periodId}/status`, {
    method: "PATCH",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function deletePaymentPeriod(token: string, periodId: string) {
  return request<{ message: string }>(`/periods/${periodId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchUsers(token: string) {
  return request<UserSummary[]>("/users", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function createUser(token: string, body: UserPayload) {
  return request<{ message: string }>("/users", {
    method: "POST",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function updateUser(token: string, userId: string, body: UserPayload) {
  return request<{ message: string }>(`/users/${userId}`, {
    method: "PATCH",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function updateUserStatus(
  token: string,
  userId: string,
  body: { active?: boolean; blocked?: boolean }
) {
  return request<{ message: string }>(`/users/${userId}/status`, {
    method: "PATCH",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function deleteUser(token: string, userId: string) {
  return request<{ message: string }>(`/users/${userId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function resetUserPassword(token: string, userId: string) {
  return request<{ message: string }>(`/users/${userId}/reset-password`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function uploadPdfs(
  token: string,
  files: File[],
  fields?: { periodId?: string; basePaymentId?: string },
  onProgress?: (progress: UploadProgressState) => void
) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  return requestUpload<{ message: string }>({
    path: "/uploads",
    token,
    body: formData,
    fields,
    onProgress
  });
}

export function replaceUpload(
  token: string,
  uploadId: string,
  file: File,
  onProgress?: (progress: UploadProgressState) => void
) {
  const formData = new FormData();
  formData.append("file", file);

  return requestUpload<{ message: string }>({
    path: `/uploads/${uploadId}/replace`,
    token,
    body: formData,
    onProgress
  });
}

export async function downloadUpload(token: string, uploadId: string, fileName: string) {
  const response = await fetch(`${API_BASE_URL}/uploads/${uploadId}/download`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error("Falha ao baixar arquivo.");
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function logoutRequest(token: string) {
  return request<{ message: string }>("/auth/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchUploadHistory(token: string, uploadId: string) {
  return request<UploadRow[]>(`/uploads/${uploadId}/history`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function deleteUpload(token: string, uploadId: string) {
  return request<{ message: string }>(`/uploads/${uploadId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchAtendimentoClassificacoes(token: string) {
  return request<AtendimentoClassificacao[]>("/atendimento/classificacoes", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function searchAtendimentoMotoristas(token: string, q: string) {
  const query = encodeURIComponent(q);
  return request<AtendimentoMotoristaSearch[]>(`/atendimento/motoristas/search?q=${query}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function fetchAtendimentoMotorista(token: string, motoristaId: string) {
  return request<AtendimentoDetail>(`/atendimento/motoristas/${motoristaId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function updateMotoristaClassificacoes(
  token: string,
  motoristaId: string,
  classificacaoIds: string[]
) {
  return request<{ message: string; detail: AtendimentoDetail | null }>(
    `/atendimento/motoristas/${motoristaId}/classificacoes`,
    {
      method: "PATCH",
      body: { classificacaoIds },
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
}

export function createAtendimentoNota(token: string, motoristaId: string, content: string) {
  return request<{ message: string; detail: AtendimentoDetail | null }>(
    `/atendimento/motoristas/${motoristaId}/notas`,
    {
      method: "POST",
      body: { content },
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
}

export function updateAtendimentoNota(
  token: string,
  motoristaId: string,
  notaId: string,
  content: string
) {
  return request<{ message: string; detail: AtendimentoDetail | null }>(
    `/atendimento/motoristas/${motoristaId}/notas/${notaId}`,
    {
      method: "PATCH",
      body: { content },
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
}

export function deleteAtendimentoNota(token: string, motoristaId: string, notaId: string) {
  return request<{ message: string }>(`/atendimento/motoristas/${motoristaId}/notas/${notaId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export function createAtendimentoChamado(
  token: string,
  motoristaId: string,
  body: {
    assunto: string;
    categoria: string;
    prioridade: "baixa" | "media" | "alta" | "critica";
    descricao: string;
    responsavelId: string;
    attachments?: File[];
  }
) {
  const formData = new FormData();
  formData.append("assunto", body.assunto);
  formData.append("categoria", body.categoria);
  formData.append("prioridade", body.prioridade);
  formData.append("descricao", body.descricao);
  formData.append("responsavelId", body.responsavelId);

  body.attachments?.forEach((file) => formData.append("attachments", file));

  return requestMultipart<{ message: string; detail: AtendimentoDetail | null }>({
    path: `/atendimento/motoristas/${motoristaId}/chamados`,
    token,
    body: formData
  });
}

export function createAtendimentoMovimento(
  token: string,
  chamadoId: string,
  description: string,
  attachments?: File[]
) {
  const formData = new FormData();
  formData.append("description", description);
  attachments?.forEach((file) => formData.append("attachments", file));

  return requestMultipart<{ message: string }>({
    path: `/atendimento/chamados/${chamadoId}/movimentos`,
    token,
    body: formData
  });
}

export function closeAtendimentoChamado(
  token: string,
  chamadoId: string,
  body: {
    motivoConclusao: string;
    solucaoAplicada: string;
    observacoesFinais: string;
  }
) {
  return request<{ message: string }>(`/atendimento/chamados/${chamadoId}/encerrar`, {
    method: "POST",
    body,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}
