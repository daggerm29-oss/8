import { t } from "./i18n";
import { QueryClient, useQuery } from "@tanstack/react-query";

export type EngineEvent = {
  topic: string;
  task?: string;
  ws: string;
  data: Record<string, unknown>;
};
type Notification = { method: string; params: Record<string, unknown> };
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 10_000, refetchOnWindowFocus: false },
  },
});

class EngineRpc {
  private socket: WebSocket | null = null;
  private id = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(notification: Notification) => void>();
  async connect(token: string) {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/`,
    );
    this.socket = socket;
    socket.onmessage = ({ data }) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(t("engine_connection_failed_f5e8cc")));
      socket.onclose = () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(t("engine_disconnected_6eb565")));
        }
        this.pending.clear();
        reject(new Error(t("engine_disconnected_6eb565")));
        for (const listener of this.listeners)
          listener({ method: "disconnected", params: {} });
      };
    });
    await this.call("initialize", {
      clientName: "helix-desktop",
      clientVersion: "0.1.0",
      protocolVersion: "0.1.0",
      token: token || undefined,
      topics: [
        "task.*",
        "agent.**",
        "checkpoint.*",
        "tool.*",
        "verify.*",
        "approval.*",
        "workspace.*",
        "ledger.*",
        "preview.*",
        "mcp.*",
      ],
    });
  }
  call<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error(t("engine_is_not_connected_e96948")));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t("_0_timed_out_3f797f", [method])));
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  subscribe(listener: (notification: Notification) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
export const rpc = new EngineRpc();
rpc.subscribe(({ method, params }) => {
  if (method !== 'event' || params.topic !== 'agent.step.activity') return;
  const activity = params.data as import('@helix/protocol').TaskActivity;
  queryClient.setQueryData(['task.activity', { task: activity.task }], activity);
});
export function useRpc<T>(method: string, params: object = {}, enabled = true) {
  return useQuery({
    queryKey: [method, params],
    queryFn: () => rpc.call<T>(method, params),
    enabled,
  });
}
