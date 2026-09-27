import * as Speech from "expo-speech";

type Item = { text: string; priority: boolean };
/** One owner for synthesis, playback, cancellation and fallback. */
export class SpeechQueue {
  busy = false;
  endpoint = "";
  token = "";
  cloud = false;
  onMode: (mode: string) => void = () => {};
  private items: Item[] = [];
  private cancelCurrent: (() => void) | null = null;
  private generation = 0;

  enqueue(text: string, priority = false) {
    if (this.items.some(item => item.text === text)) return;
    if (priority) this.items.unshift({ text, priority });
    else this.items.push({ text, priority });
    this.items = this.items.slice(0, 3);
    if (!this.busy) void this.next();
  }

  stop() {
    this.generation++;
    this.items = [];
    this.cancelCurrent?.();
    this.cancelCurrent = null;
    this.busy = false;
    void Speech.stop().catch(() => {});
  }

  private async next() {
    const item = this.items.shift();
    if (!item) { this.busy = false; return; }
    this.busy = true;
    const generation = this.generation;
    try {
      if (!this.cloud || !this.endpoint) throw new Error("Device speech");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 4500);
      this.cancelCurrent = () => abort.abort();
      let response: Response;
      try {
        response = await fetch(`${this.endpoint}/speech`, {
          method: "POST", signal: abort.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ text: item.text.slice(0, 300) }),
        });
      } finally { clearTimeout(timer); }
      if (!response.ok) throw new Error("Speech unavailable");
      const { path } = await response.json();
      if (generation !== this.generation) return;
      // Lazy load lets older development builds use device speech until rebuilt.
      const audio: typeof import("expo-audio") = require("expo-audio");
      await audio.setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      if (generation !== this.generation) return;
      this.onMode("ElevenLabs");
      const player = audio.createAudioPlayer({ uri: `${this.endpoint}${path}`,
        headers: { Authorization: `Bearer ${this.token}` } }, { updateInterval: 100 });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearInterval(poll);
          try { player.remove(); } catch { /* Already released by native playback. */ }
          error ? reject(error) : resolve();
        };
        const timeout = setTimeout(() => finish(new Error("Playback timeout")), 30000);
        const poll = setInterval(() => {
          const status = player.currentStatus;
          if (status.error) finish(new Error(status.error));
          else if (status.didJustFinish) finish();
        }, 100);
        this.cancelCurrent = () => finish();
        try { player.play(); } catch { finish(new Error("Playback failed")); }
      });
    } catch {
      if (generation !== this.generation) return;
      this.onMode("Device voice");
      await new Promise<void>(resolve => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => { void Speech.stop().catch(() => {}); finish(); }, 30000);
        this.cancelCurrent = () => { void Speech.stop().catch(() => {}); finish(); };
        try { Speech.speak(item.text, { language: "en-US", onDone: finish, onStopped: finish, onError: finish }); }
        catch { finish(); }
      });
    }
    if (generation === this.generation) { this.cancelCurrent = null; void this.next(); }
  }
}
