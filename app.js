import {
  DeviceP24,
  WebSerialTransport,
  WebUsbCdcAcmTransport,
  MidLevelChannelConfiguration,
  ChannelPoint,
} from "./src/index.js";

const CHANNEL_COUNT = 8;
const DEFAULT_CHANNEL = () => ({ enabled: false, current: 0, pulseWidth: 300, period: 50 });

function createDefaultChannels() {
  return Array.from({ length: CHANNEL_COUNT }, () => ({
    enabled: false,
    current: 0,
    pulseWidth: 300,
    period: 50,
  }));
}

const state = {
  connected: false,
  mock: false,
  transportType: "auto",
  device: null,
  transport: null,
  activeChannel: 0,
  initialized: false,
  channels: createDefaultChannels(),
};

const $ = (id) => document.getElementById(id);
const el = {
  connectBtn: $("connectBtn"),
  disconnectBtn: $("disconnectBtn"),
  serialBtn: $("serialBtn"),
  versionBtn: $("versionBtn"),
  initBtn: $("initBtn"),
  updateBtn: $("updateBtn"),
  stopBtn: $("stopBtn"),
  mockMode: $("mockMode"),
  transportMode: $("transportMode"),
  diag: $("diag"),
  armStimulation: $("armStimulation"),
  serialOut: $("serialOut"),
  versionOut: $("versionOut"),
  status: $("connectionStatus"),
  dot: $("connectionDot"),
  log: $("log"),
  tabs: $("channelTabs"),
  channelEnable: $("channelEnable"),
  currentSlider: $("currentSlider"),
  pulseWidthSlider: $("pulseWidthSlider"),
  periodSlider: $("periodSlider"),
  currentValue: $("currentValue"),
  pulseWidthValue: $("pulseWidthValue"),
  periodValue: $("periodValue"),
  serialSupportHint: $("serialSupportHint"),
  helpBtn: $("helpBtn"),
  helpDialog: $("helpDialog"),
  closeHelpBtn: $("closeHelpBtn"),
};



function transportLabel(type) {
  if (type === "webserial") return "WebSerial";
  if (type === "webusb") return "WebUSB CDC/ACM";
  return "Auto";
}

function isProbablyAndroid() {
  return /Android/i.test(navigator.userAgent || "");
}

function updateDiagnostics(extra = {}) {
  if (!el.diag) return;
  const data = {
    "Secure context": String(window.isSecureContext),
    "WebUSB available": String("usb" in navigator),
    "WebSerial available": String("serial" in navigator),
    "Selected transport": el.transportMode?.value || "auto",
    "Active transport": state.connected ? transportLabel(state.transportType) : "—",
    "User agent": navigator.userAgent,
    ...extra,
  };
  el.diag.innerHTML = Object.entries(data).map(([key, value]) =>
    `<span class="diag-key">${escapeHtml(key)}</span><span class="diag-value">${escapeHtml(value)}</span>`
  ).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch]));
}

function preferredTransportOrder(mode) {
  if (mode === "webserial") return ["webserial"];
  if (mode === "webusb") return ["webusb"];
  // Desktop: use native WebSerial first. Android: use WebUSB CDC/ACM first.
  return isProbablyAndroid() ? ["webusb", "webserial"] : ["webserial", "webusb"];
}

function log(message, type = "info") {
  const time = new Date().toLocaleTimeString();
  el.log.textContent += `[${time}] ${type.toUpperCase()}: ${message}\n`;
  el.log.scrollTop = el.log.scrollHeight;
}

function setConnected(connected) {
  state.connected = connected;
  el.status.textContent = connected ? (state.mock ? "Connected to mock device" : `Connected via ${transportLabel(state.transportType)}`) : "Disconnected";
  updateDiagnostics();
  el.dot.classList.toggle("connected", connected);
  el.connectBtn.disabled = connected;
  el.disconnectBtn.disabled = !connected;
  el.serialBtn.disabled = !connected;
  el.versionBtn.disabled = !connected;
  el.initBtn.disabled = !connected;
  el.updateBtn.disabled = !connected;
  el.stopBtn.disabled = !connected;
}

function createTabs() {
  el.tabs.innerHTML = "";
  for (let i = 0; i < CHANNEL_COUNT; i += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.role = "tab";
    button.textContent = `Ch ${i + 1}`;
    button.title = `Channel ${i + 1}`;
    button.setAttribute("aria-label", `Channel ${i + 1}`);
    button.addEventListener("click", () => selectChannel(i));
    el.tabs.appendChild(button);
  }
}

function selectChannel(index) {
  saveCurrentChannelValues();
  state.activeChannel = index;
  loadChannelValues(index);
  [...el.tabs.children].forEach((tab, i) => {
    const active = i === index;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function loadChannelValues(index) {
  const c = state.channels[index];
  el.channelEnable.checked = c.enabled;
  el.currentSlider.value = c.current;
  el.pulseWidthSlider.value = c.pulseWidth;
  el.periodSlider.value = c.period;
  updateSliderLabels();
}

function saveCurrentChannelValues() {
  const c = state.channels[state.activeChannel];
  c.enabled = el.channelEnable.checked;
  c.current = Number(el.currentSlider.value);
  c.pulseWidth = Number(el.pulseWidthSlider.value);
  c.period = Number(el.periodSlider.value);
}

function handleChannelInput() {
  saveCurrentChannelValues();
  updateSliderLabels();
}

function updateSliderLabels() {
  const c = state.channels[state.activeChannel];
  el.currentValue.textContent = `${c.current} mA`;
  el.pulseWidthValue.textContent = `${c.pulseWidth} µs`;
  el.periodValue.textContent = `${c.period} ms`;
}

function buildPulseShape(c) {
  const current = Number(c.current);
  const pulseWidth = Number(c.pulseWidth);
  const periodUs = Number(c.period) * 1000;
  const pulseShapeUs = pulseWidth + 100 + pulseWidth;

  if (pulseShapeUs > periodUs) {
    throw new Error(
      `Pulse shape too long for pulse repetition period: ${pulseShapeUs} µs > ${periodUs} µs. ` +
      `Increase PRP or reduce pulse width.`
    );
  }

  return [
    // Positive phase: selected current and selected pulse width.
    new ChannelPoint(pulseWidth, current),
    // Interphase pause: fixed 100 µs at 0 mA.
    new ChannelPoint(100, 0),
    // Negative phase: same absolute current and selected pulse width.
    new ChannelPoint(pulseWidth, -current),
  ];
}

function buildMidLevelConfigurations() {
  saveCurrentChannelValues();
  return state.channels.map((c) => {
    if (!c.enabled) return null;
    return new MidLevelChannelConfiguration({
      isActive: true,
      ramp: 0,
      periodMs: c.period,
      points: buildPulseShape(c),
    });
  });
}

function assertRealStimulationAllowed(action) {
  if (!state.mock && !el.armStimulation.checked) {
    throw new Error(`${action} blocked. Enable real stimulation commands first.`);
  }
}

class MockDevice {
  constructor() {
    this.general = {
      getDeviceId: async () => "SN-2400187",
      getVersion: async () => ({ firmwareVersion: "v1.8.3", scienceModeVersion: "SM4 mock", rawText: "v1.8.3" }),
    };
    this.mid = {
      init: async () => ({ resultError: 0 }),
      update: async (configs) => ({ resultError: 0, activeChannels: configs.filter(Boolean).length }),
      stop: async () => ({ resultError: 0 }),
    };
  }
  async initialize() {}
  getLayerGeneral() { return this.general; }
  getLayerMidLevel() { return this.mid; }
}

async function connect() {
  state.mock = el.mockMode.checked;
  const selectedMode = el.transportMode.value;
  const errors = [];

  try {
    if (state.mock) {
      state.transportType = "mock";
      state.device = new MockDevice();
      state.transport = null;
      await state.device.initialize();
      setConnected(true);
      log("Mock device connected");
      return;
    }

    for (const mode of preferredTransportOrder(selectedMode)) {
      try {
        if (mode === "webserial") {
          if (!WebSerialTransport.isSupported()) throw new Error("WebSerial not available");
          state.transportType = "webserial";
          state.transport = new WebSerialTransport({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
          state.device = new DeviceP24(state.transport, { debug: true });
          log("Opening WebSerial device picker...");
          await state.transport.requestPort([{ usbVendorId: 0x0483, usbProductId: 0x5740 }]);
          await state.transport.open();
          await state.device.initialize();
          setConnected(true);
          log("Device connected via WebSerial");
          return;
        }

        if (mode === "webusb") {
          if (!WebUsbCdcAcmTransport.isSupported()) throw new Error("WebUSB not available");
          state.transportType = "webusb";
          state.transport = new WebUsbCdcAcmTransport({
            baudRate: 115200,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            filters: [
              { vendorId: 0x0483, productId: 0x5740 },
              { vendorId: 0x0483 },
              { classCode: 0x02 },
              { classCode: 0x0a },
            ],
          });
          state.device = new DeviceP24(state.transport, { debug: true });
          log("Opening WebUSB device picker...");
          const usbDevice = await state.transport.requestDevice();
          log(`Selected USB device: VID 0x${usbDevice.vendorId.toString(16)} PID 0x${usbDevice.productId.toString(16)}`);
          await state.transport.open();
          updateDiagnostics({ "USB interface": state.transport.describeInterface() });
          await state.device.initialize();
          setConnected(true);
          log("Device connected via WebUSB CDC/ACM");
          return;
        }
      } catch (error) {
        errors.push(`${transportLabel(mode)}: ${error.message}`);
        log(`${transportLabel(mode)} failed: ${error.message}`, "error");
        try { if (state.transport) await state.transport.close(); } catch {}
        state.transport = null;
        state.device = null;
      }
    }

    throw new Error(errors.join(" | ") || "No supported transport available.");
  } catch (error) {
    log(error.message, "error");
    await disconnect(true);
  }
}

async function disconnect(silent = false) {
  try {
    if (state.device?.getLayerMidLevel && state.connected && state.initialized) {
      try { await state.device.getLayerMidLevel().stop(); } catch {}
    }
    if (state.transport) await state.transport.close();
  } catch (error) {
    if (!silent) log(error.message, "error");
  } finally {
    state.device = null;
    state.transport = null;
    state.initialized = false;
    setConnected(false);
    if (!silent) log("Disconnected");
  }
}

async function readSerialNumber() {
  try {
    const id = await state.device.getLayerGeneral().getDeviceId();
    el.serialOut.textContent = id || "—";
    log(`Serial number: ${id}`);
  } catch (error) { log(error.message, "error"); }
}

async function readVersion() {
  try {
    const version = await state.device.getLayerGeneral().getVersion();
    const text = [version.firmwareVersion, version.scienceModeVersion].filter(Boolean).join(" / ") || version.rawText || "—";
    el.versionOut.textContent = text;
    log(`Version: ${text}`);
  } catch (error) { log(error.message, "error"); }
}

async function initMidLevel() {
  try {
    assertRealStimulationAllowed("Init");
    await state.device.getLayerMidLevel().init(true);
    state.initialized = true;
    log("Mid-level initialized");
  } catch (error) { log(error.message, "error"); }
}

async function updateMidLevel() {
  try {
    assertRealStimulationAllowed("Update");
    if (!state.initialized) await initMidLevel();
    const configs = buildMidLevelConfigurations();
    const active = configs.filter(Boolean).length;
    await state.device.getLayerMidLevel().update(configs);
    log(`Mid-level update sent (${active} active channel${active === 1 ? "" : "s"})`);
  } catch (error) { log(error.message, "error"); }
}

async function stopMidLevel() {
  try {
    await state.device.getLayerMidLevel().stop();
    state.initialized = false;
    log("Mid-level stopped");
  } catch (error) { log(error.message, "error"); }
}

function updateSupportHint() {
  const serial = WebSerialTransport.isSupported();
  const usb = WebUsbCdcAcmTransport.isSupported();
  if (serial && usb) {
    el.serialSupportHint.textContent = "Desktop: prefer WebSerial. Android: prefer WebUSB CDC/ACM.";
  } else if (usb) {
    el.serialSupportHint.textContent = "Connect STM32 CDC device via WebUSB CDC/ACM.";
  } else if (serial) {
    el.serialSupportHint.textContent = "Connect device via WebSerial.";
  } else {
    el.serialSupportHint.textContent = "WebUSB/WebSerial not available here. Mock mode still works.";
  }
  if (el.transportMode) el.transportMode.value = isProbablyAndroid() ? "webusb" : "webserial";
  updateDiagnostics();
}

function installButtonFeedback() {
  document.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      button.classList.remove("pressed-once");
      void button.offsetWidth;
      button.classList.add("pressed-once");
      window.setTimeout(() => button.classList.remove("pressed-once"), 180);
    });
  });
}

function initUi() {
  state.mock = false;
  state.channels = createDefaultChannels();
  el.mockMode.checked = false;
  if (el.transportMode) el.transportMode.value = isProbablyAndroid() ? "webusb" : "webserial";
  el.armStimulation.checked = false;
  el.channelEnable.checked = false;
  el.currentSlider.value = 0;
  createTabs();
  selectChannel(0);
  setConnected(false);
  updateSupportHint();
  [el.currentSlider, el.pulseWidthSlider, el.periodSlider].forEach((slider) => slider.addEventListener("input", handleChannelInput));
  el.channelEnable.addEventListener("change", handleChannelInput);
  el.connectBtn.addEventListener("click", connect);
  el.transportMode.addEventListener("change", () => updateDiagnostics());
  el.disconnectBtn.addEventListener("click", () => disconnect(false));
  el.serialBtn.addEventListener("click", readSerialNumber);
  el.versionBtn.addEventListener("click", readVersion);
  el.initBtn.addEventListener("click", initMidLevel);
  el.updateBtn.addEventListener("click", updateMidLevel);
  el.stopBtn.addEventListener("click", stopMidLevel);
  el.helpBtn.addEventListener("click", () => el.helpDialog.showModal());
  el.closeHelpBtn.addEventListener("click", () => el.helpDialog.close());
  installButtonFeedback();
  window.addEventListener("beforeunload", () => { if (state.transport) state.transport.close(); });
  log("Ready");
}

initUi();
