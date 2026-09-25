import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";
import sharp from "sharp";

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
          console.warn(
            `[HEARTBEAT] Ping timeout for device ${deviceId}. Terminating dead connection.`,
          );
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
      console.log(
        `device - ${id} has ${existingSockets.size} existing socket(s). Pruning stale connections.`,
      );
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
          console.error(
            `Failed to send log from ${deviceId} to api:`,
            error.response?.data?.message || error.message,
          );
        }
      }

      if (data.event === "now-playing") {
        broadcastToObservers({ event: "now-playing", deviceId, data: data.data }, ws);
      }

      if (data.event === "device-screenshot") {
        const { data: base64Data, capturedAt, metadata, deviceId } = data;

        const watermarkedBase64 = await watermarkScreenshot(base64Data, {
          screenName: metadata?.screenName,
          location: metadata?.location,
          deviceId: metadata?.deviceId || deviceId,
          capturedAt,
        });

        broadcastToObservers({ event: "device-screenshot", deviceId, data: watermarkedBase64 }, ws);

        const blob = new Blob([Buffer.from(watermarkedBase64, "base64")], {
          type: "image/png",
        });

        const formData = new FormData();
        formData.append(
          "file",
          blob,
          `screenshot_${metadata?.deviceId || deviceId}_${Date.now()}.png`,
        );
        formData.append("campaignRefs", JSON.stringify(data.campaignRefs || []));
        formData.append("capturedAt", capturedAt);

        axios
          .post(
            `${BACKEND_BASE_URL}/${BACKEND_VERSION}/internal/screenshot/${deviceId}`,
            formData,
            {
              headers: { "X-Internal-Key": internalKey },
            },
          )
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
          console.log(
            `device - ${id} socket closed, but ${sockets.size} active socket(s) remain. Preserving ONLINE status.`,
          );
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
    console.log(
      `[STATUS] Updating device status in backend: ${deviceId} -> ${status ? "ONLINE" : "OFFLINE"}`,
    );
    const { data } = await axios.put(
      `${BACKEND_BASE_URL}/${BACKEND_VERSION}/public-advert/device-status/${deviceId}`,
      {
        status,
      },
      { headers: { "X-Internal-Key": internalKey } },
    );
    console.log(
      `[STATUS] Backend acknowledged status for ${deviceId}. Broadcasting to observers...`,
    );
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

async function watermarkScreenshot(base64Image, { screenName, location, deviceId, capturedAt }) {
  // Strip any data URI prefix if present
  const rawBase64 = base64Image.replace(/^data:image\/\w+;base64,/, "");
  const imageBuffer = Buffer.from(rawBase64, "base64");

  const dateStr = capturedAt ? capturedAt.split("T")[0] : new Date().toISOString().split("T")[0];
  const timeStr = capturedAt
    ? capturedAt.split("T")[1]?.slice(0, 8)
    : new Date().toTimeString().slice(0, 8);

  const sansFont =
    "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif";
  const svgWatermark = `
    <svg width="680" height="310" xmlns="http://www.w3.org/2000/svg" font-family="${sansFont}">
      <style>
        text {
          font-family: ${sansFont};
        }
      </style>
      <rect width="100%" height="100%" rx="20" fill="rgba(10, 15, 29, 0.55)"/>
      
      <!-- Status Badge -->
      <circle cx="34" cy="38" r="8" fill="#10b981" />
      <text x="54" y="44" fill="#94a3b8" font-size="18" font-weight="700" letter-spacing="2">PROOF OF PLAY AUDIT</text>
      
      <!-- Divider -->
      <line x1="28" y1="64" x2="652" y2="64" stroke="rgba(255, 255, 255, 0.18)" stroke-width="2"/>
      
      <!-- Rows -->
      <text x="28" y="106" fill="#94a3b8" font-size="22" font-weight="500">Screen:</text>
      <text x="652" y="106" fill="#ffffff" font-size="22" font-weight="700" text-anchor="end">${screenName || "Screen"}</text>
      
      <text x="28" y="152" fill="#94a3b8" font-size="22" font-weight="500">Date:</text>
      <text x="652" y="152" fill="#ffffff" font-size="22" font-weight="700" text-anchor="end">${dateStr}</text>
      
      <text x="28" y="198" fill="#94a3b8" font-size="22" font-weight="500">Time:</text>
      <text x="652" y="198" fill="#ffffff" font-size="22" font-weight="700" text-anchor="end">${timeStr}</text>
      
      <text x="28" y="244" fill="#94a3b8" font-size="22" font-weight="500">Location:</text>
      <text x="652" y="244" fill="#ffffff" font-size="22" font-weight="700" text-anchor="end">${location || "Unknown"}</text>
      
      <text x="28" y="290" fill="#94a3b8" font-size="22" font-weight="500">Device ID:</text>
      <text x="652" y="290" fill="#ffffff" font-size="22" font-weight="700" text-anchor="end">${deviceId || "N/A"}</text>
    </svg>
  `;

  const watermarkedBuffer = await sharp(imageBuffer)
    .composite([
      {
        input: Buffer.from(svgWatermark),
        top: 24,
        left: 24,
      },
    ])
    .png()
    .toBuffer();

  return watermarkedBuffer.toString("base64");
}
