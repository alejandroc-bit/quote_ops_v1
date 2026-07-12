import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { Building2, Gauge, KeyRound, Mail, ScrollText, ServerCog } from "lucide-react";
import { AppShell, type DashboardPage } from "./AppShell";
import { supabase } from "./lib/supabaseAdminClient";
import { ClientProfilePage } from "./pages/clientProfile";
import { ClientsPage } from "./pages/clients";
import { SentinelReportsPage } from "./pages/sentinelReports";
import { SetupPage } from "./pages/setup";
import {
  claimCurrentPortalProfile,
  listTenantInstallations,
  type ControlPlaneInstallationDetail,
  type ControlPlanePortalProfile
} from "./api/controlPlaneApi";

type ControlPlanePageKey = "clients" | "profile" | "sentinel" | "setup";

const controlPlanePages: Array<DashboardPage<ControlPlanePageKey>> = [
  {
    key: "clients",
    label: "Clientes",
    description: "Alta y administración",
    icon: Building2,
    component: ClientsPage
  },
  {
    key: "profile",
    label: "Perfil de cliente",
    description: "Versión, uso y ajustes",
    icon: Gauge,
    component: ClientProfilePage
  },
  {
    key: "sentinel",
    label: "Sentinel",
    description: "Reportes semanales",
    icon: ScrollText,
    component: SentinelReportsPage
  },
  {
    key: "setup",
    label: "Instalación",
    description: "Paquetes del cliente",
    icon: ServerCog,
    component: SetupPage
  }
];

export function ControlPlaneApp() {
  const [activePage, setActivePage] = useState<ControlPlanePageKey>("clients");
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [profile, setProfile] = useState<ControlPlanePortalProfile | null>(null);
  const [tenantInstallations, setTenantInstallations] = useState<
    ControlPlaneInstallationDetail[]
  >([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setSessionChecked(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionChecked(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      setTenantInstallations([]);
      setAccessError(null);
      setAccessLoading(false);
      return;
    }
    let cancelled = false;
    setAccessLoading(true);
    setAccessError(null);
    void claimCurrentPortalProfile()
      .then(async (nextProfile) => {
        const installations =
          nextProfile.role === "vendor_admin"
            ? []
            : nextProfile.tenant_id
              ? await listTenantInstallations(nextProfile.tenant_id)
              : (() => { throw new Error("El perfil tenant no tiene tenant_id."); })();
        if (cancelled) return;
        setProfile(nextProfile);
        setTenantInstallations(installations);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProfile(null);
        setTenantInstallations([]);
        setAccessError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setAccessLoading(false);
      });
    return () => { cancelled = true; };
  }, [session]);

  async function signOut() {
    await supabase?.auth.signOut();
  }

  const pages = useMemo<Array<DashboardPage<ControlPlanePageKey>>>(() => {
    if (profile && profile.role !== "vendor_admin") {
      return [
        {
          key: "profile",
          label: "Perfil de cliente",
          description: "Versión, uso y ajustes",
          icon: Gauge,
          component: () => <ClientProfilePage tenantInstallations={tenantInstallations} />
        },
        {
          key: "sentinel",
          label: "Sentinel",
          description: "Reportes semanales",
          icon: ScrollText,
          component: SentinelReportsPage
        }
      ];
    }
    return controlPlanePages;
  }, [profile, tenantInstallations]);

  useEffect(() => {
    if (!pages.some((page) => page.key === activePage)) setActivePage(pages[0]!.key);
  }, [activePage, pages]);

  const loginOverride = useMemo(() => {
    if (!session) return <LoginPage checking={!sessionChecked} />;
    if (accessLoading || !profile && !accessError) {
      return <AccessState title="Verificando acceso" body="Cargando rol y tenant desde Supabase…" />;
    }
    if (accessError) {
      return <AccessState title="Acceso no disponible" body={accessError} />;
    }
    return undefined;
  }, [accessError, accessLoading, profile, session, sessionChecked]);

  return (
    <>
      {session ? (
        <div className="admin-token-bar">
          <span>Sesión iniciada como {session.user.email}</span>
          <button className="button button-secondary" onClick={signOut} type="button">
            Cerrar sesión
          </button>
        </div>
      ) : null}
      <AppShell
        activePage={activePage}
        ariaLabel="Plano de control de Inducta"
        contentOverride={loginOverride}
        defaultPage={pages[0]!}
        headerTitle="Inducta Control Plane"
        navDisabled={!session || !profile}
        pages={pages}
        productKicker="Producto central"
        runtimeItems={["Clientes autorizados", "Paquetes de instalación", "Solo métricas agregadas"]}
        setActivePage={setActivePage}
      />
    </>
  );
}

function AccessState({ title, body }: { title: string; body: string }) {
  return (
    <section className="workspace" aria-live="polite">
      <article className="panel">
        <h2>{title}</h2>
        <p className="muted">{body}</p>
      </article>
    </section>
  );
}

function LoginPage({ checking }: { checking: boolean }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setMessage("La autenticación de Supabase no está configurada (faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).");
      return;
    }
    setSending(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });
    setSending(false);
    if (error) {
      setMessage(error.message);
      setSent(false);
      return;
    }
    setSent(true);
    setMessage(`Enviamos un enlace de acceso a ${email}. Revisa tu correo para continuar.`);
  }

  return (
    <section aria-labelledby="login-heading" className="workspace login-workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Inducta Control Plane</p>
          <h2 id="login-heading">Iniciar sesión</h2>
        </div>
      </div>

      <article className="panel login-panel">
        <div className="panel-title">
          <KeyRound size={18} aria-hidden />
          <h3>Acceso de administración</h3>
        </div>
        <p className="muted">
          Ingresa un correo de administración autorizado. Enviaremos un enlace de acceso de un
          solo uso; no necesitas contraseña.
        </p>

        <form onSubmit={sendMagicLink}>
          <label htmlFor="login-email">Correo de administración</label>
          <input
            disabled={checking}
            id="login-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="tu@empresa.com"
            required
            type="email"
            value={email}
          />
          <button
            className="button button-primary"
            disabled={sending || checking}
            type="submit"
          >
            <Mail size={16} aria-hidden />
            {sending ? "Enviando…" : "Enviar enlace mágico"}
          </button>
        </form>

        {message ? (
          <p className={sent ? "login-message login-message-success" : "login-message login-message-error"}>
            {message}
          </p>
        ) : null}
      </article>
    </section>
  );
}
