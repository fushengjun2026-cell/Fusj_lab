import test from 'node:test';
import assert from 'node:assert/strict';
import { RussianSpeechPlayer, speechSegments } from '../js/russian-speech-player.js';

function fixture() {
  let time = 0, nextId = 0;
  const timers = new Map(), spoken = [], states = [];
  const engine = { paused: false, cancels: 0, cancel() { this.cancels++; }, speak(value) { spoken.push(value); }, resume() { this.paused = false; } };
  const player = new RussianSpeechPlayer({ synthesis: engine, createUtterance: text => ({ text }), onChange: state => states.push(state), now: () => time,
    schedule(callback, delay) { const id = ++nextId; timers.set(id, { callback, time: time + delay }); return id; }, unschedule(id) { timers.delete(id); }
  });
  const options = { text: 'Один два три, четыре пять шесть.', source: 'sentence', voice: { lang: 'ru-RU' }, rate: 0.3 };
  return { player, engine, spoken, states, options, timers,
    run() { const entry = [...timers].sort((a,b) => a[1].time - b[1].time)[0]; assert.ok(entry, 'A playback task should be scheduled'); timers.delete(entry[0]); time = entry[1].time; entry[1].callback(); return spoken.at(-1); }
  };
}

test('Segmentation preserves the original text and limits position loss without word events', () => {
  const text = 'Привет, Анна! ' + 'слово '.repeat(30);
  const segments = speechSegments(text);
  assert.equal(segments.map(item => text.slice(item.start,item.end)).join(''), text);
  assert.ok(segments.every(item => text.slice(item.start,item.end).trim().split(/\s+/).length <= 12));
});

test('Pause before speech starts cancels the pending task and remains resumable', () => {
  const f = fixture(); f.player.play(f.options); assert.equal(f.player.state.phase, 'loading');
  f.player.toggle(f.options); assert.equal(f.player.state.phase, 'paused'); assert.equal(f.timers.size, 0); assert.equal(f.spoken.length, 0);
  f.player.toggle(f.options); const active = f.run(); active.onstart(); assert.equal(f.player.state.phase, 'playing'); assert.equal(active.rate, 0.3);
});

test('Replaying and then pausing ignores delayed start, end and error events from previous runs', () => {
  const f = fixture(); f.player.play(f.options); const old = f.run();
  const late = { start: old.onstart, end: old.onend, error: old.onerror, boundary: old.onboundary };
  old.onstart(); f.player.play(f.options); const current = f.run(); current.onstart();
  late.start(); late.end(); late.error({error:'interrupted'}); late.boundary({charIndex:8});
  assert.equal(f.player.state.phase,'playing'); assert.equal(f.player.state.position,0);
  f.player.pause(); assert.equal(f.player.state.phase,'paused');
  late.end(); assert.equal(f.player.state.phase,'paused');
  f.player.resume(); f.run().onstart(); assert.equal(f.player.state.phase,'playing');
});

test('Pause resumes at the current word instead of losing it, and natural completion advances phrases', () => {
  const f = fixture(); f.player.play(f.options); const first = f.run(); first.onstart(); first.onboundary({charIndex:5});
  f.player.pause(); assert.equal(f.player.state.position,5);
  f.player.resume(0.6); const resumed = f.run(); assert.equal(resumed.text,'два три, '); assert.equal(resumed.rate,0.6); resumed.onstart(); resumed.onend();
  const next = f.run(); assert.equal(next.text,'четыре пять шесть.'); next.onstart();
  // A device without word boundary events repeats only the current phrase.
  f.player.pause(); f.player.resume(); const repeat = f.run(); assert.equal(repeat.text,next.text); repeat.onstart(); repeat.onend();
  assert.equal(f.player.state.phase,'ended'); assert.equal(f.timers.size,0);
});

test('Rapid replays leave only one live task and stop cannot be undone by late callbacks', () => {
  const f = fixture(); for (let i = 0; i < 20; i++) f.player.play(f.options);
  assert.equal(f.timers.size,1); const active = f.run(); const lateStart = active.onstart, lateEnd = active.onend;
  f.player.stop(); lateStart(); lateEnd(); assert.equal(f.player.state.phase,'idle'); assert.equal(f.timers.size,0);
});

test('Changing source replaces paused playback and uses the selected speed', () => {
  const f = fixture(); f.player.play(f.options); f.run().onstart(); f.player.pause();
  const word = {...f.options,text:'Здравствуйте!',source:'word:hello',rate:0.8}; f.player.toggle(word); const active = f.run();
  assert.equal(active.text,word.text); assert.equal(active.rate,0.8); assert.equal(f.player.state.source,word.source);
});

test('An end event before start retries once without reporting a completed sentence', () => {
  const f = fixture(); f.player.play(f.options); f.run().onend(); assert.equal(f.player.state.phase,'loading');
  f.run().onend(); assert.equal(f.player.state.phase,'error'); assert.equal(f.timers.size,0);
});

test('A failed utterance retries once at the saved word, and errors remain restartable', () => {
  const f = fixture(); f.player.play(f.options); const first = f.run(); first.onstart(); first.onboundary({charIndex:5}); first.onerror();
  const retry = f.run(); assert.equal(retry.text,'два три, '); retry.onerror(); assert.equal(f.player.state.phase,'error');
  f.player.toggle(f.options); assert.equal(f.run().text,'Один два три, ');
});


test('A stalled voice startup becomes retryable rather than leaving an unresponsive player', () => {
  const f = fixture(); f.player.play(f.options); f.run(); // no start or error event
  f.run(); // startup timeout schedules a retry
  assert.equal(f.player.state.phase,'loading');
  f.run(); f.run(); // second missing start
  assert.equal(f.player.state.phase,'error'); assert.equal(f.timers.size,0);
});
