// The background music plays (rendered to tests/output/music_preview.wav so you can listen to it).
const fs = require('fs');
module.exports = {
  title: 'background music renders',
  async run(t) {
    const p = await t.open({
      viewport: { width: 640, height: 360 },
      init: () => {
        // the game's AudioContext becomes an offline one so the music can be written to a file
        const SR = 44100, SECS = 24;
        window.AudioContext = class extends OfflineAudioContext { constructor() { super(2, SR * SECS, SR); window.__offline = this; } resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); } };
      },
    });
    const r = await p.evaluate(async () => {
      const A = window.__fitrunAudio; A.unlockAudio(); clearInterval(A.music.timer);
      const STEP = 60 / 124 / 4; let time = 0.05;
      for (const I of [0, 1, 2]) { A.music.setIntensity(I); for (let s = 0; s < 64; s++) { A.music.playStep(s, time); time += STEP; } }
      const buf = await window.__offline.startRendering();
      const ch = [buf.getChannelData(0), buf.getChannelData(1)], n = buf.length, out = new DataView(new ArrayBuffer(44 + n * 4));
      const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
      out.setUint32(24, 44100, true); out.setUint32(28, 44100 * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 4, true);
      let peak = 0;
      for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) { const v = Math.max(-1, Math.min(1, ch[c][i])); peak = Math.max(peak, Math.abs(v)); out.setInt16(44 + (i * 2 + c) * 2, v * 32767, true); }
      let s = ''; const u8 = new Uint8Array(out.buffer); for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return { peak, wav: btoa(s) };
    });
    fs.writeFileSync(t.outFile('preview.wav'), Buffer.from(r.wav, 'base64'));
    t.check('music is audible and not clipping', r.peak > 0.05 && r.peak <= 1, `peak ${r.peak.toFixed(3)}`);
  },
};
