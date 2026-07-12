// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientPortalApp } from "../src/ClientPortalApp";
import { ControlPlaneApp } from "../src/ControlPlaneApp";
import { supabase } from "../src/lib/supabaseAdminClient";
import * as controlPlaneApi from "../src/api/controlPlaneApi";
import { ApprovalsPage } from "../src/pages/approvals";
import { ClientsPage } from "../src/pages/clients";
import { HealthPage } from "../src/pages/health";
import { InboxPage } from "../src/pages/inbox";
import { KnowledgePage } from "../src/pages/knowledge";
import { RfqExecutionTimeline } from "../src/pages/rfqExecutionTimeline";
import { RfqsPage } from "../src/pages/rfqs";
import { SetupPage } from "../src/pages/setup";

function expectVisibleText(pattern: RegExp) {
  expect(screen.getAllByText(pattern).length).toBeGreaterThan(0);
}

vi.mock("../src/lib/supabaseAdminClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithOtp: async () => ({ error: null }),
      signOut: async () => ({ error: null })
    }
  }
}));

beforeEach(() => {
  // default every test to a signed-out session; tests that need an
  // authenticated admin override this after the render call
  vi.mocked(supabase!.auth.getSession).mockResolvedValue({
    data: { session: null }
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Separated product shells", () => {
  it("shows a sign-in gate for the Inducta control plane when signed out", async () => {
    render(<ControlPlaneApp />);

    expect(await screen.findByRole("heading", { name: /Iniciar sesión/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Correo de administración/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Enviar enlace mágico/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Authorized clients/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clientes/i })).toBeDisabled();
  });

  it("opens the Inducta control plane's client list once signed in", async () => {
    mockControlPlaneApi();
    vi.spyOn(controlPlaneApi, "claimCurrentPortalProfile").mockResolvedValue({
      user_id: "vendor-1",
      tenant_id: null,
      role: "vendor_admin"
    });
    vi.mocked(supabase!.auth.getSession).mockResolvedValue({
      data: { session: { user: { id: "vendor-1", email: "ops@inducta.example" } } }
    } as never);
    render(<ControlPlaneApp />);

    expect(await screen.findByText(/Sesión iniciada como ops@inducta.example/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Authorized clients/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: /Plano de control de Inducta/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Inducta Control Plane/i })).toBeInTheDocument();
    expect(await screen.findByText(/Autolineas NuevoMex/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clientes/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create client/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Inbox/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /RFQs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aprobaciones/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/hero/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it("routes a tenant member to RLS-backed tenant pages without calling the admin clients API", async () => {
    const listAdminClients = vi.spyOn(controlPlaneApi, "listControlPlaneClients");
    vi.spyOn(controlPlaneApi, "claimCurrentPortalProfile").mockResolvedValue({
      user_id: "tenant-user-1",
      tenant_id: "tenant-1",
      role: "member"
    });
    vi.spyOn(controlPlaneApi, "listTenantInstallations").mockResolvedValue([
      {
        installation_id: "tenant-inst-1",
        tenant_id: "tenant-1",
        version: "v1.0.0",
        settings: { pricing_model: "formula" }
      }
    ]);
    vi.spyOn(controlPlaneApi, "getLatestRelease").mockResolvedValue(null);
    vi.spyOn(controlPlaneApi, "listInstallationUsage").mockResolvedValue([]);
    vi.spyOn(controlPlaneApi, "listCredentialStatuses").mockResolvedValue([]);
    vi.mocked(supabase!.auth.getSession).mockResolvedValue({
      data: { session: { user: { id: "tenant-user-1", email: "user@tenant.example" } } }
    } as never);

    render(<ControlPlaneApp />);

    expect(await screen.findByRole("heading", { name: /Perfil del cliente/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Perfil de cliente/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sentinel/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clientes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Instalación/i })).not.toBeInTheDocument();
    expect(listAdminClients).not.toHaveBeenCalled();
  });

  it("opens the client appliance portal without Inducta multi-client onboarding", async () => {
    mockSetupState();
    render(<ClientPortalApp />);

    expect(await screen.findByRole("heading", { name: /Inbox workspace/i })).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: /Client appliance portal/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /QuoteOps Client Appliance Portal/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inbox/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /RFQs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Knowledge/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Aprobaciones/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clients/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Autolineas NuevoMex/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Knowledge/i }));
    expect(screen.getByRole("heading", { name: /Knowledge staging preview/i })).toBeInTheDocument();
    expect(screen.getAllByText(/client-owned embedding key/i).length).toBeGreaterThan(0);
  });

  it("blocks client operations while setup state is loading", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Promise<Response>(() => {}));
    render(<ClientPortalApp />);

    expect(screen.getByRole("heading", { name: /Checking setup state/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Inbox workspace/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inbox/i })).toBeDisabled();
  });

  it("fails closed and retries when setup state cannot be fetched", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("setup-state unavailable"))
      .mockResolvedValueOnce(jsonResponse(defaultSetupState()));
    render(<ClientPortalApp />);

    expect(await screen.findByRole("heading", { name: /Setup check failed closed/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Inbox workspace/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inbox/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Retry setup check/i }));

    expect(await screen.findByRole("heading", { name: /Inbox workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inbox/i })).not.toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows council-locked local setup steps before processing RFQs", async () => {
    mockSetupState({
      activation: {
        required: true,
        status: "locked",
        client_id: "NMX",
        installation_id: "nmx-prod-001"
      },
      required_steps: [
        "activate_license",
        "configure_secrets",
        "connect_tms",
        "map_tms",
        "connect_knowledge_base",
        "connect_mailbox",
        "connect_sakbe",
        "run_test_rfq"
      ]
    });
    render(<ClientPortalApp />);

    expect(await screen.findByText(/Activate signed license/i)).toBeInTheDocument();
    expect(screen.getByText(/Configure secrets/i)).toBeInTheDocument();
    expect(screen.getByText(/Connect TMS adapter/i)).toBeInTheDocument();
    expect(screen.getByText(/Map TMS data/i)).toBeInTheDocument();
    expect(screen.getByText(/Build local knowledge base/i)).toBeInTheDocument();
    expect(screen.getByText(/Connect agent RFQ mailbox/i)).toBeInTheDocument();
    expect(screen.getByText(/Connect SAKBE route evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/Run test RFQ/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Secret values never go to the cloud/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Inbox/i })).toBeDisabled();
  });
});

describe("ClientsPage", () => {
  it("shows all clients and can start onboarding a new installation", async () => {
    mockControlPlaneApi();
    render(<ClientsPage />);

    expect(screen.getByRole("heading", { name: /Authorized clients/i })).toBeInTheDocument();
    expect(await screen.findByText(/Autolineas NuevoMex/i)).toBeInTheDocument();
    expect(screen.getByText(/Transportes Nory/i)).toBeInTheDocument();
    expect(screen.getByText(/Caruba Logistics/i)).toBeInTheDocument();
    expect(screen.getAllByTitle(/Generate install pack/i).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(/Client id/i), { target: { value: "ACME" } });
    fireEvent.change(screen.getByLabelText(/Legal name/i), { target: { value: "ACME Transport" } });
    fireEvent.change(screen.getByLabelText(/Authorized email/i), {
      target: { value: "owner@acme.example" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Create client/i }));

    expect(await screen.findByText(/ACME Transport/i)).toBeInTheDocument();
    expect(screen.getAllByText(/acme-prod-001/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/owner@acme.example/i)).toBeInTheDocument();
    expect(screen.getByText(/acme-registration-token/i)).toBeInTheDocument();
  });
});

describe("InboxPage", () => {
  it("shows the agent mailbox intake nodes and queues RFQs through the API", async () => {
    const fetchMock = mockQuoteOpsApi();
    render(<InboxPage />);

    expect(screen.getByRole("heading", { name: /Inbox workspace/i })).toBeInTheDocument();
    expect(screen.getAllByText(/MAILBOX_USER/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/WHATSAPP_ACCESS_TOKEN/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Parser agent/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Simulate mailbox RFQ/i }));

    expect(await screen.findByText(/Mailbox RFQ queued/i)).toBeInTheDocument();
    expect((await screen.findAllByText(/RUN-UI-NEW/i)).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/playground/rfqs",
        expect.objectContaining({ method: "POST" })
      );
    });
  });
});

describe("RfqsPage", () => {
  it("shows active RFQs from the appliance API with a live process monitor", async () => {
    mockQuoteOpsApi();
    render(<RfqsPage />);

    expect(
      screen.getByRole("heading", { name: /Playground operations/i })
    ).toBeInTheDocument();
    expectVisibleText(/Live RFQ intake/i);
    expect((await screen.findAllByText(/RFQ-UI-001/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/RUN-UI-001/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$42,800 MXN/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/sakbe/i).length).toBeGreaterThan(0);
    expectVisibleText(/Run monitor/i);
    expectVisibleText(/RFQ execution timeline/i);
    expectVisibleText(/SAKBE route evidence/i);
    expectVisibleText(/Apply TMS canonical mapping/i);
    expectVisibleText(/Retrieve client criteria/i);
    expectVisibleText(/The cloud receives only safe progress summaries/i);
  });

  it("submits a Playground RFQ through the API", async () => {
    const fetchMock = mockQuoteOpsApi();
    render(<RfqsPage />);

    const weight = screen.getByLabelText(/Weight kg/i);
    fireEvent.change(weight, { target: { value: "29000" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit RFQ/i }));

    expect(await screen.findByText(/Workflow queued/i)).toBeInTheDocument();
    expect(await screen.findByText(/RUN-UI-NEW/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/playground/rfqs",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("submits the missing-weight case as review-required", async () => {
    const fetchMock = mockQuoteOpsApi();
    render(<RfqsPage />);

    fireEvent.click(screen.getByRole("button", { name: /Submit missing weight case/i }));

    expect(await screen.findByText(/Workflow queued/i)).toBeInTheDocument();
    await waitFor(() => {
      const playgroundCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/playground/rfqs" &&
          String(init?.body).includes('"weight_kg":null')
      );
      expect(playgroundCall).toBeTruthy();
    });
  });
});

describe("RfqExecutionTimeline", () => {
  it("shows deterministic TMS mapping and local criteria retrieval", () => {
    render(
      <RfqExecutionTimeline
        nodeStatus={{
          intakePlanner: "completed",
          routeEvidence: "completed",
          quoteCore: "completed",
          tmsMapping: "completed",
          tmsHistorical: "completed",
          criteriaRetriever: "running",
          approvalGate: "pending"
        }}
        runId="RUN-1"
      />
    );

    expect(screen.getByText(/Apply TMS canonical mapping/i)).toBeInTheDocument();
    expect(screen.getByText(/Retrieve client criteria/i)).toBeInTheDocument();
    expect(screen.getByText(/The cloud receives only safe progress summaries/i)).toBeInTheDocument();
  });
});

describe("KnowledgePage", () => {
  it("shows local RAG upload and search state without cloud storage claims", () => {
    render(<KnowledgePage />);

    expect(screen.getByRole("heading", { name: /Knowledge staging preview/i })).toBeInTheDocument();
    expect(screen.getByText(/Local appliance knowledge base/i)).toBeInTheDocument();
    expect(screen.getAllByText(/client-owned embedding key/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Stage criteria files/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stage local preview/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Search/i })).toBeInTheDocument();
    expect(screen.getByText(/stages local filenames only/i)).toBeInTheDocument();
    expect(screen.getByText(/not documents or embeddings/i)).toBeInTheDocument();
  });
});

describe("ApprovalsPage", () => {
  it("loads approval envelopes and submits decisions to the API", async () => {
    const fetchMock = mockQuoteOpsApi();
    render(<ApprovalsPage />);

    expect(
      screen.getByRole("heading", { name: /Approval workspace/i })
    ).toBeInTheDocument();
    expect((await screen.findAllByText(/RUN-UI-001/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/RUN-UI-002/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /RFQ-UI-002/i }));
    expect(screen.getByText(/historical_context_insufficient/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /RFQ-UI-001/i }));

    fireEvent.click(screen.getByRole("button", { name: /View evidence/i }));
    expect(screen.getByText(/SAKBE route evidence/i)).toBeInTheDocument();
    expect(screen.getAllByText(/sakbe/i).length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", { name: /View criteria used/i })
    );
    expect(screen.getAllByText(/margin floor/i).length).toBeGreaterThan(0);

    const adjustment = screen.getByLabelText(/Adjusted rate/i);
    fireEvent.change(adjustment, { target: { value: "44500" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply adjustment/i }));
    expect((await screen.findAllByText(/Adjusted by client approver/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$44,500 MXN/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Approve$/i }));
    expect((await screen.findAllByText(/Approved by client approver/i)).length).toBeGreaterThan(0);
    expectVisibleText(/written/i);

    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    expect((await screen.findAllByText(/Rejected for rework/i)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Request review/i }));
    expect((await screen.findAllByText(/Review requested/i)).length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/approvals/RUN-UI-001/decision",
        expect.objectContaining({ method: "POST" })
      );
    });
  });
});

describe("SetupPage", () => {
  it("explains Docker install, secrets, and TMS adapter contract", () => {
    render(<SetupPage />);

    expect(screen.getByRole("heading", { name: /Setup workspace/i })).toBeInTheDocument();
    expect(screen.getAllByText(/api\/install/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/QUOTEOPS_REGISTRATION_TOKEN/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/AI_PROVIDER_API_KEY/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/TMS_API_KEY/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/docker compose/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/writeback_quote/i)).toBeInTheDocument();
    expect(screen.getByText(/Raw RFQs and historical quote rows/i)).toBeInTheDocument();
    expect(screen.queryByText(/approval envelopes/i)).not.toBeInTheDocument();
  });
});

describe("HealthPage", () => {
  it("shows API health and every client dashboard dependency", async () => {
    mockQuoteOpsApi();
    render(<HealthPage />);

    expect(
      screen.getByRole("heading", { name: /Health workspace/i })
    ).toBeInTheDocument();

    expect(await screen.findByText(/quoteops-v2\.0\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/3 workflow runs \/ 1 heartbeats/i)).toBeInTheDocument();

    for (const service of [
      "TMS",
      "SAKBE",
      "Email",
      "Model",
      "Knowledge",
      "Quote-core",
      "Control plane",
      "Backup",
      "License",
      "TMS mapping",
      "Versions"
    ]) {
      expect(screen.getByText(service)).toBeInTheDocument();
    }
  });
});

function mockControlPlaneApi() {
  const clients = [
    controlPlaneClient({
      client_id: "NMX",
      legal_name: "Autolineas NuevoMex",
      authorized_email: "ops@nmx.example",
      installation_id: "nmx-prod-001",
      status: "active",
      license_status: "active",
      onboarding_status: "ready",
      ai_key_status: "configured",
      last_heartbeat_at: "2026-06-25T12:00:00.000Z",
      counters: { total: 18, validated: 14, rejected: 2, pending: 1, failed: 1 }
    }),
    controlPlaneClient({
      client_id: "NORY",
      legal_name: "Transportes Nory",
      authorized_email: "pricing@nory.example",
      installation_id: "nory-prod-001",
      status: "onboarding",
      license_status: "pending",
      onboarding_status: "authorized",
      ai_key_status: "missing"
    }),
    controlPlaneClient({
      client_id: "CARUBA",
      legal_name: "Caruba Logistics",
      authorized_email: "admin@caruba.example",
      installation_id: "caruba-prod-001",
      status: "suspended",
      license_status: "suspended",
      onboarding_status: "blocked",
      ai_key_status: "missing",
      counters: { total: 6, validated: 4, rejected: 1, pending: 0, failed: 1 }
    })
  ];

  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = requestPath(input);
    if (path === "/api/admin/clients" && (!init || init.method === undefined)) {
      return jsonResponse({ items: clients });
    }
    if (path === "/api/admin/clients" && init?.method === "POST") {
      const request = init.body ? JSON.parse(String(init.body)) : {};
      const client = controlPlaneClient({
        client_id: String(request.client_id ?? "ACME"),
        legal_name: String(request.legal_name ?? request.client_id ?? "ACME"),
        authorized_email: String(request.authorized_email ?? "owner@acme.example"),
        installation_id: `${String(request.client_id ?? "ACME").toLowerCase()}-prod-001`,
        status: "onboarding",
        license_status: "pending",
        onboarding_status: "not_started",
        ai_key_status: "missing"
      });
      clients.unshift(client);
      return jsonResponse({ client }, 201);
    }
    const installPackMatch = path.match(/^\/api\/admin\/clients\/([^/]+)\/install-pack$/);
    if (installPackMatch && init?.method === "POST") {
      const clientId = decodeURIComponent(installPackMatch[1] ?? "ACME");
      return jsonResponse({ install_pack: controlPlaneInstallPack(clientId) }, 201);
    }
    const suspendMatch = path.match(/^\/api\/admin\/clients\/([^/]+)\/suspend$/);
    if (suspendMatch && init?.method === "POST") {
      return jsonResponse({ client: clients[0] });
    }
    const reactivateMatch = path.match(/^\/api\/admin\/clients\/([^/]+)\/reactivate$/);
    if (reactivateMatch && init?.method === "POST") {
      return jsonResponse({ client: clients[0] });
    }
    const reissueMatch = path.match(/^\/api\/admin\/clients\/([^/]+)\/reissue-license$/);
    if (reissueMatch && init?.method === "POST") {
      return jsonResponse({ client: clients[0] });
    }

    return jsonResponse({ error: "not_found" }, 404);
  });
}

function controlPlaneClient(input: {
  client_id: string;
  legal_name: string;
  authorized_email: string;
  installation_id: string;
  status: string;
  license_status: string;
  onboarding_status: string;
  ai_key_status: string;
  last_heartbeat_at?: string | null;
  counters?: { total: number; validated: number; rejected: number; pending: number; failed: number };
}) {
  return {
    client_id: input.client_id,
    legal_name: input.legal_name,
    status: input.status,
    created_at: "2026-06-25T12:00:00.000Z",
    authorized_users: [
      {
        email: input.authorized_email,
        role: "owner",
        created_at: "2026-06-25T12:00:00.000Z"
      }
    ],
    installation: {
      installation_id: input.installation_id,
      client_id: input.client_id,
      license_status: input.license_status,
      onboarding_status: input.onboarding_status,
      last_heartbeat_at: input.last_heartbeat_at ?? null,
      ai_key_status: input.ai_key_status
    },
    counters: input.counters ?? {
      total: 0,
      validated: 0,
      rejected: 0,
      pending: 0,
      failed: 0
    }
  };
}

function controlPlaneInstallPack(clientId: string) {
  const normalized = clientId.toLowerCase();
  return {
    client_id: clientId.toUpperCase(),
    installation_id: `${normalized}-prod-001`,
    registration_token: `${normalized}-registration-token`,
    expires_at: "2026-06-25T13:00:00.000Z",
    install_command: [
      "QUOTEOPS_REGISTRATION_TOKEN='<paste-token-here>' bash deploy/appliance/install.sh \\",
      `  --client ${clientId.toUpperCase()} \\`,
      "  --manifest client-manifest.yaml \\",
      "  --connectors connectors \\",
      "  --control-plane-url https://quoteops-control-plane-staging.vercel.app \\",
      '  --registration-token "$QUOTEOPS_REGISTRATION_TOKEN" \\',
      `  --installation-id ${normalized}-prod-001`
    ].join("\n"),
    files: {
      "client-manifest.yaml": `client_id: ${clientId}`,
      "criteria-template.yaml": `client_id: ${clientId}`,
      "tms-adapter-template.yaml": "provider: client_tms"
    }
  };
}

function requestPath(input: RequestInfo | URL): string {
  const raw = String(input);
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return new URL(raw).pathname;
  }
  return raw;
}

function mockQuoteOpsApi() {
  let lastPlaygroundReview = false;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/setup-state") {
      return jsonResponse(defaultSetupState());
    }

    if (url === "/api/rfqs") {
      return jsonResponse({
        items: [
          {
            run_id: "RUN-UI-001",
            client_id: "NMX",
            rfq_id: "RFQ-UI-001",
            status: "APPROVED",
            approval_required: false,
            route_source: "sakbe",
            base_rate_mxn: 42800,
            recommended_rate_mxn: 42800,
            created_at: "2026-06-23T12:00:00.000Z",
            updated_at: "2026-06-23T12:00:00.000Z"
          }
        ]
      });
    }

    if (url === "/api/rfqs/RUN-UI-001" || url === "/api/rfqs/RUN-UI-NEW") {
      return jsonResponse(
        workflowDetail(
          url.endsWith("RUN-UI-NEW") ? "RUN-UI-NEW" : "RUN-UI-001",
          url.endsWith("RUN-UI-NEW") ? lastPlaygroundReview : false
        )
      );
    }

    if (url === "/api/playground/rfqs") {
      const request = init?.body ? JSON.parse(String(init.body)) : {};
      lastPlaygroundReview = request.weight_kg === null;
      return jsonResponse({
        run_id: "RUN-UI-NEW",
        rfq_id: "RFQ-UI-NEW",
        status: "RECEIVED",
        approval_required: false,
        route_source: null,
        base_rate_mxn: null,
        recommended_rate_mxn: null
      }, 202);
    }

    if (url === "/api/approvals") {
      return jsonResponse({
        items: [
          {
            envelope_id: "appr-RUN-UI-001",
            run_id: "RUN-UI-001",
            client_id: "NMX",
            installation_id: "nmx-local-001",
            rfq_id: "RFQ-UI-001",
            lane: {
              origin: "Monterrey, Nuevo Leon",
              destination: "Ciudad de Mexico, Ciudad de Mexico"
            },
            equipment: "T3S3_53_DRYVAN",
            weight_kg: 29000,
            base_rate_mxn: 42800,
            recommended_rate_mxn: 42800,
            review_reasons: ["margin floor review"],
            evidence_flags: {
              route_source: "sakbe",
              route_resolved: true,
              historical_layer: "route_unit_cost",
              quote_core_status: "REVIEW_REQUIRED"
            },
            decision_status: "pending",
            created_at: "2026-06-23T12:00:00.000Z",
            updated_at: "2026-06-23T12:00:00.000Z"
          },
          {
            envelope_id: "appr-RUN-UI-002",
            run_id: "RUN-UI-002",
            client_id: "NMX",
            installation_id: "nmx-local-001",
            rfq_id: "RFQ-UI-002",
            lane: {
              origin: "Monterrey, Nuevo Leon",
              destination: "Queretaro, Queretaro"
            },
            equipment: "T3S3_53_DRYVAN",
            weight_kg: null,
            base_rate_mxn: 36574,
            recommended_rate_mxn: 36574,
            review_reasons: ["historical_context_insufficient"],
            evidence_flags: {
              route_source: "sakbe",
              route_resolved: true,
              historical_layer: "route_unit_cost",
              quote_core_status: "APPROVED"
            },
            decision_status: "pending",
            created_at: "2026-06-23T12:10:00.000Z",
            updated_at: "2026-06-23T12:10:00.000Z"
          }
        ]
      });
    }

    if (url === "/api/approvals/RUN-UI-001/decision") {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        run_id: "RUN-UI-001",
        approval_decision: {
          action: body.action,
          ...(body.rate_mxn ? { rate_mxn: body.rate_mxn } : {}),
          email_sent: false,
          decided_at: "2026-06-23T12:05:00.000Z"
        },
        writeback_result:
          body.action === "reject" || body.action === "request_review"
            ? null
            : { status: "written", quote_id: "QUOTE-UI-001" }
      });
    }

    if (url === "/api/health") {
      return jsonResponse({
        ok: true,
        product_version: "quoteops-v2.0.0",
        workflow_runs: 3,
        heartbeats: 1
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function workflowDetail(runId: string, approvalRequired = false) {
  return {
    run_id: runId,
    client_id: "NMX",
    raw_rfq: {
      rfq_id: runId === "RUN-UI-NEW" ? "RFQ-UI-NEW" : "RFQ-UI-001",
      source: "manual",
      parsed: {
        lanes: [
          {
            lane_id: "RFQ-UI-001-L01",
            origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
            destination: { city: "Ciudad de Mexico", state: "Ciudad de Mexico", country: "MX" },
            equipment_request: "caja seca 53",
            vehicle_profile_id: "T3S3_53_DRYVAN",
            cargo: { weight_kg: 29000, commodity: "carga general", value_mxn: 400000 },
            commercial: { business_unit_id: "DV_53_FT", customer_id: "NMX-PLAYGROUND" }
          }
        ]
      }
    },
    route_evidence: {
      status: "resolved",
      source: "sakbe",
      km_loaded: 905.45,
      estimated_minutes: 565.82,
      tolls_mxn: 3859
    },
    historical_context: { selected_layer: "route_unit_cost", median_rate_mxn: 36574.12 },
    base_quote: {
      status: "APPROVED",
      base_rate_mxn: 42800,
      route_source: "sakbe",
      review_reasons: []
    },
    recommendation: {
      status: "completed",
      recommended_rate_mxn: 42800,
      reason: "Guide mode preserves quote-core rate."
    },
    approval_state: {
      required: approvalRequired,
      reasons: approvalRequired ? ["historical_context_insufficient"] : []
    },
    writeback_result: approvalRequired ? null : { status: "written", quote_id: "QUOTE-UI-001" },
    node_status: {
      intakePlanner: "completed",
      normalizer: "completed",
      profileResolver: "completed",
      routeEvidence: "completed",
      quoteCore: "completed",
      tmsMapping: "completed",
      tmsHistorical: "completed",
      criteriaRetriever: "completed",
      pricingRecommendation: "completed",
      approvalGate: approvalRequired ? "review_required" : "completed",
      writeback: approvalRequired ? "review_required" : "completed"
    },
    runtime_review_reasons: []
  };
}

function mockSetupState(setup = defaultSetupState()) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/setup-state") {
      return jsonResponse(setup);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function defaultSetupState() {
  return {
    activation: {
      required: false,
      status: "unlocked",
      client_id: "NMX",
      installation_id: "nmx-local-001"
    },
    required_steps: []
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
