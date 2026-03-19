type GatewayErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

export async function requestJson<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    let message = `Gateway request failed with HTTP ${response.status}`;
    try {
      const payload = JSON.parse(text) as GatewayErrorPayload;
      if (payload.error?.message) {
        message = payload.error.message;
      }
    } catch {
      if (text.trim().length > 0) {
        message = text;
      }
    }
    throw new Error(message);
  }

  if (text.trim().length === 0) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
