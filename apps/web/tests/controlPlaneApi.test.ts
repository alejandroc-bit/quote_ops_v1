import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, getSession } = vi.hoisted(() => ({ from: vi.fn(), getSession: vi.fn() }));

vi.mock("../src/lib/supabaseAdminClient", () => ({
  supabase: { from, auth: { getSession } }
}));

import {
  claimCurrentPortalProfile,
  getCurrentPortalProfile,
  getInstallation,
  getLatestRelease,
  listCredentialStatuses,
  listInstallationUsage,
  listSentinelReports,
  listTenantInstallations,
  updateSettings
} from "../src/api/controlPlaneApi";

beforeEach(() => {
  from.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "portal-session" } } });
});

describe("control-plane tenant data API", () => {
  it("claims the current profile through the service-side endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        profile: { user_id: "user-1", tenant_id: "tenant-1", role: "owner" }
      }), { status: 200, headers: { "content-type": "application/json" } })
    );

    await expect(claimCurrentPortalProfile()).resolves.toMatchObject({ role: "owner" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/portal\/profile\/claim$/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer portal-session" })
      })
    );
    fetchMock.mockRestore();
  });
  it("loads the authenticated profile, tenant installations and credential metadata only", async () => {
    const profileSingle = vi.fn(async () => ({
      data: { user_id: "user-1", tenant_id: "tenant-1", role: "owner" },
      error: null
    }));
    const installationOrder = vi.fn(async () => ({
      data: [{ installation_id: "inst-1", tenant_id: "tenant-1", settings: {} }],
      error: null
    }));
    const credentialOrder = vi.fn(async () => ({
      data: [{ kind: "tms", metadata: { status: "configured" }, updated_at: "2026-07-12" }],
      error: null
    }));
    const credentialSelect = vi.fn(() => ({
      eq: vi.fn(() => ({ order: credentialOrder }))
    }));

    from.mockImplementation((table: string) => {
      if (table === "profiles") {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: profileSingle })) })) };
      }
      if (table === "installations") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ order: installationOrder }))
          }))
        };
      }
      if (table === "credentials") return { select: credentialSelect };
      throw new Error(`unexpected table ${table}`);
    });

    await expect(getCurrentPortalProfile("user-1")).resolves.toMatchObject({ role: "owner" });
    await expect(listTenantInstallations("tenant-1")).resolves.toHaveLength(1);
    await expect(listCredentialStatuses("tenant-1")).resolves.toHaveLength(1);
    expect(credentialSelect).toHaveBeenCalledWith("kind, metadata, updated_at");
    expect(credentialSelect.mock.calls.flat().join(" ")).not.toContain("secret_ciphertext");
  });
  it("reads installation and release records through authenticated Supabase RLS", async () => {
    const installationMaybeSingle = vi.fn(async () => ({
      data: {
        installation_id: "inst-1",
        tenant_id: "tenant-1",
        version: "1.0.0",
        settings: {}
      },
      error: null
    }));
    const releaseMaybeSingle = vi.fn(async () => ({
      data: { version: "v1.1.0", notes: "Mejoras", published_at: "2026-07-12" },
      error: null
    }));

    from.mockImplementation((table: string) => {
      if (table === "installations") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: installationMaybeSingle }))
          }))
        };
      }
      if (table === "releases") {
        return {
          select: vi.fn(async () => {
            const result = await releaseMaybeSingle();
            return { data: result.data ? [result.data] : [], error: result.error };
          })
        };
      }
      throw new Error(`unexpected table ${table}`);
    });

    await expect(getInstallation("inst-1")).resolves.toMatchObject({ version: "1.0.0" });
    await expect(getLatestRelease()).resolves.toMatchObject({ version: "v1.1.0" });
    expect(from).toHaveBeenCalledWith("installations");
    expect(from).toHaveBeenCalledWith("releases");
  });

  it("selects the maximum stable release instead of the latest published row", async () => {
    from.mockImplementation((table: string) => {
      if (table !== "releases") throw new Error(`unexpected table ${table}`);
      return {
        select: vi.fn(async () => ({
          data: [
            { version: "v2.0.0", notes: "Maximum", published_at: "2026-07-10" },
            { version: "v1.9.9", notes: "Published later", published_at: "2026-07-12" },
            { version: "v3.0.0-rc.1", notes: "Prerelease", published_at: "2026-07-13" }
          ],
          error: null
        }))
      };
    });

    await expect(getLatestRelease()).resolves.toMatchObject({
      version: "v2.0.0",
      notes: "Maximum"
    });
  });

  it("updates installation settings through the RLS-protected installations table", async () => {
    const single = vi.fn(async () => ({
      data: { installation_id: "inst-1", settings: { pricing_model: "formula" } },
      error: null
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    from.mockReturnValue({ update });

    await updateSettings("inst-1", { pricing_model: "formula" });

    expect(from).toHaveBeenCalledWith("installations");
    expect(update).toHaveBeenCalledWith({ settings: { pricing_model: "formula" } });
    expect(eq).toHaveBeenCalledWith("installation_id", "inst-1");
  });

  it("loads tenant usage and installation-filtered sentinel reports in descending order", async () => {
    const usageRows = [
      { day: "2026-07-12", channel: "email", quotes: 7, routes: 5 }
    ];
    const reportRows = [
      { installation_id: "inst-1", week_start: "2026-07-06", body_md: "Estable", stats: {} }
    ];

    from.mockImplementation((table: string) => {
      if (table === "installations") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: { tenant_id: "tenant-1" }, error: null }))
            }))
          }))
        };
      }
      if (table === "usage_events") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(async () => ({ data: usageRows, error: null }))
            }))
          }))
        };
      }
      if (table === "sentinel_reports") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(async () => ({ data: reportRows, error: null }))
            }))
          }))
        };
      }
      throw new Error(`unexpected table ${table}`);
    });

    await expect(listInstallationUsage("inst-1")).resolves.toEqual(usageRows);
    await expect(listSentinelReports("inst-1")).resolves.toEqual(reportRows);
  });
});
