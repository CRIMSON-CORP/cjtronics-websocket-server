import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";

const port = process.env.PORT || 8088;
const wss = new WebSocketServer({ port });
/**
 * @type {Map<WebSocket, string>} clients - Map of Clients, keyed by an identifier.
 */
const connectedDevices = new Map();

const { BACKEND_BASE_URL, BACKEND_VERSION, INTERNAL_KEY } = process.env;
const internalKey = INTERNAL_KEY || "";

wss.on("connection", async function connection(ws, req) {
  const queryParams = new URLSearchParams(req.url.replace("/?", ""));
  const type = queryParams.get("type");
  const id = queryParams.get("id");

  if (type === "device" && id) {
    if (!connectedDevices.has(ws)) {
      console.log(`device - ${id} connected`);
      connectedDevices.set(ws, id);

      try {
        updateDeviceStatus(id, true, wss);
      } catch (error) {}
    }
  }

  // Key must stay "event": every client dispatches on data.event.
  ws.send(
    JSON.stringify({
      event: "backend-url",
      data: `${BACKEND_BASE_URL}`,
    }),
  );

  ws.on("message", async function incoming(message) {
    const data = JSON.parse(message);

    if (connectedDevices.has(ws)) {
      const deviceId = connectedDevices.get(ws);
      if (data.event === "device-log") {
        try {
          console.log(`Sending log from ${deviceId} to api!`);
          const response = await axios.put(
            `${BACKEND_BASE_URL}/${BACKEND_VERSION}/public-advert/device-log/${deviceId}`,
            data.logs,
            { headers: { "X-Internal-Key": internalKey } },
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
          console.log(`Failed to send log from ${deviceId} to api!`);
          console.log(error);
        }
      }

      // What this device is showing right now, mirrored into the dashboard's
      // preview. Deliberately not persisted and not routed through the backend:
      // the log path already covers history, and gating this on the backend
      // being up would blank the preview for unrelated reasons.
      if (data.event === "now-playing") {
        broadcastToObservers({ event: "now-playing", deviceId, data: data.data }, ws);
      }

      if (data.event === "device-screenshot") {
        broadcastToObservers({ event: "device-screenshot", deviceId, data: data.data }, ws);

        // Upload to backend using internal key
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

      if (data.event === "pong") {
        clearTimeout(heartbeatTimeout);
        setTimeout(heartbeat, 10 * 1000);
      }
    }

    if (data.event === "send-to-device" && data.deviceId) {
      console.log(`received campaigns going to ${data.deviceId}`);
      forwardToDevice(data.deviceId, data, "campaigns");
    }

    // Live brightness/volume from the dashboard. Fire and forget: the device
    // applies it, nothing is acked back.
    if (data.event === "device-settings" && data.deviceId) {
      forwardToDevice(data.deviceId, data, "settings");
    }

    if (data.event === "take-screenshot" && data.deviceId) {
      console.log(`received screenshot request going to ${data.deviceId}`);
      forwardToDevice(data.deviceId, data, "screenshot");
    }
  });

  ws.on("close", function close() {
    if (connectedDevices.has(ws)) {
      const id = connectedDevices.get(ws);
      connectedDevices.delete(ws);
      console.log(`device - ${id} disconnected`);
      updateDeviceStatus(id, false, wss);
    }
  });

  let heartbeatTimeout = null;

  const heartbeat = () => {
    if (connectedDevices.has(ws) && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "ping" }));
      heartbeatTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log("terminate connection");
          ws.terminate();
        }
      }, 10 * 1000);
    }
  };

  heartbeat();
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
    if (connectedDevices.has(client)) return;
    client.send(message);
  });
}

/**
 * Relay a payload to every open socket registered under this deviceId.
 * A device can hold more than one entry if it reconnected before the old
 * socket's close fired.
 */
function forwardToDevice(deviceId, payload, label) {
  const deviceSockets = [];

  connectedDevices.forEach((id, socket) => {
    if (id === deviceId) deviceSockets.push(socket);
  });

  if (deviceSockets.length === 0) {
    console.log(`no device found for ${deviceId}, or it isn't online`);
    return;
  }

  deviceSockets.forEach((deviceSocket) => {
    if (deviceSocket.readyState !== WebSocket.OPEN) return;
    deviceSocket.send(JSON.stringify(payload));
    console.log(`Sent ${label} to device ${deviceId}`);
  });
}

async function updateDeviceStatus(deviceId, status, wss) {
  try {
    const { data } = await axios.put(
      `${BACKEND_BASE_URL}/${BACKEND_VERSION}/public-advert/device-status/${deviceId}`,
      {
        status,
      },
      { headers: { "X-Internal-Key": internalKey } },
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
  } catch (error) {}
}
