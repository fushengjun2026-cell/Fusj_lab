// Speech playback has one owner and one current run. Pausing cancels that run
// and keeps its word position; resuming submits the remaining phrase afresh.
// This avoids the platform pause/resume queue becoming stuck after a replay.
export function speechSegments(text, maxWords = 12) {
  const words = Array.from(text.matchAll(/[\p{L}\p{M}\p{N}]+/gu));
  if (!words.length) return [];
  const result = [];
  let start = 0, count = 0;
  for (let index = 0; index < words.length; index++) {
    const end = words[index + 1]?.index ?? text.length;
    const gap = text.slice(words[index].index + words[index][0].length, end);
    count++;
    if (count >= maxWords || /[,;:.!?…]/u.test(gap) || index === words.length - 1) {
      result.push({ start, end }); start = end; count = 0;
    }
  }
  return result;
}

export class RussianSpeechPlayer {
  constructor({ synthesis, createUtterance, onChange = () => {}, schedule = (callback, delay) => setTimeout(callback, delay), unschedule = id => clearTimeout(id), now = () => Date.now(), settleMs = 120, startupMs = 8000 }) {
    this.synthesis = synthesis;
    this.createUtterance = createUtterance;
    this.onChange = onChange;
    this.schedule = schedule;
    this.unschedule = unschedule;
    this.now = now;
    this.settleMs = settleMs; this.startupMs = startupMs;
    this.phase = 'idle';
    this.session = null;
    this.utterance = null;
    this.timer = null; this.startTimer = null;
    this.generation = 0;
    this.cancelledAt = -Infinity;
    this.error = '';
  }
  get voice() { return this.session?.voice || null; }
  get state() {
    return { phase: this.phase, source: this.session?.source || '', position: this.session?.position || 0, error: this.error };
  }
  notify() { this.onChange(this.state); }
  invalidate() {
    this.generation++;
    if (this.timer !== null) this.unschedule(this.timer);
    this.timer = null;
    if (this.startTimer !== null) this.unschedule(this.startTimer);
    this.startTimer = null;
    const old = this.utterance; this.utterance = null;
    if (old) for (const event of ['onstart', 'onboundary', 'onend', 'onerror']) old[event] = null;
    this.synthesis?.cancel();
    this.cancelledAt = this.now();
  }
  stop() {
    this.invalidate(); this.session = null; this.phase = 'idle'; this.error = ''; this.notify();
  }
  play({ text, source, voice, rate }) {
    this.invalidate();
    const segments = speechSegments(text);
    this.error = '';
    if (!segments.length) { this.session = null; this.phase = 'idle'; this.notify(); return; }
    this.session = { text, source, voice, rate, segments, index: 0, position: 0, retries: 0 };
    this.phase = 'loading'; this.notify(); this.queue();
  }
  toggle(options) {
    const same = this.session?.source === options.source && this.session?.text === options.text;
    if (!same || ['idle', 'ended', 'error'].includes(this.phase)) this.play(options);
    else if (this.phase === 'paused') this.resume(options.rate);
    else this.pause();
  }
  pause() {
    if (!['loading', 'playing'].includes(this.phase)) return;
    this.invalidate(); this.phase = 'paused'; this.notify();
  }
  resume(rate = this.session?.rate) {
    if (this.phase !== 'paused' || !this.session) return;
    this.session.rate = rate;
    this.phase = 'loading'; this.notify(); this.queue();
  }
  queue(delay = 0) {
    const generation = this.generation;
    const wait = Math.max(delay, this.settleMs - (this.now() - this.cancelledAt), 0);
    this.timer = this.schedule(() => {
      this.timer = null;
      if (generation !== this.generation || this.phase !== 'loading' || !this.session) return;
      this.submit(generation);
    }, wait);
  }
  submit(generation) {
    const session = this.session, segment = session.segments[session.index], start = session.position;
    let utterance;
    try {
      utterance = this.createUtterance(session.text.slice(start, segment.end));
      utterance.voice = session.voice; utterance.lang = session.voice.lang; utterance.rate = session.rate;
    } catch { this.fail('无法启动俄语朗读，请重试。'); return; }
    this.utterance = utterance;
    let started = false;
    const current = () => generation === this.generation && this.utterance === utterance && this.session === session && ['loading', 'playing'].includes(this.phase);
    utterance.onstart = () => {
      if (!current()) return;
      if (this.startTimer !== null) this.unschedule(this.startTimer); this.startTimer = null;
      started = true; this.phase = 'playing'; this.notify();
    };
    utterance.onboundary = event => {
      if (!current() || !Number.isInteger(event.charIndex) || event.charIndex < 0 || event.charIndex >= utterance.text.length) return;
      // Keep the word that is currently being read so a pause never skips a word.
      const absolute = start + event.charIndex;
      const words = Array.from(session.text.slice(segment.start, segment.end).matchAll(/[\p{L}\p{M}\p{N}]+/gu));
      const word = words.findLast(item => segment.start + item.index <= absolute);
      if (word) session.position = Math.max(session.position, segment.start + word.index);
    };
    utterance.onend = () => {
      if (!current()) return;
      if (!started) { this.retry('朗读没有正常启动，请重读。'); return; }
      this.utterance = null; session.position = segment.end; session.index++; session.retries = 0;
      if (session.index === session.segments.length) { this.phase = 'ended'; this.notify(); }
      else { this.phase = 'loading'; this.notify(); this.queue(25); }
    };
    utterance.onerror = () => { if (current()) this.retry('朗读中断，请重读。'); };
    try {
      // Clear any paused engine state inherited from an earlier page version.
      if (this.synthesis.paused) this.synthesis.resume();
      this.startTimer = this.schedule(() => { this.startTimer = null; if (current() && !started) this.retry('朗读未能启动，请重读。'); }, this.startupMs);
      this.synthesis.speak(utterance);
    } catch { this.retry('朗读暂不可用，请重试。'); }
  }
  retry(message) {
    if (!this.session) return;
    this.session.retries++;
    if (this.session.retries > 1) { this.fail(message); return; }
    this.invalidate(); this.phase = 'loading'; this.notify(); this.queue();
  }
  fail(message) {
    this.invalidate(); this.error = message; this.phase = 'error'; this.notify();
  }
}
