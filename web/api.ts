import { WorkflowClient } from "../src/client.js";
export { projectSchema, runListSchema } from "../src/contracts.js";

// A proxy prefix can be supplied when the GUI is hosted separately from the API.
export const client = new WorkflowClient({ baseUrl: import.meta.env.VITE_WORKFLOW_API_URL ?? "" });
export const request = client.request.bind(client);
export const apiUrl = client.url.bind(client);
