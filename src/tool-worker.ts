import vm from "node:vm";

// The worker bounds CPU/lifetime independently of the engine. Host effects cross a JSON-only bridge.
// This is an execution boundary, not an OS sandbox for hostile authored code.
let sandbox: vm.Context;
self.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === "open") {
      sandbox = vm.createContext(
        { __send: (value: string) => self.postMessage(JSON.parse(value)) },
        { codeGeneration: { strings: false, wasm: false } },
      );
      vm.runInContext(
        `
        const frozen = (() => { const module = {exports:{}}; const exports = module.exports;
        ${message.code}
        return module.exports; })();
        const tools = frozen.__tools();
        const pending = new Map(); let sequence = 0;
        const assertJSON = (value, seen = new Set()) => {
          if(value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return;
          if(typeof value !== "object" || seen.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Tool results must contain JSON values, not class instances, cycles or nonfinite numbers");
          seen.add(value);
          for(const item of Array.isArray(value) ? value : Object.values(value)) {
            if(item === undefined && !Array.isArray(value)) continue;
            assertJSON(item, seen);
          }
          seen.delete(value);
        };
        const rpc = (method, args) => new Promise((resolve,reject) => {
          const id = ++sequence; pending.set(id,{resolve,reject});
          __send(JSON.stringify({type:"effect",id,method,args}));
        });
        globalThis.settle = (id, value, error) => {
          const next = pending.get(id); pending.delete(id);
          if(next) error ? next.reject(new Error(error)) : next.resolve(value);
        };
        globalThis.invoke = async (name, version, input, info) => {
          try {
            const tool = tools.find(t=>t.name===name && t.version===version);
            if(!tool) throw new Error("Tool is not in this workflow's frozen module: "+name);
            let summary, details;
            const env = {id:info.environment, readText:path=>rpc("readText",[path]), writeText:(path,text)=>rpc("writeText",[path,text]), exec:(command,settings)=>rpc("exec",[command,settings])};
            const value = await tool.execute(tool.input.parse(input), {
              env, callId:info.callId, idempotencyKey:info.callId, request:info.request,
              summary:text=>{summary=String(text)}, details:value=>{details=value}, progress:text=>rpc("progress",[String(text)]),
            });
            if(pending.size) throw new Error("Await every tool environment operation before returning");
            const data = tool.output.parse(value);
            if(data===undefined) throw new Error("Tool results must be JSON; use null for an empty result");
            assertJSON({data,details});
            __send(JSON.stringify({type:"result",data,summary,details}));
          } catch(error) { __send(JSON.stringify({type:"error",error:String(error?.message??error)})); }
        };
        __send(JSON.stringify({type:"ready",tools:tools.map(t=>({name:t.name,version:t.version,description:t.description,replay:t.replay,timeoutMs:t.timeoutMs,input: t.input.toJSONSchema(),output:t.output.toJSONSchema()}))}));
      `,
        sandbox,
        { timeout: 1000 },
      );
    } else if (message.type === "invoke") {
      vm.runInContext(
        `void invoke(${JSON.stringify(message.name)},${JSON.stringify(message.version)},${JSON.stringify(message.input)},${JSON.stringify(message.info)});`,
        sandbox,
        { timeout: 1000 },
      );
    } else if (message.type === "settle") {
      vm.runInContext(
        `settle(${JSON.stringify(message.id)},${JSON.stringify(message.value ?? null)},${JSON.stringify(message.error ?? null)});`,
        sandbox,
        { timeout: 1000 },
      );
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
