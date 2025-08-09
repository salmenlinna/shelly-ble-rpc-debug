### Shelly BLE tool (Node.js)

Minimal CLI tool to send JSON‑RPC commands to Shelly Gen2/Gen3 devices over Bluetooth Low Energy using `@abandonware/noble`.

This script can scan for nearby Shelly devices, connect over BLE, send a single RPC request (default `Shelly.GetStatus`), print the parsed JSON response, and optionally keep prompting for further RPCs.

---

### Clone from GitHub

```bash
git clone https://github.com/salmenlinna/shelly-ble-rpc-debug.git
cd shelly-ble-rpc-debug
```

---

### Requirements

- macOS or Linux with a working Bluetooth LE adapter
- Node.js 16+ (recommended)
- npm

On macOS, ensure the terminal app has Bluetooth permission (System Settings → Privacy & Security → Bluetooth).

On Linux, make sure Bluetooth services are running and your user has access. In some distros, you may need additional packages like `bluetooth`, `bluez`, `libbluetooth-dev`, `libudev-dev`.

---

### Install

1) Change to the project directory:

```bash
cd shelly-ble-rpc-debug
```

2) Install dependencies:

```bash
npm install
```

---

### Run

Start the interactive scanner (default behavior if no address or name is provided):

```bash
cd shelly-ble-rpc-debug
npm start
```

Or run directly with Node:

```bash
cd shelly-ble-rpc-debug
node shelly-ble-rpc.js
```

You will see discovered Shelly devices and can select one to connect. After each request, you’ll be prompted for the next method and optional params JSON.

---

### CLI options

You can skip scanning by specifying a target device and/or RPC upfront:

- `--scan` scan and then select interactively
- `--address <AA:BB:CC:DD:EE:FF>` connect by BLE MAC address
- `--name "ShellyPro-1234"` connect by advertised name
- `--method <RPC.Method>` RPC method to call
- `--params '<json>'` JSON string for `params`

Environment variables:

- `METHOD` sets the initial RPC method (e.g., `METHOD=Shelly.GetDeviceInfo`)

---

### Examples

Scan and select interactively:

```bash
node shelly-ble-rpc.js --scan
```

Call a method provided via env var, then continue interactively:

```bash
METHOD="Shelly.GetDeviceInfo" node shelly-ble-rpc.js
```

Connect by address and call a specific method with params:

```bash
node shelly-ble-rpc.js \
  --address AA:BB:CC:DD:EE:FF \
  --method Sys.SetConfig \
  --params '{"config": {}}'
```

Connect by device name:

```bash
node shelly-ble-rpc.js --name "ShellyPro-1234" --method Shelly.GetStatus
```

---

### Output

On success, the script prints a parsed JSON response, for example:

```json
{
  "id": 1718123456789,
  "source": "shelly",
  "result": { /* device-specific fields */ }
}
```

---

### Notes and caveats

- The script uses Shelly’s documented BLE GATT service and RPC characteristics and performs a length-prefixed write/read flow. It also includes a fallback “best-effort” read if the length is not signaled.
- Writing configuration (e.g., `Sys.SetConfig`) may alter device behavior. Use with care.
- BLE MTU/throughput varies by adapter/OS. The script uses conservative 20-byte chunks.

---

### Troubleshooting

- "Bluetooth adapter not powered on":
  - Ensure Bluetooth is enabled and accessible to your terminal session.
  - macOS: grant Bluetooth permission to your terminal app in System Settings.
  - Linux: ensure `bluetoothd`/`bluez` are running and your user has required permissions.

- Cannot find any devices:
  - Bring the device closer and ensure it is advertising BLE.
  - Try `--scan` and wait for the full scan window.

- JSON parse errors in response:
  - The script prints the raw response to help diagnose; often indicates a partial read or unexpected payload.

---

### Scripts

- `npm start` → `node shelly-ble-rpc.js`

---

### License

ISC

---

### References

- Shelly BLE docs: `https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/BLE`
- Communicating with Shelly devices via Bluetooth: `https://kb.shelly.cloud/knowledge-base/kbsa-communicating-with-shelly-devices-via-bluetoo`


