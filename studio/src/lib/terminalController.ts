import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useSyncExternalStore } from "react";

export type ConnectionState = "idle" | "connecting" | "open" | "closed";

export interface ConnectionSnapshot {
  state: ConnectionState;
  code: number | null;
  reason: string;
}

const ATTACHED_ELSEWHERE = 4001;
const FONT = '"IBM Plex Mono", ui-monospace, Menlo, monospace';

const THEME: ITheme = {
  background: "#0b0d14",
  foreground: "#c9cfdb",
  cursor: "#8cc8a0",
  cursorAccent: "#0b0d14",
  selectionBackground: "#2f4f3c",
  black: "#12151e",
  red: "#ff8f88",
  green: "#8cc8a0",
  yellow: "#f2c25c",
  blue: "#7fb2ff",
  magenta: "#c4a7ff",
  cyan: "#67d6e0",
  white: "#c9cfdb",
  brightBlack: "#6b7080",
  brightRed: "#ff8f88",
  brightGreen: "#a3d6b3",
  brightYellow: "#f2c25c",
  brightBlue: "#7fb2ff",
  brightMagenta: "#c4a7ff",
  brightCyan: "#67d6e0",
  brightWhite: "#f5f5f0",
};

const encoder = new TextEncoder();
const closeListeners = new Set<(id: string) => void>();

// The websocket address of one terminal on the server that serves this page.
function socketUrl(id: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/term/${id}`;
}

// The bytes of an xterm binary string, where every character is one byte.
function binaryStringBytes(data: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff);
}

// Waits for the mono font, so xterm measures its cells with the face it draws; a failed load keeps the fallback face.
async function fontsReady(): Promise<void> {
  try {
    await document.fonts.load(`14px ${FONT}`);
  } catch {
    return;
  }
}

// One terminal of the page: an xterm opened once, its fit addon and its websocket, living outside React so tab switches never reconnect.
export class TerminalController {
  readonly id: string;
  private readonly host: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private socket: WebSocket | null = null;
  private opened: Promise<void> | null = null;
  private observer: ResizeObserver | null = null;
  private snapshot: ConnectionSnapshot = { state: "idle", code: null, reason: "" };
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  // Builds the xterm on a detached host element; nothing connects until the first attach.
  constructor(id: string) {
    this.id = id;
    this.host = document.createElement("div");
    this.host.className = "h-full w-full";
    this.term = new Terminal({ theme: THEME, fontFamily: FONT, fontSize: 13, cursorBlink: true, scrollback: 5000 });
    this.term.loadAddon(this.fit);
    this.term.onData((data) => this.send(encoder.encode(data)));
    this.term.onBinary((data) => this.send(binaryStringBytes(data)));
    this.term.onResize(({ cols, rows }) => this.sendResize(cols, rows));
  }

  // Moves the terminal into a container on screen, opens it the first time, fits it and connects when it is not connected.
  attach(container: HTMLElement) {
    if (this.disposed) return;
    container.appendChild(this.host);
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.fitIfVisible());
    this.observer.observe(container);
    this.opened ??= fontsReady().then(() => {
      if (!this.disposed) this.term.open(this.host);
    });
    void this.opened.then(() => {
      this.fitIfVisible();
      this.term.focus();
    });
    if (this.snapshot.state === "idle") this.connect();
  }

  // Takes the terminal off screen; its websocket stays open.
  detach(container: HTMLElement) {
    this.observer?.disconnect();
    this.observer = null;
    if (this.host.parentElement === container) container.removeChild(this.host);
  }

  // Opens a new websocket after the previous one closed, unless the controller was disposed.
  reconnect() {
    if (this.disposed || this.snapshot.state === "open" || this.snapshot.state === "connecting") return;
    this.connect();
  }

  // Closes the websocket and frees the xterm, once the terminal is gone from the server.
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.socket?.close(1000, "tab closed");
    this.socket = null;
    this.host.remove();
    this.term.dispose();
  }

  // The connection state the views render.
  getSnapshot = (): ConnectionSnapshot => this.snapshot;

  // Subscribes a view to the connection state.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Replaces the connection state and tells every view.
  private setSnapshot(next: ConnectionSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  // Opens the websocket of this terminal and wires its bytes to the xterm.
  private connect() {
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(this.id));
    } catch (err) {
      this.setSnapshot({ state: "closed", code: null, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.setSnapshot({ state: "connecting", code: null, reason: "" });
    socket.onopen = () => this.onOpen(socket);
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) this.term.write(new Uint8Array(event.data));
    };
    socket.onclose = (event) => this.onClose(socket, event);
  }

  // Marks the socket open and tells the pty the size the xterm has.
  private onOpen(socket: WebSocket) {
    if (socket !== this.socket) return;
    this.setSnapshot({ state: "open", code: null, reason: "" });
    this.sendResize(this.term.cols, this.term.rows);
  }

  // Records why the socket closed, writes it in the terminal and tells the listing to refresh.
  private onClose(socket: WebSocket, event: CloseEvent) {
    if (socket !== this.socket || this.disposed) return;
    this.socket = null;
    const reason = event.code === ATTACHED_ELSEWHERE ? "attached elsewhere (another browser tab took this terminal)" : event.reason || `connection closed (${event.code})`;
    this.term.write(`\r\n\x1b[2m[nightqueue] ${reason}\x1b[0m\r\n`);
    this.setSnapshot({ state: "closed", code: event.code, reason });
    for (const listener of closeListeners) listener(this.id);
  }

  // Sends bytes to the pty while the socket is open.
  private send(bytes: Uint8Array<ArrayBuffer>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(bytes);
  }

  // Tells the pty the xterm's size while the socket is open.
  private sendResize(cols: number, rows: number) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ resize: { cols, rows } }));
  }

  // Fits the xterm to its container, only when the container has a size (a hidden dock has none).
  private fitIfVisible() {
    const parent = this.host.parentElement;
    if (this.disposed || !this.term.element || !parent || parent.clientWidth === 0 || parent.clientHeight === 0) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
  }
}

const controllers = new Map<string, TerminalController>();

// The controller of one terminal id, created on first use and kept for the life of the page.
export function controllerFor(id: string): TerminalController {
  let controller = controllers.get(id);
  if (!controller) {
    controller = new TerminalController(id);
    controllers.set(id, controller);
  }
  return controller;
}

// Frees the controller of a terminal that left the server's listing.
export function disposeController(id: string) {
  controllers.get(id)?.dispose();
  controllers.delete(id);
}

// Frees every controller whose terminal is no longer listed by the server.
export function disposeControllersExcept(liveIds: Set<string>) {
  for (const id of [...controllers.keys()]) if (!liveIds.has(id)) disposeController(id);
}

// Calls a listener whenever one terminal's websocket closes; answers the unsubscribe.
export function onTerminalSocketClosed(listener: (id: string) => void) {
  closeListeners.add(listener);
  return () => {
    closeListeners.delete(listener);
  };
}

// The connection state of one terminal's controller.
export function useConnection(controller: TerminalController): ConnectionSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}
