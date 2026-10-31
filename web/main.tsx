import { createRoot } from "react-dom/client";
import { WorkflowApp } from "./app/workflow-app.js";
import "./theme.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing application root");
}

createRoot(root).render(<WorkflowApp />);
