// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProfilePage } from "../src/pages/clientProfile";
import { SentinelReportsPage } from "../src/pages/sentinelReports";
import { isUpdateAvailable, parsePdfTemplate } from "../src/lib/portalSettings";
import * as controlPlaneApi from "../src/api/controlPlaneApi";

vi.mock("../src/api/controlPlaneApi", () => ({
  listControlPlaneClients: vi.fn(async () => [
    {
      client_id: "NMX",
      legal_name: "NMX Transporte",
      status: "active",
      created_at: "2026-07-01T00:00:00Z",
      authorized_users: [],
      installation: {
        installation_id: "inst-nmx-1",
        client_id: "NMX",
        license_status: "active",
        onboarding_status: "completed",
        last_heartbeat_at: "2026-07-10T00:00:00Z",
        ai_key_status: "configured"
      },
      counters: { total: 12, validated: 10, rejected: 1, pending: 1, failed: 0 }
    }
  ]),
  getInstallation: vi.fn(async () => ({
    installation_id: "inst-nmx-1",
    tenant_id: "tenant-nmx",
    version: "1.0.0",
    settings: { pricing_model: "profitability", pdf_template: { title: "Cotización NMX" } },
    last_heartbeat_at: "2026-07-10T00:00:00Z"
  })),
  getLatestRelease: vi.fn(async () => ({ version: "v1.1.0", notes: null, published_at: null })),
  listInstallationUsage: vi.fn(async () => [
    { day: "2026-07-09", channel: "whatsapp", quotes: 4, routes: 3 },
    { day: "2026-07-10", channel: "email", quotes: 7, routes: 5 }
  ]),
  listCredentialStatuses: vi.fn(async () => [
    { kind: "tms", metadata: { status: "configured" }, updated_at: "2026-07-10T00:00:00Z" }
  ]),
  updateSettings: vi.fn(async () => null),
  listSentinelReports: vi.fn(async () => [
    {
      installation_id: "inst-nmx-1",
      week_start: "2026-07-06",
      body_md: "# Semana estable\nSin errores relevantes.",
      stats: { runs: 12, errors: 0, interrupts: 2, avg_node_ms: 850 }
    }
  ])
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("portal settings helpers", () => {
  it("compares versions ignoring the v prefix", () => {
    expect(isUpdateAvailable("1.0.0", "v1.1.0")).toBe(true);
    expect(isUpdateAvailable("v1.1.0", "1.1.0")).toBe(false);
    expect(isUpdateAvailable("2.0.0", "v1.9.9")).toBe(false);
    expect(isUpdateAvailable(null, "v1.0.0")).toBe(true);
    expect(isUpdateAvailable("1.0.0", null)).toBe(false);
    expect(isUpdateAvailable("v1.0.0", "v1.1.0-rc.1")).toBe(false);
    expect(isUpdateAvailable("v1.0.0-beta.1", "v1.1.0")).toBe(false);
  });

  it("validates the PDF template JSON", () => {
    expect(parsePdfTemplate("")).toEqual({ ok: true, value: undefined });
    expect(parsePdfTemplate('{"title":"x"}')).toEqual({ ok: true, value: { title: "x" } });
    expect(parsePdfTemplate("not json").ok).toBe(false);
    expect(parsePdfTemplate("[1,2]").ok).toBe(false);
    expect(parsePdfTemplate('{"show_breakdown":"yes"}')).toEqual({
      ok: false,
      error: expect.stringMatching(/show_breakdown.*booleano/i)
    });
    expect(parsePdfTemplate('{"unknown":"x"}')).toEqual({
      ok: false,
      error: expect.stringMatching(/campo no soportado.*unknown/i)
    });
  });
});

describe("ClientProfilePage", () => {
  it("shows version, update banner, usage and saves settings", async () => {
    render(<ClientProfilePage />);

    expect(await screen.findByText(/Actualización disponible v1\.1\.0/i)).toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getAllByText("2026-07-10").length).toBeGreaterThan(0);
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Canal/i })).toBeInTheDocument();
    expect(screen.getByText(/Credenciales conectadas/i)).toBeInTheDocument();
    expect(screen.getByText(/tms/i)).toBeInTheDocument();

    // settings hydrated from installation
    const rentabilidad = screen.getByLabelText(/Rentabilidad RB/i) as HTMLInputElement;
    await waitFor(() => expect(rentabilidad.checked).toBe(true));

    fireEvent.click(screen.getByLabelText(/Margen fijo/i));
    fireEvent.change(screen.getByLabelText(/Plantilla PDF/i), {
      target: { value: '{"title":"Nueva"}' }
    });
    fireEvent.click(screen.getByRole("button", { name: /Guardar configuración/i }));

    await waitFor(() =>
      expect(vi.mocked(controlPlaneApi.updateSettings)).toHaveBeenCalledWith(
        "inst-nmx-1",
        expect.objectContaining({
          pricing_model: "formula",
          pdf_template: { title: "Nueva" }
        })
      )
    );
    expect(await screen.findByText(/Configuración guardada/i)).toBeInTheDocument();
  });

  it("rejects invalid template JSON without calling the API", async () => {
    render(<ClientProfilePage />);
    await screen.findByText(/Actualización disponible/i);

    fireEvent.change(screen.getByLabelText(/Plantilla PDF/i), {
      target: { value: "{oops" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Guardar configuración/i }));

    expect(await screen.findByText(/JSON inválido/i)).toBeInTheDocument();
    expect(vi.mocked(controlPlaneApi.updateSettings)).not.toHaveBeenCalled();
  });
});

describe("SentinelReportsPage", () => {
  it("lists weekly reports with stats and markdown body", async () => {
    render(<SentinelReportsPage />);

    expect(await screen.findByText(/Semana del 2026-07-06/i)).toBeInTheDocument();
    expect(screen.getByText(/12 corridas/i)).toBeInTheDocument();
    expect(screen.getByText(/Semana estable/)).toBeInTheDocument();
  });
});
