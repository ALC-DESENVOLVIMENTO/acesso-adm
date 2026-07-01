const API_BASE_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

export type LoginResponse = {
  token: string;
  firstAccess: boolean;
  user: {
    id: string;
    name: string;
    email: string;
    level: "N1" | "N2" | "N3" | "N4";
    active: boolean;
    blocked: boolean;
    firstAccess: boolean;
    modules: string[];
  };
};

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
  replacedUploadId?: string | null;
};

export type UserSummary = {
  id: string;
  name: string;
  email: string;
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

    xhr.send(params.body);
  });
}

export function loginRequest(body: { email: string; password: string }) {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body
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
  onProgress?: (progress: UploadProgressState) => void
) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  return requestUpload<{ message: string }>({
    path: "/uploads",
    token,
    body: formData,
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
