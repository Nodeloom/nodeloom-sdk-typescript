import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient, ApiError } from "../src/api.js";

describe("ApiClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("strips trailing slash from endpoint", () => {
      const client = new ApiClient("sdk_test", "https://example.com/");
      // Access private field for testing
      expect((client as any).endpoint).toBe("https://example.com");
    });

    it("strips multiple trailing slashes", () => {
      // The non-regex implementation must still collapse ///// at the end.
      const client = new ApiClient("sdk_test", "https://example.com/////");
      expect((client as any).endpoint).toBe("https://example.com");
    });

    it("leaves interior slashes alone", () => {
      const client = new ApiClient("sdk_test", "https://example.com/api/v2/");
      expect((client as any).endpoint).toBe("https://example.com/api/v2");
    });

    it("uses default endpoint", () => {
      const client = new ApiClient("sdk_test");
      expect((client as any).endpoint).toBe("https://api.nodeloom.io");
    });
  });

  describe("request", () => {
    it("sends GET request with auth header", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ id: "wf-1" }]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = new ApiClient("sdk_mykey");
      const result = await client.request("/api/workflows", {
        params: { teamId: "t1" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.nodeloom.io/api/workflows?teamId=t1",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer sdk_mykey",
          }),
        }),
      );
      expect(result).toEqual([{ id: "wf-1" }]);
    });

    it("sends POST request with body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "ex-1" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = new ApiClient("sdk_test");
      await client.request("/api/workflows/wf-1/execute", {
        method: "POST",
        body: { input: "hello" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ input: "hello" }),
        }),
      );
    });

    it("returns undefined for 204 responses", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      }));

      const client = new ApiClient("sdk_test");
      const result = await client.request("/api/some/resource", { method: "DELETE" });
      expect(result).toBeUndefined();
    });

    it("throws ApiError on non-2xx response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: () => Promise.resolve({ error: "Access denied" }),
      }));

      const client = new ApiClient("sdk_test");
      await expect(client.request("/api/workflows")).rejects.toThrow(ApiError);

      try {
        await client.request("/api/workflows");
      } catch (e) {
        expect((e as ApiError).statusCode).toBe(403);
        expect((e as ApiError).message).toContain("Access denied");
      }
    });

    it("handles non-JSON error responses", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new Error("not json")),
      }));

      const client = new ApiClient("sdk_test");
      await expect(client.request("/api/workflows")).rejects.toThrow(ApiError);
    });
  });

  describe("convenience methods", () => {
    let client: ApiClient;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });
      vi.stubGlobal("fetch", mockFetch);
      client = new ApiClient("sdk_test");
    });

    it("listWorkflows sends correct request", async () => {
      await client.listWorkflows("team-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.nodeloom.io/api/workflows?teamId=team-1",
        expect.any(Object),
      );
    });

    it("getWorkflow sends correct request", async () => {
      await client.getWorkflow("wf-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.nodeloom.io/api/workflows/wf-1",
        expect.any(Object),
      );
    });

    it("executeWorkflow sends POST with body", async () => {
      await client.executeWorkflow("wf-1", { query: "test" });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.nodeloom.io/api/workflows/wf-1/execute",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("getExecution sends correct request", async () => {
      await client.getExecution("ex-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.nodeloom.io/api/executions/ex-1",
        expect.any(Object),
      );
    });

    it("listCredentials sends correct request", async () => {
      await client.listCredentials("team-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.nodeloom.io/api/credentials?teamId=team-1",
        expect.any(Object),
      );
    });
  });
});

describe("NodeLoomClient.api", () => {
  it("returns an ApiClient instance", async () => {
    const { NodeLoomClient } = await import("../src/client.js");
    const client = new NodeLoomClient({ apiKey: "sdk_test", disabled: true });
    expect(client.api).toBeInstanceOf(ApiClient);
  });

  it("caches the ApiClient instance", async () => {
    const { NodeLoomClient } = await import("../src/client.js");
    const client = new NodeLoomClient({ apiKey: "sdk_test", disabled: true });
    expect(client.api).toBe(client.api);
  });
});
