// Browser-side WebSocket with automatic reconnect and exponential backoff.

export interface LiveSocket {
  send(msg: unknown): boolean;
}

export function connectSocket(
  role: "panel" | "screen",
  onMessage: (msg: unknown) => void,
  onStatus: (connected: boolean) => void = () => {},
  onOpen: () => void = () => {},
): LiveSocket {
  let ws: WebSocket | null = null;
  let attempt = 0;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws?role=${role}`);
    ws.onopen = () => {
      attempt = 0;
      onStatus(true);
      onOpen();
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(String(ev.data)));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      onStatus(false);
      ws = null;
      const delay = Math.min(10_000, 400 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt += 1;
      setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
  };
}
