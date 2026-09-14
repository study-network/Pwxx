import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { AppErrorBoundary } from "./components/app-error-boundary";

// Mount React immediately
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);

// Register service worker for PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration failure is non-fatal
    });
  });
}
