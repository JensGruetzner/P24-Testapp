/*
 * ScienceMode4 JavaScript core implementation.
 *
 * This is a port of the core protocol concepts from ScienceMode4Python:
 * - Protocol start byte 0xF0, stop byte 0x0F
 * - byte stuffing using 0x81 and XOR key 0x55
 * - CRC16-XMODEM over stuffed payload bytes
 * - 10-bit command + 6-bit packet number prefix
 * - General layer: getDeviceId(), getVersion(), getStimStatus(), reset()
 * - Low-level layer: init(), stop(), sendChannelConfig()
 *
 * The code is intentionally transport-agnostic. Use WebSerialTransport in the
 * browser or NodeSerialTransport in Electron/Node.
 */

export class ScienceModeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ScienceModeError";
    this.details = details;
  }
}

export class ScienceModeTimeoutError extends ScienceModeError {
  constructor(message, details) {
    super(message, details);
    this.name = "ScienceModeTimeoutError";
  }
}

export const Commands = Object.freeze({
  UNDEFINED: -1,
  LOW_LEVEL_INIT: 0,
  LOW_LEVEL_INIT_ACK: 1,
  LOW_LEVEL_CHANNEL_CONFIG: 2,
  LOW_LEVEL_CHANNEL_CONFIG_ACK: 3,
  LOW_LEVEL_STOP: 4,
  LOW_LEVEL_STOP_ACK: 5,
  MID_LEVEL_INIT: 30,
  MID_LEVEL_INIT_ACK: 31,
  MID_LEVEL_UPDATE: 32,
  MID_LEVEL_UPDATE_ACK: 33,
  MID_LEVEL_STOP: 34,
  MID_LEVEL_STOP_ACK: 35,
  MID_LEVEL_GET_CURRENT_DATA: 36,
  MID_LEVEL_GET_CURRENT_DATA_ACK: 37,
  GET_DEVICE_ID: 52,
  GET_DEVICE_ID_ACK: 53,
  RESET: 58,
  RESET_ACK: 59,
  GET_STIM_STATUS: 62,
  GET_STIM_STATUS_ACK: 63,
  GENERAL_ERROR: 66,
  UNKNOWN_COMMAND: 67,
  GET_EXTENDED_VERSION: 68,
  GET_EXTENDED_VERSION_ACK: 69,
  DL_INIT: 100,
  DL_INIT_ACK: 101,
  DL_START: 102,
  DL_START_ACK: 103,
  DL_STOP: 104,
  DL_STOP_ACK: 105,
  DL_SEND_LIVE_DATA: 106,
  DL_SEND_FILE: 107,
  DL_MMI: 108,
  DL_GET: 109,
  DL_GET_ACK: 110,
  DL_POWER_MODULE: 111,
  DL_POWER_MODULE_ACK: 112,
  DL_SEND_FILE_ACK: 113,
  DL_SYS: 114,
  DL_SYS_ACK: 115,
});

export const Channel = Object.freeze({ RED: 0, BLUE: 1, BLACK: 2, WHITE: 3 });
export const Connector = Object.freeze({ YELLOW: 0, GREEN: 1 });
export const LowLevelMode = Object.freeze({
  NO_MEASUREMENT: 0,
  STIM_CURRENT: 1,
  STIM_VOLTAGE: 2,
  HIGH_VOLTAGE_SOURCE: 3,
});
export const LowLevelHighVoltageSource = Object.freeze({ STANDARD: 0, OFF: 1 });
export const StimStatus = Object.freeze({
  NO_LEVEL_INITIALIZED: 0,
  LOW_LEVEL_INITIALIZED: 1,
  MID_LEVEL_INITIALIZED: 2,
  MID_LEVEL_RUNNING: 3,
});
export const ResultAndError = Object.freeze({
  NO_ERROR: 0,
  TRANSFER_ERROR: 1,
  PARAMETER_ERROR: 2,
  PROTOCOL_ERROR: 3,
  UC_STIM_TIMEOUT_ERROR: 4,
  EMG_TIMEOUT_ERROR: 5,
  EMG_REGISTER_ERROR: 6,
  NOT_INITIALIZED: 7,
  HV_ERROR: 8,
  DEMUX_TIMEOUT_ERROR: 9,
  ELECTRODE_ERROR: 10,
  INVALID_CMD_ERROR: 11,
  DEMUX_PARAMETER_ERROR: 12,
  DEMUX_NOT_INITIALIZED_ERROR: 13,
  DEMUX_TRANSFER_ERROR: 14,
  DEMUX_UNKNOWN_ACK_ERROR: 15,
  PULSE_TIMEOUT_ERROR: 16,
  FUEL_GAUGE_ERROR: 17,
  LIVE_SIGNAL_ERROR: 18,
  FILE_TRANSMISSION_TIMEOUT: 19,
  FILE_NOT_FOUND: 20,
  BUSY: 21,
  FILE_ERROR: 22,
  FLASH_ERASE_ERROR: 23,
  FLASH_WRITE_ERROR: 24,
  UNKNOWN_CONTROLLER_ERROR: 25,
  FIRMWARE_TOO_LARGE_ERROR: 26,
  FUEL_GAUGE_NOT_PROGRAMMED: 27,
  PULSE_LOW_CURRENT_ERROR: 28,
});

const RESULT_NAMES = Object.fromEntries(Object.entries(ResultAndError).map(([k, v]) => [v, k]));
const COMMAND_NAMES = Object.fromEntries(Object.entries(Commands).map(([k, v]) => [v, k]));

export function resultName(value) { return RESULT_NAMES[value] ?? `UNKNOWN_${value}`; }
export function commandName(value) { return COMMAND_NAMES[value] ?? `UNKNOWN_${value}`; }

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

export function ascii(bytes) {
  return new TextDecoder("ascii").decode(bytes).replace(/\0+$/g, "");
}

function ensureByte(value) { return value & 0xFF; }

export class ByteBuilder {
  constructor() { this.bits = []; }
  setBitToPosition(value, bitPosition, bitCount) {
    const newLength = Math.max(this.bits.length, bitPosition + bitCount);
    while (this.bits.length < newLength) this.bits.push(0);
    for (let i = 0; i < bitCount; i += 1) this.bits[bitPosition + i] = (value >> i) & 1;
  }
  getBitFromPosition(bitPosition, bitCount) {
    let result = 0;
    for (let i = 0; i < bitCount; i += 1) result |= (this.bits[bitPosition + i] ?? 0) << i;
    return result >>> 0;
  }
  appendByte(value) {
    const start = this.bits.length;
    for (let i = 0; i < 8; i += 1) this.bits[start + i] = (value >> i) & 1;
  }
  appendBytes(bytes) { for (const b of bytes) this.appendByte(b); }
  swap(start, count) {
    const data = this.getBytes();
    for (let i = 0; i < count; i += 1) this.setBitToPosition(data[start + i] ?? 0, (start + count - i - 1) * 8, 8);
  }
  getBytes() {
    const result = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let byteIndex = 0; byteIndex < result.length; byteIndex += 1) {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) value |= (this.bits[byteIndex * 8 + bit] ?? 0) << bit;
      result[byteIndex] = value;
    }
    return result;
  }
}

export function crc16Xmodem(data, crc = 0) {
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

export class Protocol {
  static START_BYTE = 0xF0;
  static STOP_BYTE = 0x0F;
  static STUFFING_BYTE = 0x81;
  static STUFFING_KEY = 0x55;

  static stuffByte(byte) { return new Uint8Array([Protocol.STUFFING_BYTE, Protocol.STUFFING_KEY ^ ensureByte(byte)]); }

  static stuff(data) {
    const out = [];
    for (const b of data) {
      if (b === Protocol.START_BYTE || b === Protocol.STOP_BYTE || b === Protocol.STUFFING_BYTE) out.push(...Protocol.stuffByte(b));
      else out.push(b);
    }
    return new Uint8Array(out);
  }

  static unstuffByte(byte) { return Protocol.STUFFING_KEY ^ ensureByte(byte); }

  static unstuff(data) {
    const out = [];
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] === Protocol.STUFFING_BYTE) {
        i += 1;
        if (i >= data.length) throw new ScienceModeError("Dangling stuffing byte");
        out.push(Protocol.unstuffByte(data[i]));
      } else out.push(data[i]);
    }
    return new Uint8Array(out);
  }

  static packetToBytes(packet) {
    const bb = new ByteBuilder();
    bb.setBitToPosition(packet.command, 0, 10);
    bb.setBitToPosition(packet.number, 10, 6);
    bb.swap(0, 2);
    bb.appendBytes(packet.getData());

    const stuffedPacketData = Protocol.stuff(bb.getBytes());
    const packetLength = stuffedPacketData.length + 10;
    const crc = crc16Xmodem(stuffedPacketData);

    const result = [];
    result.push(Protocol.START_BYTE);
    result.push(...Protocol.stuffByte(packetLength >> 8));
    result.push(...Protocol.stuffByte(packetLength));
    result.push(...Protocol.stuffByte(crc >> 8));
    result.push(...Protocol.stuffByte(crc));
    result.push(...stuffedPacketData);
    result.push(Protocol.STOP_BYTE);
    return new Uint8Array(result);
  }

  static isValidPacketData(buffer) {
    if (buffer.length <= 10) return false;
    if (buffer[0] !== Protocol.START_BYTE || buffer[buffer.length - 1] !== Protocol.STOP_BYTE) return false;
    const crc = (Protocol.unstuffByte(buffer[6]) << 8) | Protocol.unstuffByte(buffer[8]);
    return crc === crc16Xmodem(buffer.slice(9, -1));
  }

  static findPacketInBuffer(buffer) {
    let start = 0;
    while (true) {
      start = indexOfSequence(buffer, new Uint8Array([Protocol.START_BYTE, Protocol.STUFFING_BYTE]), start);
      if (start === -1) return null;
      const stop = buffer.indexOf(Protocol.STOP_BYTE, start + 12);
      if (stop === -1) return null;
      const candidate = buffer.slice(start, stop + 1);
      if (Protocol.isValidPacketData(candidate)) return [start, stop];
      start = stop;
    }
  }

  static extractPacketData(buffer) {
    const bb = new ByteBuilder();
    let commandPrefixCount = 0;
    for (let i = 0; i < 2; i += 1) {
      if (buffer[9 + commandPrefixCount] === Protocol.STUFFING_BYTE) commandPrefixCount += 2;
      else commandPrefixCount += 1;
    }
    bb.appendBytes(Protocol.unstuff(buffer.slice(9, 9 + commandPrefixCount)));
    bb.swap(0, 2);
    const command = bb.getBitFromPosition(0, 10);
    const number = bb.getBitFromPosition(10, 6);
    const payload = Protocol.unstuff(buffer.slice(9 + commandPrefixCount, -1));
    return { command, number, payload };
  }
}

function indexOfSequence(buffer, sequence, fromIndex = 0) {
  outer: for (let i = fromIndex; i <= buffer.length - sequence.length; i += 1) {
    for (let j = 0; j < sequence.length; j += 1) if (buffer[i + j] !== sequence[j]) continue outer;
    return i;
  }
  return -1;
}

export class Packet {
  constructor(command, getData = () => new Uint8Array()) {
    this.command = command;
    this.number = 0;
    this.getData = getData;
  }
}

export class PacketNumberGenerator {
  constructor() { this.next = 0; }
  getNextNumber() {
    const result = this.next;
    this.next = (this.next + 1) & 0x3F;
    return result;
  }
}

export class PacketBuffer {
  constructor(transport, debug = false) {
    this.transport = transport;
    this.debug = debug;
    this.buffer = new Uint8Array();
    this.waiters = [];
    this.unhandledPackets = [];
    this.transport.onBytes = (bytes) => this.handleBytes(bytes);
  }

  clear() { this.buffer = new Uint8Array(); }

  handleBytes(bytes) {
    this.buffer = concatBytes(this.buffer, bytes);
    while (true) {
      const startStop = Protocol.findPacketInBuffer(this.buffer);
      if (!startStop) return;
      const [start, stop] = startStop;
      const raw = this.buffer.slice(start, stop + 1);
      this.buffer = this.buffer.slice(stop + 1);
      const packet = { ...Protocol.extractPacketData(raw), raw };
      if (this.debug) console.debug("SM4 RX", commandName(packet.command), packet.number, bytesToHex(raw));
      this.dispatch(packet);
    }
  }

  dispatch(packet) {
    const idx = this.waiters.findIndex((w) => w.command === packet.command && w.number === packet.number);
    if (idx >= 0) {
      const [waiter] = this.waiters.splice(idx, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(packet);
      return;
    }
    this.unhandledPackets.push(packet);
  }

  waitFor(command, number, timeoutMs) {
    const already = this.unhandledPackets.findIndex((p) => p.command === command && p.number === number);
    if (already >= 0) return Promise.resolve(this.unhandledPackets.splice(already, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { command, number, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new ScienceModeTimeoutError(`No valid answer for command ${commandName(command)} (${command})`, { command, number }));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  getPacketFromBuffer() { return this.unhandledPackets.shift() ?? null; }
}

export class LayerBase {
  constructor(packetBuffer, packetNumberGenerator, debug = false) {
    this.packetBuffer = packetBuffer;
    this.packetNumberGenerator = packetNumberGenerator;
    this.debug = debug;
  }

  async sendPacket(packet) {
    packet.number = this.packetNumberGenerator.getNextNumber();
    const bytes = Protocol.packetToBytes(packet);
    if (this.debug) console.debug("SM4 TX", commandName(packet.command), packet.number, bytesToHex(bytes));
    await this.packetBuffer.transport.write(bytes);
    return packet;
  }

  async sendPacketAndWait(packet, timeoutMs = 5000) {
    await this.sendPacket(packet);
    const ackCommand = packet.command + 1;
    const ack = await this.packetBuffer.waitFor(ackCommand, packet.number, timeoutMs);
    if (ack.command === Commands.GENERAL_ERROR) throw new ScienceModeError("General error packet", ack);
    if (ack.command === Commands.UNKNOWN_COMMAND) throw new ScienceModeError("Unknown command packet", ack);
    return ack;
  }

  checkResultError(value, packetName) {
    if (value !== ResultAndError.NO_ERROR) throw new ScienceModeError(`Error ${packetName}: ${resultName(value)}`, { value });
  }
}

export class GeneralLayer extends LayerBase {
  constructor(...args) {
    super(...args);
    this.deviceId = null;
    this.firmwareVersion = null;
    this.scienceModeVersion = null;
  }

  async initialize() {
    await this.getDeviceId();
    await this.getVersion();
  }

  async getDeviceId() {
    const ack = await this.sendPacketAndWait(new Packet(Commands.GET_DEVICE_ID), 5000);
    const parsed = parseGetDeviceIdAck(ack.payload);
    this.checkResultError(parsed.resultError, "GetDeviceId");
    this.deviceId = parsed.deviceId;
    return this.deviceId;
  }

  async getStimStatus() {
    const ack = await this.sendPacketAndWait(new Packet(Commands.GET_STIM_STATUS), 5000);
    if (!ack.payload?.length) throw new ScienceModeError("Empty get stim status response");
    return parseGetStimStatusAck(ack.payload);
  }

  async getVersion() {
    const ack = await this.sendPacketAndWait(new Packet(Commands.GET_EXTENDED_VERSION), 5000);
    const parsed = parseGetExtendedVersionAck(ack.payload);
    this.firmwareVersion = parsed.firmwareVersion;
    this.scienceModeVersion = parsed.scienceModeVersion;
    return parsed;
  }

  async reset() {
    const ack = await this.sendPacketAndWait(new Packet(Commands.RESET), 5000);
    const resultError = ack.payload?.[0] ?? ResultAndError.NO_ERROR;
    this.checkResultError(resultError, "Reset");
  }
}

function parseGetDeviceIdAck(payload) {
  // Python implementation exposes result_error and device_id. In the protocol,
  // the first byte is the ResultAndError and the following bytes are ASCII.
  return { resultError: payload[0] ?? 0, deviceId: ascii(payload.slice(1)) };
}

function parseGetStimStatusAck(payload) {
  // Conservative parser for the Python behavior: successful + stim_status + high_voltage_on.
  // Devices seen with this protocol encode successful as result/error in byte 0.
  const successful = (payload[0] ?? 0) === 0;
  if (!successful) throw new ScienceModeError("Error get stim status", { payload });
  return { successful, stimStatus: payload[1] ?? 0, highVoltageOn: Boolean(payload[2] ?? 0) };
}

function parseGetExtendedVersionAck(payload) {
  // The exact Python ack class contains more fields. This parser supports common
  // zero-terminated ASCII fields after result byte. Adjust here if your firmware
  // defines fixed field sizes.
  const resultError = payload[0] ?? 0;
  if (resultError !== ResultAndError.NO_ERROR) throw new ScienceModeError("Error get extended version", { resultError });
  const text = ascii(payload.slice(1));
  const parts = text.split(/\0+/).filter(Boolean);
  return {
    firmwareVersion: parts[0] ?? text,
    scienceModeVersion: parts[1] ?? "",
    rawText: text,
    rawPayload: payload,
  };
}

export class ChannelPoint {
  constructor(durationMicroseconds, currentMilliampere) {
    this.durationMicroseconds = durationMicroseconds;
    this.currentMilliampere = currentMilliampere;
  }
  getData() {
    if (this.currentMilliampere < -150.0 || this.currentMilliampere > 150.0) {
      throw new RangeError(`Channel point current must be between -150 and 150 mA: ${this.currentMilliampere}`);
    }
    if (this.durationMicroseconds < 0 || this.durationMicroseconds > 4095) {
      throw new RangeError(`Channel point duration must be between 0 and 4095 us: ${this.durationMicroseconds}`);
    }
    const c = Math.round(2.0 * this.currentMilliampere + 300.0);
    const bb = new ByteBuilder();
    bb.setBitToPosition(0, 0, 10);
    bb.setBitToPosition(c, 10, 10);
    bb.setBitToPosition(this.durationMicroseconds, 20, 12);
    bb.swap(0, 4);
    return bb.getBytes();
  }
}

export class LowLevelLayer extends LayerBase {
  async init(mode = LowLevelMode.NO_MEASUREMENT, highVoltageSource = LowLevelHighVoltageSource.STANDARD) {
    const packet = new Packet(Commands.LOW_LEVEL_INIT, () => {
      const bb = new ByteBuilder();
      bb.setBitToPosition(0, 0, 1);
      bb.setBitToPosition(highVoltageSource, 1, 3);
      bb.setBitToPosition(mode, 4, 3);
      bb.setBitToPosition(0, 7, 0);
      return bb.getBytes();
    });
    const ack = await this.sendPacketAndWait(packet, 5000);
    const resultError = ack.payload?.[0] ?? 0;
    this.checkResultError(resultError, "LowLevelInit");
  }

  async stop() {
    const ack = await this.sendPacketAndWait(new Packet(Commands.LOW_LEVEL_STOP), 5000);
    const resultError = ack.payload?.[0] ?? 0;
    this.checkResultError(resultError, "LowLevelStop");
  }

  async sendInit(mode = LowLevelMode.NO_MEASUREMENT, highVoltageSource = LowLevelHighVoltageSource.STANDARD) {
    const packet = new Packet(Commands.LOW_LEVEL_INIT, () => {
      const bb = new ByteBuilder();
      bb.setBitToPosition(0, 0, 1);
      bb.setBitToPosition(highVoltageSource, 1, 3);
      bb.setBitToPosition(mode, 4, 3);
      return bb.getBytes();
    });
    return this.sendPacket(packet);
  }

  async sendChannelConfig(executeStimulation, channel, connector, points) {
    if (!Array.isArray(points) || points.length < 1 || points.length > 16) {
      throw new RangeError(`Low level channel config must have 1 to 16 points, got ${points?.length ?? 0}`);
    }
    const packet = new Packet(Commands.LOW_LEVEL_CHANNEL_CONFIG, () => {
      const bb = new ByteBuilder();
      bb.setBitToPosition(points.length - 1, 0, 4);
      bb.setBitToPosition(connector, 4, 1);
      bb.setBitToPosition(channel, 5, 2);
      bb.setBitToPosition(executeStimulation ? 1 : 0, 7, 1);
      for (const point of points) bb.appendBytes(point.getData());
      return bb.getBytes();
    });
    return this.sendPacket(packet);
  }

  async waitForChannelConfigAck(number = null, timeoutMs = 5000) {
    if (number == null) {
      const packet = this.packetBuffer.unhandledPackets.find((p) => p.command === Commands.LOW_LEVEL_CHANNEL_CONFIG_ACK);
      if (packet) return parseLowLevelChannelConfigAck(this.packetBuffer.unhandledPackets.splice(this.packetBuffer.unhandledPackets.indexOf(packet), 1)[0].payload);
      throw new ScienceModeError("No queued LOW_LEVEL_CHANNEL_CONFIG_ACK available. Pass packet.number to wait for a specific ack.");
    }
    const ack = await this.packetBuffer.waitFor(Commands.LOW_LEVEL_CHANNEL_CONFIG_ACK, number, timeoutMs);
    return parseLowLevelChannelConfigAck(ack.payload);
  }

  getQueuedPacket() { return this.packetBuffer.getPacketFromBuffer(); }
}

export function parseLowLevelChannelConfigAck(payload) {
  const bb = new ByteBuilder();
  bb.appendBytes(payload);
  const result = payload[0] ?? 0;
  const channel = bb.getBitFromPosition(8, 4);
  const connector = bb.getBitFromPosition(12, 4);
  const mode = payload[2] ?? LowLevelMode.NO_MEASUREMENT;
  const parsed = { result, resultName: resultName(result), channel, connector, mode };
  if (mode !== LowLevelMode.NO_MEASUREMENT && payload.length >= 5 + 128 * 2) {
    bb.swap(3, 2);
    parsed.samplingTimeMicroseconds = bb.getBitFromPosition(24, 16);
    parsed.measurementSamples = [];
    for (let index = 0; index < 128; index += 1) {
      bb.swap(5 + index * 2, 2);
      parsed.measurementSamples[index] = bb.getBitFromPosition(40 + index * 16, 16) / 100.0;
    }
  }
  return parsed;
}


export class MidLevelChannelConfiguration {
  constructor({ isActive = false, ramp = 0, periodMs = 20, points = [] } = {}) {
    this.isActive = Boolean(isActive);
    this.ramp = ramp;
    this.periodMs = periodMs;
    this.points = points;
  }

  getData() {
    if (!Array.isArray(this.points) || this.points.length < 1 || this.points.length > 16) {
      throw new RangeError(`Mid level channel configuration must have 1 to 16 points, got ${this.points?.length ?? 0}`);
    }
    if (this.ramp < 0 || this.ramp > 15) {
      throw new RangeError(`Mid level ramp must be between 0 and 15, got ${this.ramp}`);
    }
    if (this.periodMs < 0 || this.periodMs > 32767 * 4) {
      throw new RangeError(`Mid level period must be between 0 and 131071 ms, got ${this.periodMs}`);
    }

    const periodFactor = this.periodMs <= 32767 ? 2 : 4;
    const bb = new ByteBuilder();
    bb.setBitToPosition(this.ramp, 0, 4);
    bb.setBitToPosition(this.points.length - 1, 4, 4);
    bb.setBitToPosition(periodFactor === 2 ? 0 : 1, 8, 1);
    bb.setBitToPosition(Math.round(this.periodMs * periodFactor), 9, 15);
    bb.swap(1, 2);
    for (const point of this.points) bb.appendBytes(point.getData());
    return bb.getBytes();
  }
}

function parseSimpleResultAck(payload, packetName) {
  const resultError = payload?.[0] ?? ResultAndError.NO_ERROR;
  if (resultError !== ResultAndError.NO_ERROR) {
    throw new ScienceModeError(`Error ${packetName}: ${resultName(resultError)}`, { resultError, payload });
  }
  return { resultError, resultName: resultName(resultError) };
}

export class MidLevelLayer extends LayerBase {
  async init(doStopOnAllErrors = true) {
    const packet = new Packet(Commands.MID_LEVEL_INIT, () => {
      const bb = new ByteBuilder();
      bb.setBitToPosition(doStopOnAllErrors ? 1 : 0, 0, 1);
      return bb.getBytes();
    });
    const ack = await this.sendPacketAndWait(packet, 5000);
    return parseSimpleResultAck(ack.payload, "MidLevelInit");
  }

  async stop() {
    const ack = await this.sendPacketAndWait(new Packet(Commands.MID_LEVEL_STOP), 5000);
    return parseSimpleResultAck(ack.payload, "MidLevelStop");
  }

  async update(channelConfigurations) {
    if (!Array.isArray(channelConfigurations)) {
      throw new TypeError("channelConfigurations must be an array with up to 8 entries");
    }
    if (channelConfigurations.length > 8) {
      throw new RangeError("P24 mid level update supports up to 8 channels");
    }
    const normalized = Array.from({ length: 8 }, (_, index) => channelConfigurations[index] ?? null);
    const packet = new Packet(Commands.MID_LEVEL_UPDATE, () => {
      const out = [];
      let activeMask = 0;
      for (let index = 0; index < normalized.length; index += 1) {
        const cfg = normalized[index];
        if (cfg?.isActive) activeMask |= (1 << index);
      }
      out.push(activeMask & 0xFF);
      for (const cfg of normalized) {
        if (cfg?.isActive) out.push(...cfg.getData());
      }
      return new Uint8Array(out);
    });
    const ack = await this.sendPacketAndWait(packet, 5000);
    return parseSimpleResultAck(ack.payload, "MidLevelUpdate");
  }
}

export class DeviceP24 {
  constructor(transport, { debug = false } = {}) {
    this.transport = transport;
    this.packetBuffer = new PacketBuffer(transport, debug);
    this.packetNumberGenerator = new PacketNumberGenerator();
    this.general = new GeneralLayer(this.packetBuffer, this.packetNumberGenerator, debug);
    this.lowLevel = new LowLevelLayer(this.packetBuffer, this.packetNumberGenerator, debug);
    this.midLevel = new MidLevelLayer(this.packetBuffer, this.packetNumberGenerator, debug);
  }

  async initialize() {
    try {
      const status = await this.general.getStimStatus();
      if (status.stimStatus === StimStatus.LOW_LEVEL_INITIALIZED) await this.lowLevel.stop();
      // Mid-level stop is not implemented in this JS core yet.
    } catch (error) {
      // Some devices/firmware may not respond to status before init; continue to general init.
      if (this.packetBuffer.debug) console.warn("getStimStatus before initialize failed", error);
    }
    await this.general.initialize();
  }

  getLayerGeneral() { return this.general; }
  getLayerLowLevel() { return this.lowLevel; }
  getLayerMidLevel() { return this.midLevel; }
}

export class WebSerialTransport {
  constructor(options = {}) {
    this.options = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", ...options };
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.onBytes = null;
    this.reading = false;
  }

  static isSupported() { return typeof navigator !== "undefined" && "serial" in navigator; }

  async requestPort(filters = []) {
    if (!WebSerialTransport.isSupported()) throw new ScienceModeError("Web Serial API is not available in this browser/context");
    this.port = await navigator.serial.requestPort({ filters });
    return this.port;
  }

  async open(port = this.port) {
    if (!port) throw new ScienceModeError("No serial port selected");
    this.port = port;
    await this.port.open(this.options);
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.startReadLoop();
  }

  async write(bytes) {
    if (!this.writer) throw new ScienceModeError("Serial port is not open");
    await this.writer.write(bytes);
  }

  startReadLoop() {
    if (this.reading) return;
    this.reading = true;
    (async () => {
      try {
        while (this.reading && this.reader) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length && this.onBytes) this.onBytes(value);
        }
      } finally {
        this.reading = false;
      }
    })();
  }

  async close() {
    this.reading = false;
    if (this.reader) {
      try { await this.reader.cancel(); } catch {}
      try { this.reader.releaseLock(); } catch {}
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch {}
    }
    if (this.port) await this.port.close();
    this.reader = null;
    this.writer = null;
    this.port = null;
  }
}

export class WebUsbCdcAcmTransport {
  constructor({ baudRate = 115200, dataBits = 8, stopBits = 1, parity = "none", filters = null, packetSize = 64 } = {}) {
    this.options = { baudRate, dataBits, stopBits, parity, packetSize };
    this.filters = filters ?? [
      { vendorId: 0x0483, productId: 0x5740 },
      { vendorId: 0x0483 },
      { classCode: 0x02 },
      { classCode: 0x0a },
    ];
    this.device = null;
    this.configurationValue = null;
    this.controlInterfaceNumber = null;
    this.controlAlternateSetting = 0;
    this.dataInterfaceNumber = null;
    this.dataAlternateSetting = 0;
    this.inEndpointNumber = null;
    this.outEndpointNumber = null;
    this.inPacketSize = packetSize;
    this.onBytes = null;
    this.reading = false;
  }

  static isSupported() { return typeof navigator !== "undefined" && "usb" in navigator; }

  async requestDevice(filters = this.filters) {
    if (!WebUsbCdcAcmTransport.isSupported()) throw new ScienceModeError("WebUSB API is not available in this browser/context");
    this.device = await navigator.usb.requestDevice({ filters });
    return this.device;
  }

  async open(device = this.device) {
    if (!device) throw new ScienceModeError("No USB device selected");
    this.device = device;
    await this.device.open();

    if (this.device.configuration === null) {
      const configValue = this.device.configurations?.[0]?.configurationValue ?? 1;
      await this.device.selectConfiguration(configValue);
    }

    this.findCdcAcmInterfaces();

    if (this.dataInterfaceNumber === null) {
      throw new ScienceModeError("No CDC/ACM bulk data interface found on selected USB device");
    }

    // Claim data interface first because some Android stacks only expose the
    // bulk pair as the usable interface. Control interface is used if available.
    await this.device.claimInterface(this.dataInterfaceNumber);
    try { await this.device.selectAlternateInterface(this.dataInterfaceNumber, this.dataAlternateSetting); } catch {}

    if (this.controlInterfaceNumber !== null && this.controlInterfaceNumber !== this.dataInterfaceNumber) {
      try {
        await this.device.claimInterface(this.controlInterfaceNumber);
        try { await this.device.selectAlternateInterface(this.controlInterfaceNumber, this.controlAlternateSetting); } catch {}
      } catch (error) {
        // Keep going if data interface is usable; many CDC devices do not need
        // line coding to be set explicitly after enumeration.
        console.warn("Could not claim CDC control interface", error);
      }
    }

    try { await this.setLineCoding(); } catch (error) { console.warn("SET_LINE_CODING failed; continuing", error); }
    try { await this.setControlLineState(true, true); } catch (error) { console.warn("SET_CONTROL_LINE_STATE failed; continuing", error); }
    this.startReadLoop();
  }

  findCdcAcmInterfaces() {
    const configuration = this.device.configuration;
    if (!configuration) throw new ScienceModeError("USB device has no active configuration");
    this.configurationValue = configuration.configurationValue;

    let control = null;
    let data = null;

    for (const iface of configuration.interfaces) {
      for (const alt of iface.alternates) {
        const bulkIn = alt.endpoints.find((ep) => ep.type === "bulk" && ep.direction === "in");
        const bulkOut = alt.endpoints.find((ep) => ep.type === "bulk" && ep.direction === "out");
        if (!control && (alt.interfaceClass === 0x02 || alt.interfaceSubclass === 0x02)) control = { iface, alt };
        if (!data && alt.interfaceClass === 0x0a && bulkIn && bulkOut) data = { iface, alt, bulkIn, bulkOut };
      }
    }

    // Some CDC implementations expose only one interface or do not report class
    // codes as expected. Fall back to the first interface with a bulk IN/OUT pair.
    if (!data) {
      for (const iface of configuration.interfaces) {
        for (const alt of iface.alternates) {
          const bulkIn = alt.endpoints.find((ep) => ep.type === "bulk" && ep.direction === "in");
          const bulkOut = alt.endpoints.find((ep) => ep.type === "bulk" && ep.direction === "out");
          if (bulkIn && bulkOut) { data = { iface, alt, bulkIn, bulkOut }; break; }
        }
        if (data) break;
      }
    }

    if (!data) return;
    if (!control) control = data;

    this.controlInterfaceNumber = control.iface.interfaceNumber;
    this.controlAlternateSetting = control.alt.alternateSetting ?? 0;
    this.dataInterfaceNumber = data.iface.interfaceNumber;
    this.dataAlternateSetting = data.alt.alternateSetting ?? 0;
    this.inEndpointNumber = data.bulkIn.endpointNumber;
    this.outEndpointNumber = data.bulkOut.endpointNumber;
    this.inPacketSize = data.bulkIn.packetSize || this.options.packetSize || 64;
  }

  describeInterface() {
    return `config ${this.configurationValue}, ctl ${this.controlInterfaceNumber}, data ${this.dataInterfaceNumber}, IN ${this.inEndpointNumber}, OUT ${this.outEndpointNumber}`;
  }

  async setLineCoding() {
    const targetInterface = this.controlInterfaceNumber ?? this.dataInterfaceNumber;
    if (targetInterface === null) return;
    const data = new ArrayBuffer(7);
    const view = new DataView(data);
    view.setUint32(0, this.options.baudRate, true);
    view.setUint8(4, this.stopBitsToUsb(this.options.stopBits));
    view.setUint8(5, this.parityToUsb(this.options.parity));
    view.setUint8(6, this.options.dataBits);

    await this.device.controlTransferOut({
      requestType: "class",
      recipient: "interface",
      request: 0x20,
      value: 0,
      index: targetInterface,
    }, data);
  }

  async setControlLineState(dtr, rts) {
    const targetInterface = this.controlInterfaceNumber ?? this.dataInterfaceNumber;
    if (targetInterface === null) return;
    const value = (dtr ? 1 : 0) | (rts ? 2 : 0);
    await this.device.controlTransferOut({
      requestType: "class",
      recipient: "interface",
      request: 0x22,
      value,
      index: targetInterface,
    });
  }

  stopBitsToUsb(stopBits) {
    if (stopBits === 1) return 0;
    if (stopBits === 1.5) return 1;
    if (stopBits === 2) return 2;
    return 0;
  }

  parityToUsb(parity) {
    return ({ none: 0, odd: 1, even: 2, mark: 3, space: 4 })[String(parity).toLowerCase()] ?? 0;
  }

  async write(bytes) {
    if (!this.device || this.outEndpointNumber === null) throw new ScienceModeError("USB CDC/ACM device is not open");
    const result = await this.device.transferOut(this.outEndpointNumber, bytes);
    if (result.status === "stall") {
      await this.device.clearHalt("out", this.outEndpointNumber);
      throw new ScienceModeError("USB transferOut stalled; halt cleared, please retry");
    }
    if (result.status !== "ok") throw new ScienceModeError(`USB transferOut failed: ${result.status}`);
  }

  startReadLoop() {
    if (this.reading) return;
    this.reading = true;
    (async () => {
      try {
        while (this.reading && this.device?.opened && this.inEndpointNumber !== null) {
          const result = await this.device.transferIn(this.inEndpointNumber, this.inPacketSize || 64);
          if (result.status === "stall") {
            await this.device.clearHalt("in", this.inEndpointNumber);
            continue;
          }
          if (result.status !== "ok") continue;
          const data = result.data ? new Uint8Array(result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength)) : new Uint8Array();
          if (data.length && this.onBytes) this.onBytes(data);
        }
      } catch (error) {
        if (this.reading) console.error("WebUSB CDC/ACM read error", error);
      } finally {
        this.reading = false;
      }
    })();
  }

  async close() {
    this.reading = false;
    if (!this.device) return;

    try { if (this.controlInterfaceNumber !== null) await this.setControlLineState(false, false); } catch {}
    try { if (this.dataInterfaceNumber !== null) await this.device.releaseInterface(this.dataInterfaceNumber); } catch {}
    try {
      if (this.controlInterfaceNumber !== null && this.controlInterfaceNumber !== this.dataInterfaceNumber) {
        await this.device.releaseInterface(this.controlInterfaceNumber);
      }
    } catch {}
    try { if (this.device.opened) await this.device.close(); } catch {}

    this.device = null;
    this.controlInterfaceNumber = null;
    this.controlAlternateSetting = 0;
    this.dataInterfaceNumber = null;
    this.dataAlternateSetting = 0;
    this.inEndpointNumber = null;
    this.outEndpointNumber = null;
  }
}

export class NodeSerialTransport {
  constructor({ path, baudRate = 115200, SerialPortClass = null, ...rest } = {}) {
    this.path = path;
    this.options = { baudRate, ...rest };
    this.SerialPortClass = SerialPortClass;
    this.port = null;
    this.onBytes = null;
  }

  async open() {
    if (!this.SerialPortClass) throw new ScienceModeError("Pass SerialPortClass from the serialport package to NodeSerialTransport");
    this.port = new this.SerialPortClass({ path: this.path, autoOpen: false, ...this.options });
    await new Promise((resolve, reject) => this.port.open((err) => (err ? reject(err) : resolve())));
    this.port.on("data", (chunk) => { if (this.onBytes) this.onBytes(new Uint8Array(chunk)); });
  }

  async write(bytes) {
    if (!this.port?.isOpen) throw new ScienceModeError("Serial port is not open");
    await new Promise((resolve, reject) => {
      this.port.write(Buffer.from(bytes), (err) => {
        if (err) reject(err);
        else this.port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
      });
    });
  }

  async close() {
    if (!this.port?.isOpen) return;
    await new Promise((resolve, reject) => this.port.close((err) => (err ? reject(err) : resolve())));
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
