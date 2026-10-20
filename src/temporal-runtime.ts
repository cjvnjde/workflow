import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, NativeConnection, Runtime } from "@temporalio/worker";
import { startTemporalServer } from "./temporal-server.js";

export type TemporalOptions = {
  address?: string;
  namespace?: string;
  workflowBundlePath?: string;
};

let configured = false;

export async function connectTemporal(project: string, options: TemporalOptions = {}) {
  if (!configured) {
    Runtime.install({ logger: new DefaultLogger("WARN"), shutdownSignals: [] });
    configured = true;
  }
  const namespace = options.namespace ?? "default";
  const server = options.address ? undefined : await startTemporalServer(project, namespace);
  const address = options.address ?? server?.address;
  let connection: Connection | undefined;
  let nativeConnection: NativeConnection | undefined;
  try {
    connection = await Connection.connect({
      address, connectTimeout: "10 seconds",
      channelArgs: { "grpc.initial_reconnect_backoff_ms": 100, "grpc.min_reconnect_backoff_ms": 100, "grpc.max_reconnect_backoff_ms": 1000 },
    });
    nativeConnection = await NativeConnection.connect({ address });
    const client = new Client({ connection, namespace });
    let teardownPromise: Promise<void> | undefined;

    return {
      client,
      nativeConnection,
      address,
      teardown: () => {
        teardownPromise ??= (async () => {
          const results = await Promise.allSettled([
            Promise.resolve().then(() => connection?.close()),
            Promise.resolve().then(() => nativeConnection?.close()),
          ]);
          try { await server?.stop(); }
          finally {
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failures.length) { throw new AggregateError(failures.map((result) => result.reason), "Could not close Temporal connections"); }
          }
        })();
        return teardownPromise;
      },
    };
  } catch (error) {
    await connection?.close();
    await nativeConnection?.close();
    await server?.stop();
    throw new Error(`Could not connect to Temporal at ${address}. Inspect .workflow/temporal/server.log.`, { cause: error });
  }
}
