import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./themes.css";
import { initializeAppearance } from "./appearance";
import { api, native } from "./api";
void initializeAppearance().then(() => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  if (native)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void api("appearanceReady", {}).catch(() => {});
      }),
    );
});
