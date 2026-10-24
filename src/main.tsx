import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { logError, logEvent } from "./log";
import "./styles.css";

window.addEventListener("error", (event) => {
  logError("window", event.error ?? event.message, `${event.filename}:${event.lineno}`);
});
window.addEventListener("unhandledrejection", (event) => {
  logError("promise", event.reason);
});
logEvent("app", "webview started", navigator.userAgent);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
