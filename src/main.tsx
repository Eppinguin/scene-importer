import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import OBR from "@owlbear-rodeo/sdk";
import { setupContextMenu } from "./contextMenu";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// const appElement = document.querySelector("#app");
// if (appElement) {
//     appElement.innerHTML = `
//     <div>
//       <h1>Initiative Tracker</h1>
//     </div>
//   `;
// } else {
//     console.error("App element not found");
// }

OBR.onReady(() => {
  const isContextMenuMode =
    new URLSearchParams(window.location.search).get("context") === "true";
  if (!isContextMenuMode) {
    setupContextMenu();
  }
});
