import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

/**
 * @type {Map<WebSocket, string>} clients - Map of Clients, keyed by an identifier.
 */
const conncetedDevices = new Map();

const BACKEND_BASE_URL = "https://cjtronics.tushcode.com";
const BACKEND_VERSION = "v1";

wss.on("connection", async function connection(ws, req) {
  const queryParams = new URLSearchParams(req.url.replace("/?", ""));
  const type = queryParams.get("type");
  const id = queryParams.get("id");

  if (type === "device" && id) {
    if (!conncetedDevices.has(ws)) {
      console.log(`device - ${id} connected`);
      conncetedDevices.set(ws, id);

      try {
        updateDeviceStatus(id, true, wss);
      } catch (error) {}
    }
  }

  ws.on("message", async function incoming(message) {
    const data = JSON.parse(message);
    if (conncetedDevices.has(ws)) {
      const deviceId = conncetedDevices.get(ws);
      if (data.event === "device-log") {
        try {
          await axios.put(
            `${BACKEND_BASE_URL}/${BACKEND_VERSION}/public-advert/device-log/${deviceId}`,
            data
          );
        } catch (error) {
          console.log(error);
        }
      }
      return;
    }

    if (data.event === "send-to-device" && data.device_id) {
      let deviceSocket = null;

      conncetedDevices.forEach((id, key) => {
        console.log(id);

        if (id === data.device_id) {
          deviceSocket = key;
        }
      });

      if (deviceSocket) {
        if (deviceSocket.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      }
      return;
    }
  });

  ws.on("close", function close() {
    if (conncetedDevices.has(ws)) {
      const id = conncetedDevices.get(ws);
      console.log(`device - ${id} disconnected`);
      updateDeviceStatus(id, false, wss);
    }
  });
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
