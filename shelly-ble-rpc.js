/*
 Minimal Shelly BLE RPC tester for Node.js (macOS/Linux) using @abandonware/noble
 - Connects to a Shelly device over BLE
 - Sends a single JSON-RPC request (default: Shelly.GetStatus)
 - Prints the parsed JSON response

 Usage examples:
   node shelly-ble-rpc.js                                  # scan and select device interactively
   node shelly-ble-rpc.js --scan                           # scan and select device interactively
   METHOD="Shelly.GetDeviceInfo" node shelly-ble-rpc.js
   node shelly-ble-rpc.js --address AA:BB:CC:DD:EE:FF
   node shelly-ble-rpc.js --name "ShellyPro-1234"
   node shelly-ble-rpc.js --method Shelly.GetDeviceInfo
   node shelly-ble-rpc.js --method Sys.SetConfig --params '{"config": {}}'
*/

const noble = require('@abandonware/noble');

// Shelly BLE GATT UUIDs from documentation
// https://kb.shelly.cloud/knowledge-base/kbsa-communicating-with-shelly-devices-via-bluetoo
// https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/BLE
const SHELLY_GATT_SERVICE_UUID = '5f6d4f53-5f52-5043-5f53-56435f49445f';
const RPC_CHAR_DATA_UUID = '5f6d4f53-5f52-5043-5f64-6174615f5f5f';
const RPC_CHAR_TX_CTL_UUID = '5f6d4f53-5f52-5043-5f74-785f63746c5f';
const RPC_CHAR_RX_CTL_UUID = '5f6d4f53-5f52-5043-5f72-785f63746c5f';

function normalizeUuid(uuidWithHyphens) {
  return uuidWithHyphens.replace(/-/g, '').toLowerCase();
}

const TARGET_SERVICE = normalizeUuid(SHELLY_GATT_SERVICE_UUID);
const UUID_DATA = normalizeUuid(RPC_CHAR_DATA_UUID);
const UUID_TXCTL = normalizeUuid(RPC_CHAR_TX_CTL_UUID);
const UUID_RXCTL = normalizeUuid(RPC_CHAR_RX_CTL_UUID);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = { address: null, name: null, method: null, params: null, scan: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--address' && argv[i + 1]) {
      args.address = argv[i + 1];
      i += 1;
    } else if (arg === '--name' && argv[i + 1]) {
      args.name = argv[i + 1];
      i += 1;
    } else if (arg === '--method' && argv[i + 1]) {
      args.method = argv[i + 1];
      i += 1;
    } else if (arg === '--params' && argv[i + 1]) {
      args.params = argv[i + 1];
      i += 1;
    } else if (arg === '--scan') {
      args.scan = true;
    }
  }
  return args;
}

function tryParseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    throw new Error('Failed to parse --params as JSON');
  }
}

async function scanForDevices(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const devices = [];
    const deviceIds = new Set();

    const onDiscover = (peripheral) => {
      const advertisedName = peripheral.advertisement?.localName || '';
      const address = (peripheral.address || peripheral.id || '').toLowerCase();
      const rssi = peripheral.rssi || 0;
      
      // Only add Shelly devices and avoid duplicates
      if (/shelly/i.test(advertisedName) && !deviceIds.has(address)) {
        deviceIds.add(address);
        devices.push({
          peripheral,
          name: advertisedName,
          address,
          rssi
        });
        console.log(`Found: ${advertisedName} [${address}] (RSSI: ${rssi})`);
      }
    };

    noble.on('discover', onDiscover);
    noble.startScanning([], false, (err) => {
      if (err) reject(err);
    });

    setTimeout(() => {
      noble.removeListener('discover', onDiscover);
      try { noble.stopScanning(() => {}); } catch (_) {}
      resolve(devices);
    }, timeoutMs);
  });
}

async function discoverShelly(args) {
  return new Promise((resolve, reject) => {
    const onDiscover = (peripheral) => {
      const advertisedName = peripheral.advertisement?.localName || '';
      const address = (peripheral.address || peripheral.id || '').toLowerCase();
      const matchesAddress = args.address && address === args.address.toLowerCase();
      const matchesName = args.name && advertisedName === args.name;
      const looksLikeShelly = !args.address && !args.name && /shelly/i.test(advertisedName);
      if (matchesAddress || matchesName || looksLikeShelly) {
        noble.removeListener('discover', onDiscover);
        try { noble.stopScanning(() => {}); } catch (_) {}
        resolve(peripheral);
      }
    };

    noble.on('discover', onDiscover);
    noble.startScanning([], false, (err) => {
      if (err) reject(err);
    });

    // Safety timeout
    setTimeout(() => {
      noble.removeListener('discover', onDiscover);
      try { noble.stopScanning(() => {}); } catch (_) {}
      reject(new Error('Scan timeout: Shelly device not found'));
    }, 20000);
  });
}

function findCharsByUuid(characteristics, uuids) {
  const map = new Map();
  for (const ch of characteristics) {
    if (uuids.includes(ch.uuid)) {
      map.set(ch.uuid, ch);
    }
  }
  return map;
}

async function writeWithResponse(characteristic, data) {
  return new Promise((resolve, reject) => {
    // Noble signature: write(data, withoutResponse, cb)
    // We want WITH response (ACK) → withoutResponse = false
    characteristic.write(data, false, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function readCharacteristic(characteristic) {
  return new Promise((resolve, reject) => {
    characteristic.read((err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function subscribeNotifications(characteristic, onData) {
  return new Promise((resolve, reject) => {
    const handler = (chunk) => onData(chunk);
    characteristic.subscribe((err) => {
      if (err) return reject(err);
      characteristic.on('data', handler);
      return resolve(() => {
        try { characteristic.removeListener('data', handler); } catch (_) {}
        try { characteristic.unsubscribe(() => {}); } catch (_) {}
      });
    });
  });
}

async function flushChannels(rxCtlChar, dataChar) {
  // Minimal drain of one pending frame if present; keep simple
  try {
    const lenBuf = await readCharacteristic(rxCtlChar);
    if (lenBuf && lenBuf.length >= 4) {
      const len = lenBuf.readUInt32BE(0);
      if (len > 0) {
        let drained = 0;
        const deadline = Date.now() + 1000;
        while (drained < len && Date.now() < deadline) {
          const chunk = await readCharacteristic(dataChar);
          const cLen = chunk ? chunk.length : 0;
          if (!cLen) break;
          drained += cLen;
        }
      }
    }
  } catch (_) {}
}

async function sendRpcAndReceive(peripheral, method, paramsObject) {
  await new Promise((resolve, reject) => {
    peripheral.connect((err) => (err ? reject(err) : resolve()));
  });

  try {
    // Verify connection is stable
    await sleep(500);
    
    const services = await new Promise((resolve, reject) => {
      peripheral.discoverServices([], (err, svcs) => (err ? reject(err) : resolve(svcs)));
    });

    console.log(`Found ${services.length} services total:`);
    services.forEach((service, i) => {
      console.log(`  Service ${i+1}: ${service.uuid}`);
    });

    // Find the Shelly service
    const shellyService = services.find(s => s.uuid.toLowerCase() === TARGET_SERVICE.toLowerCase());
    if (!shellyService) {
      throw new Error('Shelly service not found on device');
    }

    console.log(`Using Shelly service: ${shellyService.uuid}`);
    
    const characteristics = await new Promise((resolve, reject) => {
      shellyService.discoverCharacteristics([], (err, chars) => (err ? reject(err) : resolve(chars)));
    });

    console.log(`Found ${characteristics.length} characteristics`);
    characteristics.forEach((char, i) => {
      console.log(`  Characteristic ${i+1}: ${char.uuid}`);
    });

    const wanted = [UUID_DATA, UUID_TXCTL, UUID_RXCTL];
    const charMap = findCharsByUuid(characteristics, wanted);
    const dataChar = charMap.get(UUID_DATA);
    const txCtlChar = charMap.get(UUID_TXCTL);
    const rxCtlChar = charMap.get(UUID_RXCTL);

    console.log('Required characteristics found:', {
      dataChar: !!dataChar,
      txCtlChar: !!txCtlChar,
      rxCtlChar: !!rxCtlChar
    });

    if (!dataChar || !txCtlChar || !rxCtlChar) {
      throw new Error('One or more required characteristics were not found');
    }

    // Flush any stale frames before sending
    await flushChannels(rxCtlChar, dataChar);

    // Subscribe to RX control notifications to capture response length if device notifies
    let expectedLength = 0;
    let received = Buffer.alloc(0);
    const unsubscribeRxNotify = await subscribeNotifications(rxCtlChar, (buf) => {
      if (!buf || buf.length < 4) return;
      expectedLength = buf.readUInt32BE(0);
    });

    let requestObject = {
      // jsonrpc intentionally omitted; some devices expect id/src/method/params only
      id: Date.now(),
      src: 'user_1',
      method,
      params: paramsObject || {},
    };
    const requestJson = JSON.stringify(requestObject);
    const requestBytes = Buffer.from(requestJson, 'utf8');
    
    console.log(`Sending request: ${requestJson}`);
    console.log(`Request size: ${requestBytes.length} bytes`);

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(requestBytes.length, 0);
    
    console.log(`Writing length to TX_CTL: ${requestBytes.length} (0x${lenBuf.toString('hex')})`);
    await writeWithResponse(txCtlChar, lenBuf);
    // Per Shelly docs: wait ~1s after writing length before sending data
    await sleep(1000);

    // Chunk write to data characteristic (<= 20 bytes typical, override via env CHUNK)
    let MTU_CHUNK = 20
    console.log(`Writing request data in chunks:`);
    for (let offset = 0; offset < requestBytes.length; offset += MTU_CHUNK) {
      const chunk = requestBytes.slice(offset, offset + MTU_CHUNK);
      console.log(`  Chunk ${Math.floor(offset/MTU_CHUNK)+1}: ${chunk.length} bytes - "${chunk.toString('utf8')}"`);
      await writeWithResponse(dataChar, chunk);
      await sleep(15);
    }

    // Poll RX_CTL length as per docs (in addition to notifications)
    console.log('Reading response length from RX_CTL...');
    for (let i = 1; i <= 30 && expectedLength === 0; i++) {
      try {
        const lenBuf = await readCharacteristic(rxCtlChar);
        if (lenBuf && lenBuf.length >= 4) {
          expectedLength = lenBuf.readUInt32BE(0);
          console.log(`RX_CTL read ${i}: expecting ${expectedLength} bytes`);
          if (expectedLength > 0) break;
        }
      } catch (e) {
        console.log(`RX_CTL read ${i} failed: ${e?.message || e}`);
      }
      await sleep(250);
    }

    // If still no length, try one fallback resend with conservative settings
    if (expectedLength === 0 && received.length === 0) {
      console.log('No response length; retrying once with conservative settings (no jsonrpc, 20-byte chunks, writeWithoutResponse)...');

      // Re-subscribe clean
      expectedLength = 0;
      received = Buffer.alloc(0);

      // Build request again without jsonrpc (already omitted)
      requestObject = {
        id: Date.now(),
        src: 'user_1',
        method,
        params: paramsObject || {},
      };
      let reqJson = JSON.stringify(requestObject);
      let reqBytes = Buffer.from(reqJson, 'utf8');
      const lenBE = Buffer.alloc(4);
      lenBE.writeUInt32BE(reqBytes.length, 0);
      // Write length
      await writeWithResponse(txCtlChar, lenBE);
      await sleep(500);
      // Conservative chunk size
      MTU_CHUNK = 20;
      console.log(`Retry: writing request in ${Math.ceil(reqBytes.length/MTU_CHUNK)} chunks of ${MTU_CHUNK} bytes (without response)`);
      for (let off = 0; off < reqBytes.length; off += MTU_CHUNK) {
        const chunk = reqBytes.slice(off, off + MTU_CHUNK);
        await new Promise((resolve, reject) => dataChar.write(chunk, false, (err) => (err ? reject(err) : resolve())));
        await sleep(25);
      }
      // Wait up to 2s for RX length
      for (let i = 1; i <= 20 && expectedLength === 0; i++) {
        try {
          const lb = await readCharacteristic(rxCtlChar);
          if (lb && lb.length >= 4) {
            expectedLength = lb.readUInt32BE(0);
            console.log(`RX_CTL poll (retry) ${i}: expecting ${expectedLength} bytes`);
          }
        } catch (_) {}
        await sleep(100);
      }
    }

    // Read response data in chunks by actively reading the data characteristic
    const bestEffort = expectedLength === 0;
    console.log(
      bestEffort
        ? 'No length on RX_CTL; best-effort read from data characteristic for up to 5s...'
        : `Reading ${expectedLength} bytes from data characteristic...`
    );
    {
      const startedData = Date.now();
      const maxDurationMs = bestEffort ? 5000 : 20000;
      let attempts = 0;
      let consecutiveEmpty = 0;
      while (
        (!bestEffort && received.length < expectedLength) ||
        (bestEffort && Date.now() - startedData < maxDurationMs)
      ) {
        if (Date.now() - startedData > maxDurationMs) {
          break; // fall through to parse what we got
        }
        attempts += 1;
        try {
          const chunk = await readCharacteristic(dataChar);
          const chunkLen = chunk ? chunk.length : 0;
          if (chunkLen > 0) {
            received = Buffer.concat([received, chunk]);
            console.log(
              bestEffort
                ? `Read chunk ${attempts}: ${chunkLen} bytes (total: ${received.length})`
                : `Read chunk ${attempts}: ${chunkLen} bytes (total: ${received.length}/${expectedLength})`
            );
            consecutiveEmpty = 0;
          } else {
            consecutiveEmpty += 1;
            await sleep(Math.min(200 + consecutiveEmpty * 50, 500));
          }
        } catch (readErr) {
          console.log(`Read attempt ${attempts} failed: ${readErr?.message || readErr}`);
          await sleep(250);
        }
      }
    }

    // Done – stop notifications and parse JSON
    // Cleanup notification listener
    try { if (typeof unsubscribeRxNotify === 'function') unsubscribeRxNotify(); } catch (_) {}
    console.log(`Received complete response: ${received.length} bytes`);
    console.log(`Raw response (first 200 chars): ${received.toString('utf8').substring(0, 200)}`);
    
    const jsonText = received.toString('utf8');
    if (!jsonText.trim()) {
      throw new Error('Received empty response');
    }
    
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (jsonErr) {
      console.error('JSON parse error. Full response text:');
      console.error(JSON.stringify(jsonText));
      throw new Error(`Failed to parse JSON response: ${jsonErr.message}`);
    }
    return parsed;
  } finally {
    try { peripheral.disconnect(); } catch (_) {}
  }
}

async function promptUserSelection(devices) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    console.log('\nAvailable Shelly devices:');
    devices.forEach((device, index) => {
      console.log(`  ${index + 1}. ${device.name} [${device.address}] (RSSI: ${device.rssi})`);
    });
    console.log(`  ${devices.length + 1}. Enter custom address`);
    
    rl.question('\nSelect device (enter number): ', (answer) => {
      const choice = parseInt(answer.trim());
      rl.close();
      
      if (choice >= 1 && choice <= devices.length) {
        resolve(devices[choice - 1].peripheral);
      } else if (choice === devices.length + 1) {
        // Custom address flow
        const rl2 = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        rl2.question('Enter device address (e.g., AA:BB:CC:DD:EE:FF): ', (customAddress) => {
          rl2.close();
          resolve({ customAddress: customAddress.trim() });
        });
      } else {
        console.log('Invalid selection, using first device');
        resolve(devices[0]?.peripheral || null);
      }
    });
  });
}

function createPrompt() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise((resolve) => rl.question(q, (ans) => resolve(ans)));
  const close = () => rl.close();
  return { question, close };
}

async function main() {
  const { address, name, method: methodArg, params: paramsArg, scan } = parseArgs(process.argv);
  let initialMethod = methodArg || process.env.METHOD || '';
  let initialParamsObject = paramsArg ? tryParseJson(paramsArg) : null;
  if (initialMethod) {
    console.log(`Method: ${initialMethod}`);
    if (initialParamsObject) console.log('With params:', initialParamsObject);
  }

  await new Promise((resolve) => {
    noble.once('stateChange', (state) => {
      if (state !== 'poweredOn') {
        throw new Error(`Bluetooth adapter not powered on (state: ${state})`);
      }
      resolve();
    });
  });

  let peripheral;

  if (scan || (!address && !name)) {
    // Scan for devices and let user select
    console.log('Scanning for Shelly devices...');
    const devices = await scanForDevices(15000);
    
    if (devices.length === 0) {
      throw new Error('No Shelly devices found');
    }
    
    const selection = await promptUserSelection(devices);
    
    if (selection.customAddress) {
      // Use custom address
      peripheral = await discoverShelly({ address: selection.customAddress });
    } else {
      peripheral = selection;
    }
  } else {
    // Use specified address/name
    if (address) console.log(`Looking for device with address ${address}`);
    if (name) console.log(`Looking for device with name ${name}`);
    peripheral = await discoverShelly({ address, name });
  }

  console.log(`Connecting to: ${peripheral.advertisement?.localName || '(no name)'} [${peripheral.address || peripheral.id}]`);

  // Interactive loop: if no method provided, prompt; after each response, prompt again
  const prompt = createPrompt();
  let requestedExit = false;
  try {
    let currentMethod = initialMethod;
    let currentParams = initialParamsObject;
    while (true) {
      if (!currentMethod) {
        const m = await prompt.question('Enter RPC method. E.g. Shelly.ListMethods. (empty to exit): ');
        currentMethod = (m || '').trim();
        if (!currentMethod) { requestedExit = true; break; }
        const p = await prompt.question('Enter params JSON (optional, default {}): ');
        currentParams = p && p.trim() ? tryParseJson(p) : {};
      }

      try {
        const response = await sendRpcAndReceive(peripheral, currentMethod, currentParams || {});
        console.log('RPC response:');
        console.log(JSON.stringify(response, null, 2));
      } catch (err) {
        console.error('Error:', err.message || err);
      }

      // Ask for next method
      const next = await prompt.question('Next RPC method. E.g. Shelly.ListMethods. (empty to exit): ');
      if (!next || !next.trim()) { requestedExit = true; break; }
      currentMethod = next.trim();
      const nextParams = await prompt.question('Params JSON (optional, default {}): ');
      currentParams = nextParams && nextParams.trim() ? tryParseJson(nextParams) : {};
    }
  } finally {
    try { prompt.close(); } catch (_) {}
    try { noble.stopScanning(); } catch (_) {}
    if (requestedExit) process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


