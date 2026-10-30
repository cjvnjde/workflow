import { createApp } from "vue";
import App from "./App.vue";
import { autosize } from "./shared/autosize.js";
import "./styles.css";
import "./ui-theme.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing application root");
}
createApp(App).directive("autosize", autosize).mount(root);
