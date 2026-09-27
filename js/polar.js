/* Polar H10 über Web Bluetooth: EKG (Polar Measurement Data, PMD), Herzfrequenz/RR und Akku.
 *
 * Handler-Schnittstelle (identisch zu DemoSource):
 *   onEcg(samplesUv: Int32Array, info: { lost })
 *   onAcc(xyzMg: Int32Array [x0,y0,z0,x1,…], info: { fs })
 *   onHr({ hr, rr: number[] (ms), contact: true|false|null })
 *   onBattery(percent)
 *   onStatus(text)
 *   onDisconnect({ manual })
 */
(function (global) {
  'use strict';

  const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
  const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
  const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

  const ECG_FS = 130;
  const MEAS_ECG = 0x00;
  const MEAS_ACC = 0x02;
  const OP_START = 0x02;
  const OP_STOP = 0x03;
  const CONTROL_RESPONSE = 0xf0;

  // Start ECG: Samplerate (0x00) = 130 Hz, Auflösung (0x01) = 14 bit
  const CMD_START_ECG = [OP_START, MEAS_ECG, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00];
  const CMD_STOP_ECG = [OP_STOP, MEAS_ECG];
  // Start ACC: Samplerate (0x00), Auflösung (0x01) = 16 bit, Messbereich (0x02) = 2 g
  const cmdStartAcc = fs => [OP_START, MEAS_ACC, 0x00, 0x01, fs & 0xff, fs >> 8,
    0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x02, 0x00];
  const CMD_STOP_ACC = [OP_STOP, MEAS_ACC];
  const ACC_RATES = [25, 50, 100, 200];   // niedrigste zuerst – für die Atmung reicht wenig

  const PMD_ERRORS = {
    1: 'ungültiger Befehl',
    2: 'ungültiger Messtyp',
    3: 'nicht unterstützt',
    4: 'ungültige Länge',
    5: 'ungültiger Parameter',
    6: 'läuft bereits',
    7: 'ungültige Auflösung',
    8: 'ungültige Abtastrate',
    9: 'ungültiger Bereich',
    10: 'ungültige MTU',
    11: 'ungültige Kanalzahl',
    12: 'ungültiger Zustand',
    13: 'Gerät lädt'
  };
  const ERR_ALREADY_IN_STATE = 6;

  // ECG-Frame: [0]=Messtyp, [1..8]=Zeitstempel (ns, uint64 LE, letzter Sample),
  // [9]=Frame-Typ, danach je 3 Byte signed int24 LE in µV.
  function parseEcgFrame(dv) {
    if (dv.byteLength < 10 || dv.getUint8(0) !== MEAS_ECG) return null;
    const timestampNs = dv.getBigUint64(1, true);
    const frameType = dv.getUint8(9);
    if (frameType !== 0x00) return { timestampNs, frameType, samples: new Int32Array(0) };
    const n = Math.floor((dv.byteLength - 10) / 3);
    const samples = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const o = 10 + i * 3;
      let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
      if (v & 0x800000) v -= 0x1000000;
      samples[i] = v;
    }
    return { timestampNs, frameType, samples };
  }

  function readSigned(bytes, o, size) {
    let v = 0;
    for (let b = 0; b < size; b++) v |= bytes[o + b] << (8 * b);
    const bits = 8 * size;
    return bits < 32 && (v & (1 << (bits - 1))) ? v - (1 << bits) : v;
  }

  // Komprimierter Frame: Referenzwert je Kanal, danach Blöcke
  // [Bitbreite, Anzahl, Deltas (LSB zuerst, vorzeichenbehaftet)].
  function decodeDeltaFrame(bytes, offset, channels, refBytes) {
    let prev = [];
    for (let c = 0; c < channels; c++) prev.push(readSigned(bytes, offset + c * refBytes, refBytes));
    offset += channels * refBytes;
    const out = [...prev];
    while (offset + 2 <= bytes.length) {
      const size = bytes[offset], count = bytes[offset + 1];
      offset += 2;
      const byteLen = Math.ceil(size * count * channels / 8);
      if (offset + byteLen > bytes.length) break;
      let bit = 0;
      const readBits = () => {
        let v = 0;
        for (let b = 0; b < size; b++, bit++) v |= ((bytes[offset + (bit >> 3)] >> (bit & 7)) & 1) << b;
        return size && (v & (1 << (size - 1))) ? v - (1 << size) : v;
      };
      for (let s = 0; s < count; s++) {
        prev = prev.map(p => p + readBits());
        out.push(...prev);
      }
      offset += byteLen;
    }
    return Int32Array.from(out);
  }

  // ACC-Frame: [0]=0x02, [1..8]=Zeitstempel, [9]=Frame-Typ, danach x,y,z je Sample in mG.
  function parseAccFrame(dv) {
    if (dv.byteLength < 10 || dv.getUint8(0) !== MEAS_ACC) return null;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const frameType = dv.getUint8(9);
    if (frameType & 0x80) return { frameType, xyz: decodeDeltaFrame(bytes, 10, 3, 2) };
    const size = { 0: 1, 1: 2, 2: 3 }[frameType];
    if (!size) return { frameType, xyz: new Int32Array(0) };
    const n = Math.floor((bytes.length - 10) / size);
    const xyz = new Int32Array(n - (n % 3));
    for (let i = 0; i < xyz.length; i++) xyz[i] = readSigned(bytes, 10 + i * size, size);
    return { frameType, xyz };
  }

  // Standard Heart Rate Measurement (0x2A37)
  function parseHeartRate(dv) {
    const flags = dv.getUint8(0);
    let o = 1, hr;
    if (flags & 0x01) { hr = dv.getUint16(o, true); o += 2; } else { hr = dv.getUint8(o); o += 1; }
    const contact = (flags & 0x04) ? !!(flags & 0x02) : null;
    if (flags & 0x08) o += 2; // Energy Expended überspringen
    const rr = [];
    if (flags & 0x10) {
      for (; o + 1 < dv.byteLength; o += 2) rr.push(dv.getUint16(o, true) * 1000 / 1024);
    }
    return { hr, rr, contact };
  }

  function parseControlResponse(dv) {
    if (dv.byteLength < 4 || dv.getUint8(0) !== CONTROL_RESPONSE) return null;
    return { op: dv.getUint8(1), type: dv.getUint8(2), error: dv.getUint8(3) };
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class PolarH10Source {
    constructor(handlers) {
      this.h = handlers;
      this.fs = ECG_FS;
      this.device = null;
      this.name = 'Polar H10';
      this._pending = null;
      this._lastTs = null;
      this._manual = false;
      this._onControl = e => this._handleControl(e.target.value);
      this._onData = e => this._handleData(e.target.value);
      this._onHr = e => this.h.onHr(parseHeartRate(e.target.value));
      this._onBattery = e => this.h.onBattery(e.target.value.getUint8(0));
      this._onDisconnected = () => this._handleDisconnected();
    }

    static isSupported() {
      return !!(global.navigator && navigator.bluetooth && navigator.bluetooth.requestDevice);
    }

    async connect() {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Polar H10' }],
        optionalServices: [PMD_SERVICE, 'heart_rate', 'battery_service']
      });
      this.name = this.device.name || 'Polar H10';
      this.device.addEventListener('gattserverdisconnected', this._onDisconnected);
      await this._setup();
    }

    // Erneut mit dem bereits gewählten Gerät verbinden (ohne Auswahldialog).
    async reconnect(attempts = 3) {
      for (let i = 1; i <= attempts; i++) {
        try {
          this.h.onStatus(`Verbindung verloren – Versuch ${i}/${attempts} …`);
          await this._setup();
          return true;
        } catch (err) {
          console.warn('Reconnect fehlgeschlagen', err);
          await sleep(2000);
        }
      }
      return false;
    }

    async disconnect() {
      this._manual = true;
      try {
        if (this.device && this.device.gatt.connected) {
          if (this.accFs) await Promise.race([this._command(CMD_STOP_ACC), sleep(1000)]);
          await Promise.race([this._command(CMD_STOP_ECG), sleep(1000)]);
        }
      } catch (_) { /* Gurt evtl. schon weg */ }
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
      else this._handleDisconnected();
    }

    async _setup() {
      this._manual = false;
      this._lastTs = null;
      this.h.onStatus(`Verbinde mit ${this.name} …`);
      const server = await this.device.gatt.connect();

      // Einzeln nacheinander – parallele GATT-Operationen scheitern unter Windows gern.
      await this._setupHeartRate(server);
      await this._setupBattery(server);
      await this._startEcg(server);
      this.h.onStatus(`Verbunden: ${this.name}`);
    }

    async _setupHeartRate(server) {
      const svc = await server.getPrimaryService('heart_rate');
      const ch = await svc.getCharacteristic('heart_rate_measurement');
      ch.removeEventListener('characteristicvaluechanged', this._onHr);
      ch.addEventListener('characteristicvaluechanged', this._onHr);
      await ch.startNotifications();
    }

    async _setupBattery(server) {
      try {
        const svc = await server.getPrimaryService('battery_service');
        const ch = await svc.getCharacteristic('battery_level');
        this.h.onBattery((await ch.readValue()).getUint8(0));
        ch.removeEventListener('characteristicvaluechanged', this._onBattery);
        ch.addEventListener('characteristicvaluechanged', this._onBattery);
        await ch.startNotifications().catch(() => {});
      } catch (err) {
        console.warn('Akkustand nicht verfügbar', err);
      }
    }

    async _startEcg(server) {
      this.h.onStatus('Starte EKG-Übertragung …');
      const svc = await server.getPrimaryService(PMD_SERVICE);
      this.control = await svc.getCharacteristic(PMD_CONTROL);
      this.data = await svc.getCharacteristic(PMD_DATA);

      this.control.removeEventListener('characteristicvaluechanged', this._onControl);
      this.control.addEventListener('characteristicvaluechanged', this._onControl);
      await this.control.startNotifications();

      this.data.removeEventListener('characteristicvaluechanged', this._onData);
      this.data.addEventListener('characteristicvaluechanged', this._onData);
      await this.data.startNotifications();

      let resp = await this._command(CMD_START_ECG);
      if (resp.error === ERR_ALREADY_IN_STATE) {
        await this._command(CMD_STOP_ECG);
        resp = await this._command(CMD_START_ECG);
      }
      if (resp.error !== 0) {
        throw new Error(`EKG-Start abgelehnt: ${PMD_ERRORS[resp.error] || 'Fehler ' + resp.error}`);
      }
      await this._startAcc();
    }

    // Beschleunigungssensor für die Atmung – optional, das EKG läuft auch ohne.
    async _startAcc() {
      this.accFs = null;
      try {
        for (const fs of ACC_RATES) {
          let resp = await this._command(cmdStartAcc(fs));
          if (resp.error === ERR_ALREADY_IN_STATE) {
            await this._command(CMD_STOP_ACC);
            resp = await this._command(cmdStartAcc(fs));
          }
          if (resp.error === 0) { this.accFs = fs; return; }
          console.warn(`ACC ${fs} Hz abgelehnt: ${PMD_ERRORS[resp.error] || resp.error}`);
        }
      } catch (err) {
        console.warn('Beschleunigungssensor nicht verfügbar', err);
      }
    }

    _command(bytes) {
      const op = bytes[0];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending = null;
          reject(new Error('Keine Antwort vom Brustgurt.'));
        }, 5000);
        this._pending = { op, resolve: r => { clearTimeout(timer); resolve(r); } };
        const value = new Uint8Array(bytes);
        const write = this.control.writeValueWithResponse
          ? this.control.writeValueWithResponse(value)
          : this.control.writeValue(value);
        write.catch(err => { clearTimeout(timer); this._pending = null; reject(err); });
      });
    }

    _handleControl(dv) {
      const resp = parseControlResponse(dv);
      if (!resp || !this._pending || resp.op !== this._pending.op) return;
      const { resolve } = this._pending;
      this._pending = null;
      resolve(resp);
    }

    _handleData(dv) {
      if (dv.getUint8(0) === MEAS_ACC) {
        const acc = parseAccFrame(dv);
        if (!this._accLogged) {
          this._accLogged = true;
          console.info(`ACC: ${this.accFs} Hz, Frame-Typ 0x${acc.frameType.toString(16)}, ` +
            `${acc.xyz.length / 3} Werte/Paket, erster Wert`, Array.from(acc.xyz.slice(0, 3)));
        }
        if (acc.xyz.length && this.h.onAcc) this.h.onAcc(acc.xyz, { fs: this.accFs });
        return;
      }
      const frame = parseEcgFrame(dv);
      if (!frame || !frame.samples.length) return;
      let lost = 0;
      if (this._lastTs !== null) {
        const dtS = Number(frame.timestampNs - this._lastTs) / 1e9;
        const missing = Math.round(dtS * this.fs) - frame.samples.length;
        if (missing > 2) lost = missing;
      }
      this._lastTs = frame.timestampNs;
      this.h.onEcg(frame.samples, { lost });
    }

    _handleDisconnected() {
      this._pending = null;
      this.h.onDisconnect({ manual: this._manual });
    }
  }

  PolarH10Source.parseEcgFrame = parseEcgFrame;
  PolarH10Source.parseHeartRate = parseHeartRate;
  PolarH10Source.parseAccFrame = parseAccFrame;
  global.PolarH10Source = PolarH10Source;
})(window);
