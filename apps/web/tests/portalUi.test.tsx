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
    version: "1.0.0",
    settings: { pricing_model: "profitability", pdf_template: { title: "Cotización NMX" } },
    last_heartbeat_at: "2026-07-10T00:00:00Z"
  })),
  getLatestRelease: vi.fn(async () => ({ version: "v1.1.0", notes: null, published_at: null })),
  listInstallationUsage: vi.fn(async () => [
    { day: "2026-07-09", quotes: 4, routes: 3 },
    { day: "2026-07-10", quotes: 7, routes: 5 }
  ]),
  updateInstallationSettings: vi.fn(async () => null),
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
  });

  it("validates the PDF template JSON", () => {
    expect(parsePdfTemplate("")).toEqual({ ok: true, value: undefined });
    expect(parsePdfTemplate('{"title":"x"}')).toEqual({ ok: true, value: { title: "x" } });
    expect(parsePdfTemplate("not json").ok).toBe(false);
    expect(parsePdfTemplate("[1,2]").ok).toBe(false);
  });
});

describe("ClientProfilePage", () => {
  it("shows version, update banner, usage and saves settings", async () => {
    render(<ClientProfilePage />);

    expect(await screen.findByText(/Actualización disponible v1\.1\.0/i)).toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText("2026-07-10")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();

    // settings hydrated from installation
    const rentabilidad = screen.getByLabelText(/Rentabilidad RB/i) as HTMLInputElement;
    await waitFor(() => expect(rentabilidad.checked).toBe(true));

    fireEvent.click(screen.getByLabelText(/Margen fijo/i));
    fireEvent.change(screen.getByLabelText(/Plantilla PDF/i), {
      target: { value: '{"title":"Nueva"}' }
    });
    fireEvent.click(screen.getByRole("button", { name: /Guardar configuración/i }));

    await waitFor(() =>
      expect(vi.mocked(controlPlaneApi.updateInstallationSettings)).toHaveBeenCalledWith(
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
    expect(vi.mocked(controlPlaneApi.updateInstallationSettings)).not.toHaveBeenCalled();
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
