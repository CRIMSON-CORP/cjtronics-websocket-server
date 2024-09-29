import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

/**
 * @type {Map<WebSocket, string>} clients - Map of Clients, keyed by an identifier.
 */
const connectedDevices = new Map();

const BACKEND_BASE_URL = "https://cjtronics.tushcode.com";
const BACKEND_VERSION = "v1";

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

  ws.on("message", async function incoming(message) {
    const data = JSON.parse(message);

    if (connectedDevices.has(ws)) {
      const deviceId = connectedDevices.get(ws);
      if (data.event === "device-log") {
        try {
          console.log(`Sending log from ${deviceId} to api!`);
          await axios.put(
            `${BACKEND_BASE_URL}/${BACKEND_VERSION}/public-advert/device-log/${deviceId}`,
            data.logs
          );
          console.log(`Sent log from ${deviceId} to api!`);
        } catch (error) {
          console.log(`Failed to send log from ${deviceId} to api!`);
          console.log(error);
        }
      }

      if (data.event === "send-to-device" && data.deviceId) {
        console.log(`received campaigns going to ${data.deviceId}`);

        let deviceSocket = null;

        connectedDevices.forEach((id, key) => {
          if (id === data.deviceId) {
            console.log(`found device! -  ${data.deviceId}`);
            deviceSocket = key;
          }
        });

        if (deviceSocket) {
          if (deviceSocket.readyState === WebSocket.OPEN) {
            console.log(`sending campaigns to device - ${data.deviceId}`);
            deviceSocket.send(JSON.stringify(data));
            console.log(`Sent campaigns to device ${data.deviceId}`);
          }
        } else {
          console.log("device not found or not online");
        }
        return;
      }

      if (data.event === "pong") {
        clearTimeout(heartbeatTimeout);
        setTimeout(heartbeat, 10 * 1000);
      }

      return;
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
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "ping" }));
      heartbeatTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log("terminate connection");
          ws.terminate();
        }
      }, 20 * 1000);
    }
  };

  heartbeat();
});

console.log("WebSocket server running on ws://localhost:8080");

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
