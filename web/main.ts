import { createApp } from "vue";
import App from "./App.vue";
import { autosize } from "./autosize.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing application root");
}
createApp(App).directive("autosize", autosize).mount(root);
