import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

export interface FakeHerdrRequest {
  id: string;
  method: string;
  params: unknown;
}

export interface FakeHerdrConnection {
  sendResponse(id: string, result: unknown, chunkAt?: number): void;
  sendError(id: string, code: string, message: string): void;
  startSubscription(id: string): void;
  sendEvent(event: string, data: unknown): void;
  sendRaw(value: string): void;
  disconnect(): void;
}

export type FakeHerdrHandler = (
  request: FakeHerdrRequest,
  connection: FakeHerdrConnection,
) => void | Promise<void>;

export class FakeHerdrServer {
  readonly socketPath: string;
  readonly requests: FakeHerdrRequest[] = [];
  connectionCount = 0;
  readonly #handler: FakeHerdrHandler;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #listening = false;

  constructor(socketPath: string, handler: FakeHerdrHandler) {
    this.socketPath = socketPath;
    this.#handler = handler;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  async start(): Promise<void> {
    await rm(this.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.socketPath, () => {
        this.#server.off("error", reject);
        this.#listening = true;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#listening) {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
      this.#listening = false;
    }
    await rm(this.socketPath, { force: true });
  }

  #accept(socket: Socket): void {
    this.connectionCount += 1;
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as FakeHerdrRequest;
        this.requests.push(request);
        handled = true;
        buffer = "";
        void this.#handler(request, this.#connection(socket));
        return;
      }
    });
  }

  #connection(socket: Socket): FakeHerdrConnection {
    return {
      sendResponse(id, result, chunkAt) {
        const line = `${JSON.stringify({ id, result })}\n`;
        if (chunkAt !== undefined && chunkAt > 0 && chunkAt < line.length) {
          socket.write(line.slice(0, chunkAt));
          setImmediate(() => socket.end(line.slice(chunkAt)));
        } else {
          socket.end(line);
        }
      },
      sendError(id, code, message) {
        socket.end(`${JSON.stringify({ id, error: { code, message } })}\n`);
      },
      startSubscription(id) {
        socket.write(`${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`);
      },
      sendEvent(event, data) {
        socket.write(`${JSON.stringify({ event, data })}\n`);
      },
      sendRaw(value) {
        socket.write(value);
      },
      disconnect() {
        socket.destroy();
      },
    };
  }
}
