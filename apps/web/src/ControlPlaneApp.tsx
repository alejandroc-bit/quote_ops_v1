import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { Building2, KeyRound, Mail, ServerCog } from "lucide-react";
import { AppShell, type DashboardPage } from "./AppShell";
import { supabase } from "./lib/supabaseAdminClient";
import { ClientsPage } from "./pages/clients";
import { SetupPage } from "./pages/setup";

type ControlPlanePageKey = "clients" | "setup";

const controlPlanePages: Array<DashboardPage<ControlPlanePageKey>> = [
  {
    key: "clients",
    label: "Clients",
    description: "Onboarding",
    icon: Building2,
    component: ClientsPage
  },
  {
    key: "setup",
    label: "Install",
    description: "Client packs",
    icon: ServerCog,
    component: SetupPage
  }
];

export function ControlPlaneApp() {
  const [activePage, setActivePage] = useState<ControlPlanePageKey>("clients");
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

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

  async function signOut() {
    await supabase?.auth.signOut();
  }

  const loginOverride = useMemo(() => {
    if (session) return undefined;
    return <LoginPage checking={!sessionChecked} />;
  }, [session, sessionChecked]);

  return (
    <>
      {session ? (
        <div className="admin-token-bar">
          <span>Signed in as {session.user.email}</span>
          <button className="button button-secondary" onClick={signOut} type="button">
            Sign out
          </button>
        </div>
      ) : null}
      <AppShell
        activePage={activePage}
        ariaLabel="Inducta control plane"
        contentOverride={loginOverride}
        defaultPage={controlPlanePages[0]!}
        headerTitle="Inducta Control Plane"
        navDisabled={!session}
        pages={controlPlanePages}
        productKicker="Central product"
        runtimeItems={["Authorized clients", "Install packs", "Aggregate counters only"]}
        setActivePage={setActivePage}
      />
    </>
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
      setMessage("Supabase auth is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing).");
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
    setMessage(`We sent a sign-in link to ${email}. Check your inbox and click it to continue.`);
  }

  return (
    <section aria-labelledby="login-heading" className="workspace login-workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Inducta Control Plane</p>
          <h2 id="login-heading">Sign in</h2>
        </div>
      </div>

      <article className="panel login-panel">
        <div className="panel-title">
          <KeyRound size={18} aria-hidden />
          <h3>Admin sign-in</h3>
        </div>
        <p className="muted">
          Enter an authorized admin email. We&apos;ll send a one-time sign-in link — no password
          to manage.
        </p>

        <form onSubmit={sendMagicLink}>
          <label htmlFor="login-email">Admin email</label>
          <input
            disabled={checking}
            id="login-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
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
            {sending ? "Sending…" : "Send magic link"}
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
