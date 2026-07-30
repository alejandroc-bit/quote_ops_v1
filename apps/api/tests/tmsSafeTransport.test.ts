import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { HttpTmsAdapter } from "@quoteops/connectors";
import {
  createPinnedTmsTransport,
  executePinnedTmsNodeRequest,
  type PinnedTmsRequest
} from "../src/onboard/tmsSafeTransport.js";

describe("pinned TMS transport", () => {
  it("dials the pinned IP while preserving the original HTTP Host", async () => {
    let observedHost = "";
    const server = createServer((request, response) => {
      observedHost = request.headers.host ?? "";
      response.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test_server_address_unavailable");
    }
    try {
      const response = await executePinnedTmsNodeRequest({
        url: new URL(
          `http://does-not-resolve.invalid:${address.port}/health`
        ),
        init: { method: "GET" },
        pinnedAddresses: ["127.0.0.1"],
        signal: new AbortController().signal
      });
      expect(await response.text()).toBe("ok");
      expect(observedHost).toBe(
        `does-not-resolve.invalid:${address.port}`
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("re-resolves a same-origin redirect and never sends Authorization after public-to-private rebinding", async () => {
    const authorizationByDial: Array<string | null> = [];
    const pinnedAddressesByDial: string[][] = [];
    const resolveHostname = vi
      .fn()
      .mockResolvedValueOnce(["8.8.8.8"])
      .mockResolvedValueOnce(["127.0.0.1"]);
    const request = vi.fn(async (input: PinnedTmsRequest) => {
      pinnedAddressesByDial.push([...input.pinnedAddresses]);
      authorizationByDial.push(
        new Headers(input.init.headers).get("authorization")
      );
      return new Response(null, {
        status: 302,
        headers: {
          location: "/quoteops/v1/units"
        }
      });
    });
    const transport = createPinnedTmsTransport({
      baseUrlOrigin: "https://tms.client.example",
      resolveHostname,
      request,
      timeoutMs: 100
    });

    await expect(
      transport.fetch(
        new URL("https://tms.client.example/quoteops/v1/health"),
        { headers: { authorization: "Bearer must-never-leak" } }
      )
    ).rejects.toMatchObject({ code: "base_url_unsafe" });

    expect(resolveHostname).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
    expect(pinnedAddressesByDial).toEqual([["8.8.8.8"]]);
    expect(authorizationByDial).toEqual(["Bearer must-never-leak"]);
  });

  it("uses one absolute deadline across slow headers and a stalled body and aborts the adapter transport", async () => {
    let bodyCancelled = false;
    let transportObservedAbort = false;
    const request = vi.fn(
      async (input: PinnedTmsRequest): Promise<Response> => {
        input.signal.addEventListener(
          "abort",
          () => {
            transportObservedAbort = true;
          },
          { once: true }
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('[{"unit_id":"unit-1"')
              );
            },
            cancel() {
              bodyCancelled = true;
            }
          }),
          { status: 200 }
        );
      }
    );
    const transport = createPinnedTmsTransport({
      baseUrlOrigin: "https://tms.client.example",
      resolveHostname: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return ["8.8.8.8"];
      },
      request,
      timeoutMs: 40
    });
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.client.example",
      endpoints: { getUnits: "/quoteops/v1/units" },
      fetch: transport.fetch,
      timeoutMs: 1_000
    });
    const started = performance.now();

    await expect(adapter.getUnits()).rejects.toMatchObject({
      code: "request_timeout"
    });

    expect(performance.now() - started).toBeLessThan(100);
    expect(transportObservedAbort).toBe(true);
    expect(bodyCancelled).toBe(true);
  });
});
