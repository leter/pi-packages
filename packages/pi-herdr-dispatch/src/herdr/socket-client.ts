import { createConnection, type Socket } from "node:net";

export interface HerdrEventEnvelope {
  event: string;
  data: Record<string, unknown>;
}

export class HerdrProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HerdrProtocolError";
  }
}

export class HerdrApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

export class HerdrDisconnectedError extends Error {
  readonly submitted: boolean;

  constructor(message: string, submitted: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "HerdrDisconnectedError";
    this.submitted = submitted;
  }
}

export class HerdrTimeoutError extends Error {
  readonly submitted = true;

  constructor(message: string) {
    super(message);
    this.name = "HerdrTimeoutError";
  }
}

interface PendingRequest {
  readonly method: string;
  readonly expectedType: string;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export interface HerdrSocketClientOptions {
  requestTimeoutMs?: number;
}

export class HerdrSocketClient {
  readonly #socket: Socket;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #eventListeners = new Set<(event: HerdrEventEnvelope) => void>();
  readonly #disconnectListeners = new Set<(error: Error) => void>();
  #buffer = "";
  #nextRequestId = 1;
  #requestStarted = false;
  #closed = false;

  private constructor(socket: Socket, options: HerdrSocketClientOptions) {
    this.#socket = socket;
    this.#requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs ?? 5_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#receive(chunk));
    socket.on("error", (error) => this.#disconnect(error));
    socket.on("close", () => this.#disconnect());
  }

  static async connect(
    socketPath: string,
    options: HerdrSocketClientOptions = {},
  ): Promise<HerdrSocketClient> {
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      const connected = () => {
        socket.off("error", failed);
        resolve();
      };
      const failed = (error: Error) => {
        socket.off("connect", connected);
        reject(new HerdrDisconnectedError("Could not connect to the Herdr socket", false, { cause: error }));
      };
      socket.once("connect", connected);
      socket.once("error", failed);
    });
    return new HerdrSocketClient(socket, options);
  }

  request(
    method: string,
    params: Record<string, unknown>,
    expectedType: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      return Promise.reject(new HerdrDisconnectedError("Herdr socket is disconnected", false));
    }
    if (this.#requestStarted) {
      return Promise.reject(
        new HerdrProtocolError("Herdr unary and subscription sockets accept exactly one request"),
      );
    }
    this.#requestStarted = true;
    const id = `pi-herdr-${this.#nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HerdrTimeoutError(`Herdr request ${method} timed out`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { method, expectedType, resolve, reject, timeout });
      const line = `${JSON.stringify({ id, method, params })}\n`;
      this.#socket.write(line, (error) => {
        if (error) this.#failRequest(id, new HerdrDisconnectedError("Herdr request write failed", true, { cause: error }));
      });
    });
  }

  onEvent(listener: (event: HerdrEventEnvelope) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#rejectAll(new HerdrDisconnectedError("Herdr socket was closed", true));
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        this.#protocolFailure("Herdr sent malformed JSON", cause);
        return;
      }
      try {
        this.#routeEnvelope(parsed);
      } catch (cause) {
        this.#protocolFailure("Herdr sent an invalid protocol envelope", cause);
        return;
      }
    }
  }

  #routeEnvelope(value: unknown): void {
    const envelope = object(value, "envelope");
    if (typeof envelope.event === "string" && envelope.id === undefined) {
      const event = { event: envelope.event, data: object(envelope.data, "event data") };
      for (const listener of this.#eventListeners) listener(event);
      return;
    }
    if (typeof envelope.id !== "string") throw new HerdrProtocolError("response id must be a string");
    const pending = this.#pending.get(envelope.id);
    if (!pending) {
      const parent = this.#subscriptionProbeParent(envelope.id);
      if (!parent) throw new HerdrProtocolError(`unexpected response id ${envelope.id}`);
      const error = object(envelope.error, "subscription probe error");
      if (envelope.result !== undefined || typeof error.code !== "string" || typeof error.message !== "string") {
        throw new HerdrProtocolError("subscription probe response must contain one valid error");
      }
      this.#complete(parent.id, parent.pending);
      parent.pending.reject(new HerdrApiError(error.code, error.message));
      return;
    }

    const hasResult = envelope.result !== undefined;
    const hasError = envelope.error !== undefined;
    if (hasResult === hasError) throw new HerdrProtocolError("response must contain exactly one of result or error");
    if (hasError) {
      const error = object(envelope.error, "error");
      if (typeof error.code !== "string" || typeof error.message !== "string") {
        throw new HerdrProtocolError("error response must contain string code and message");
      }
      this.#complete(envelope.id, pending);
      pending.reject(new HerdrApiError(error.code, error.message));
      return;
    }
    const result = object(envelope.result, "result");
    this.#complete(envelope.id, pending);
    if (result.type !== pending.expectedType) {
      const error = new HerdrProtocolError(
        `expected Herdr result type ${pending.expectedType}, received ${String(result.type)}`,
      );
      pending.reject(error);
      this.#protocolFailure(error.message, error);
      return;
    }
    pending.resolve(result);
  }

  #protocolFailure(message: string, cause: unknown): void {
    const error = cause instanceof HerdrProtocolError ? cause : new HerdrProtocolError(message, { cause });
    this.#closed = true;
    this.#socket.destroy();
    this.#rejectAll(error);
    this.#notifyDisconnect(error);
  }

  #disconnect(cause?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new HerdrDisconnectedError("Herdr disconnected before replying", this.#pending.size > 0, {
      cause,
    });
    this.#rejectAll(error);
    this.#notifyDisconnect(error);
  }

  #subscriptionProbeParent(responseId: string): { id: string; pending: PendingRequest } | undefined {
    for (const [id, pending] of this.#pending) {
      if (
        pending.method === "events.subscribe" &&
        responseId.startsWith(id) &&
        /^:sub:\d+:probe$/u.test(responseId.slice(id.length))
      ) {
        return { id, pending };
      }
    }
    return undefined;
  }

  #complete(id: string, pending: PendingRequest): void {
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
  }

  #failRequest(id: string, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #notifyDisconnect(error: Error): void {
    for (const listener of this.#disconnectListeners) listener(error);
  }
}

export class HerdrUnaryTransport {
  readonly #socketPath: string;
  readonly #options: HerdrSocketClientOptions;
  readonly #activeClients = new Set<HerdrSocketClient>();
  #closed = false;

  constructor(socketPath: string, options: HerdrSocketClientOptions = {}) {
    if (!socketPath) throw new TypeError("socketPath must not be empty");
    this.#socketPath = socketPath;
    this.#options = options;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    expectedType: string,
    beforeRequest?: () => void,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      throw new HerdrDisconnectedError("Herdr unary transport is closed", false);
    }
    const client = await HerdrSocketClient.connect(this.#socketPath, this.#options);
    if (this.#closed) {
      client.close();
      throw new HerdrDisconnectedError("Herdr unary transport closed before request submission", false);
    }
    this.#activeClients.add(client);
    try {
      beforeRequest?.();
      return await client.request(method, params, expectedType);
    } finally {
      this.#activeClients.delete(client);
      client.close();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const client of this.#activeClients) client.close();
    this.#activeClients.clear();
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HerdrProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError("requestTimeoutMs must be an integer from 1 to 60000");
  }
  return value;
}
