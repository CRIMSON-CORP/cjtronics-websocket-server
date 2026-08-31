import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";

const port = process.env.PORT || 8088;
const wss = new WebSocketServer({ port });
/**
 * @type {Map<WebSocket, string>} clients - Map of Clients, keyed by an identifier.
 */
const connectedDevices = new Map();

const { BACKEND_BASE_URL, BACKEND_VERSION } = process.env;

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
    })
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
            data.logs
          );
          console.log(`Sent log from ${deviceId} to api!`);
          wss.clients.forEach((client) => {
            if (client.readyState !== WebSocket.OPEN) return;
            if (client === ws) return;
            if (connectedDevices.has(client)) return;
            client.send(
              JSON.stringify({
                event: "device-log",
                log: { ...data.logs, ...response.data.data },
              })
            );
          });
        } catch (error) {
          console.log(`Failed to send log from ${deviceId} to api!`);
          console.log(error);
        }
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
      }
    );
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            event: "device-connection",
            screens: data.data,
          })
        );
      }
    });
  } catch (error) {}
}
