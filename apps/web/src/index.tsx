import React from "react";
import { createRoot } from "react-dom/client";
import { ClientPortalApp } from "./ClientPortalApp";
import { ControlPlaneApp } from "./ControlPlaneApp";
import "./styles.css";

export const ClientDashboardApp = ClientPortalApp;

function QuoteOpsWebApp() {
  return import.meta.env.VITE_QUOTEOPS_APP === "control-plane" ? (
    <ControlPlaneApp />
  ) : (
    <ClientPortalApp />
  );
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <QuoteOpsWebApp />
    </React.StrictMode>
  );
}
