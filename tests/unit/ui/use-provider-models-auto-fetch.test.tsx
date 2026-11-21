import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => {
  const translate = (key: string) => key;
  return { useTranslations: () => translate };
});

const { useProviderModels } =
  await import("@/app/(dashboard)/dashboard/providers/hooks/useProviderModels");

function createResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

async function renderProviderModels(providerId = "custom-provider") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function TestHook() {
    useProviderModels(providerId);
    return null;
  }

  await act(async () => {
    root.render(<TestHook />);
  });

  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushQueuedSync() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

describe("useProviderModels upstream auto-fetch", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not synchronize upstream models when autoFetchModels is omitted", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.startsWith("/api/v1/providers/")) {
        return createResponse({ data: [] });
      }
      if (input === "/api/providers") {
        return createResponse({
          connections: [{ id: "connection-1", provider: "custom-provider", isActive: true }],
        });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const mounted = await renderProviderModels();
    try {
      await flushQueuedSync();
    } finally {
      mounted.unmount();
    }

    expect(fetchMock).toHaveBeenCalledWith("/api/providers");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/providers/connection-1/sync-models?mode=sync",
      expect.anything()
    );
  });

  it("synchronizes upstream models only when autoFetchModels is explicitly true", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.startsWith("/api/v1/providers/")) {
        return createResponse({ data: [] });
      }
      if (input === "/api/providers") {
        return createResponse({
          connections: [
            {
              id: "connection-1",
              provider: "custom-provider",
              isActive: true,
              providerSpecificData: { autoFetchModels: true },
            },
          ],
        });
      }
      if (input === "/api/providers/connection-1/sync-models?mode=sync") {
        return createResponse({});
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const mounted = await renderProviderModels();
    try {
      await flushQueuedSync();
    } finally {
      mounted.unmount();
    }

    expect(fetchMock).toHaveBeenCalledWith("/api/providers/connection-1/sync-models?mode=sync", {
      method: "POST",
    });
  });
});
