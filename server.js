import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";

const port = process.env.PORT || 8088;
const wss = new WebSocketServer({ port });

/**
 * Maps deviceId -> Set<WebSocket> of active open sockets for this device.
 * @type {Map<string, Set<WebSocket>>}
 */
const deviceToSockets = new Map();

/**
 * Maps WebSocket -> deviceId.
 * @type {Map<WebSocket, string>}
 */
const socketToDevice = new Map();

const { BACKEND_BASE_URL, BACKEND_VERSION, INTERNAL_KEY } = process.env;
const internalKey = INTERNAL_KEY || "";

// Heartbeat configuration: ping every 10s, wait 5s for pong
const PING_INTERVAL_MS = 10 * 1000;
const PONG_TIMEOUT_MS = 5 * 1000;

wss.on("connection", async function connection(ws, req) {
  const queryParams = new URLSearchParams(req.url.replace("/?", ""));
  const type = queryParams.get("type");
  const id = queryParams.get("id");

  let heartbeatIntervalId = null;
  let heartbeatTimeoutId = null;
  let isAwaitingPong = false;

  const startHeartbeat = () => {
    if (!socketToDevice.has(ws)) return;

    heartbeatIntervalId = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      isAwaitingPong = true;
      ws.send(JSON.stringify({ event: "ping" }));

      heartbeatTimeoutId = setTimeout(() => {
        if (isAwaitingPong && ws.readyState === WebSocket.OPEN) {
          const deviceId = socketToDevice.get(ws) || "unknown";
          console.warn(`[HEARTBEAT] Ping timeout for device ${deviceId}. Terminating dead connection.`);
          ws.terminate();
        }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  };

  const handlePong = () => {
    isAwaitingPong = false;
    if (heartbeatTimeoutId) {
      clearTimeout(heartbeatTimeoutId);
      heartbeatTimeoutId = null;
    }
    startHeartbeat();
  };

  if (type === "device" && id) {
    console.log(`device - ${id} connecting...`);

    // Prune existing stale connections for this deviceId to eliminate ghost sockets
    const existingSockets = deviceToSockets.get(id);
    if (existingSockets && existingSockets.size > 0) {
      console.log(`device - ${id} has ${existingSockets.size} existing socket(s). Pruning stale connections.`);
      existingSockets.forEach((staleSocket) => {
        socketToDevice.delete(staleSocket);
        existingSockets.delete(staleSocket);
        try {
          staleSocket.terminate();
        } catch (e) {}
      });
    }

    socketToDevice.set(ws, id);
    if (!deviceToSockets.has(id)) {
      deviceToSockets.set(id, new Set());
    }
    deviceToSockets.get(id).add(ws);

    console.log(`device - ${id} connected (active sockets: ${deviceToSockets.get(id).size})`);
    updateDeviceStatus(id, true, wss);
    startHeartbeat();
  }

  // Key must stay "event": every client dispatches on data.event.
  ws.send(
    JSON.stringify({
      event: "backend-url",
      data: `${BACKEND_BASE_URL}`,
    }),
  );

  ws.on("message", async function incoming(message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error("[WS] Failed to parse message:", e.message);
      return;
    }

    if (socketToDevice.has(ws)) {
      const deviceId = socketToDevice.get(ws);

      if (data.event === "pong") {
        handlePong();
        return;
      }

      if (data.event === "device-log") {
        try {
          console.log(`Sending log from ${deviceId} to api!`);
          const response = await axios.put(
            `${BACKEND_BASE_URL}/${BACKEND_VERSION}/public-advert/device-log/${deviceId}`,
            data.logs,
            { headers: { "X-Internal-Key": internalKey, "User-Agent": data.userAgent } },
          );
          console.log(`Sent log from ${deviceId} to api!`);
          broadcastToObservers(
            {
              event: "device-log",
              log: { ...data.logs, ...response.data.data },
            },
            ws,
          );
        } catch (error) {
          console.error(`Failed to send log from ${deviceId} to api:`, error.response?.data?.message || error.message);
        }
      }

      if (data.event === "now-playing") {
        broadcastToObservers({ event: "now-playing", deviceId, data: data.data }, ws);
      }

      if (data.event === "device-screenshot") {
        broadcastToObservers({ event: "device-screenshot", deviceId, data: data.data }, ws);

        const payload = {
          capturedAt: data.capturedAt,
          screenshot: data.data,
          campaignRefs: data.campaignRefs || [],
        };

        axios
          .post(`${BACKEND_BASE_URL}/${BACKEND_VERSION}/internal/screenshot/${deviceId}`, payload, {
            headers: { "X-Internal-Key": internalKey },
          })
          .then((res) => {
            console.log(
              `Successfully uploaded screenshot for ${deviceId}. Reference: ${res.data?.data?.reference}`,
            );
          })
          .catch((err) => {
            console.error(
              `Failed to upload screenshot for ${deviceId}:`,
              err.response?.data?.message || err.message,
            );
          });
      }
    }

    if (data.event === "send-to-device" && data.deviceId) {
      console.log(`received campaigns going to ${data.deviceId}`);
      forwardToDevice(data.deviceId, data, "campaigns");
    }

    if (data.event === "device-settings" && data.deviceId) {
      forwardToDevice(data.deviceId, data, "settings");
    }

    if (data.event === "take-screenshot" && data.deviceId) {
      console.log(`received screenshot request going to ${data.deviceId}`);
      forwardToDevice(data.deviceId, data, "screenshot");
    }
  });

  ws.on("close", function close() {
    if (heartbeatIntervalId) clearTimeout(heartbeatIntervalId);
    if (heartbeatTimeoutId) clearTimeout(heartbeatTimeoutId);

    if (socketToDevice.has(ws)) {
      const id = socketToDevice.get(ws);
      socketToDevice.delete(ws);

      const sockets = deviceToSockets.get(id);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          deviceToSockets.delete(id);
          console.log(`device - ${id} disconnected (0 active sockets remaining)`);
          updateDeviceStatus(id, false, wss);
        } else {
          console.log(`device - ${id} socket closed, but ${sockets.size} active socket(s) remain. Preserving ONLINE status.`);
        }
      }
    }
  });

  ws.on("error", function error(err) {
    console.error(`[WS] Socket error for ${socketToDevice.get(ws) || "client"}:`, err.message);
    ws.terminate();
  });
});

console.log(`WebSocket server running on ws://localhost:${port}`);

/**
 * Send to every watching client - dashboards, not devices - skipping the sender.
 */
function broadcastToObservers(payload, sender) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client === sender) return;
    if (socketToDevice.has(client)) return;
    client.send(message);
  });
}

/**
 * Relay a payload to every open socket registered under this deviceId.
 */
function forwardToDevice(deviceId, payload, label) {
  const sockets = deviceToSockets.get(deviceId);

  if (!sockets || sockets.size === 0) {
    console.log(`no device found for ${deviceId}, or it isn't online`);
    return;
  }

  sockets.forEach((deviceSocket) => {
    if (deviceSocket.readyState === WebSocket.OPEN) {
      deviceSocket.send(JSON.stringify(payload));
      console.log(`Sent ${label} to device ${deviceId}`);
    }
  });
}

async function updateDeviceStatus(deviceId, status, wss) {
  try {
    console.log(`[STATUS] Updating device status in backend: ${deviceId} -> ${status ? "ONLINE" : "OFFLINE"}`);
    const { data } = await axios.put(
      `${BACKEND_BASE_URL}/${BACKEND_VERSION}/public-advert/device-status/${deviceId}`,
      {
        status,
      },
      { headers: { "X-Internal-Key": internalKey } },
    );
    console.log(`[STATUS] Backend acknowledged status for ${deviceId}. Broadcasting to observers...`);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            event: "device-connection",
            screens: data.data,
          }),
        );
      }
    });
  } catch (error) {
    console.error(
      `[STATUS] [ERROR] Failed to update device status for ${deviceId} (${status ? "ONLINE" : "OFFLINE"}):`,
      error.response?.data?.message || error.message,
    );
  }
}
