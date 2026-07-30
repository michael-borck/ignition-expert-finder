import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import Admin from "./pages/Admin.tsx";
import App from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname.startsWith("/admin") ? <Admin /> : <App />}
  </StrictMode>,
);
