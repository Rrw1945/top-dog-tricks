/**
 * Top Dog original procedural instrumental, composed here without samples,
 * recordings, or imported melodies. Generated locally; no music service needed.
 * 16-second C–Am–F–G arpeggio bed, with a quiet bass and soft sine harmonics.
 */
export function createBackgroundMusic(): Buffer {
  const rate = 24000;
  const seconds = 16;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  const chords = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]];
  const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const chord = chords[Math.floor(t / 4)]!;
    const local = t % 0.5;
    const note = chord[Math.floor(t / 0.5) % 4]!;
    const envelope = Math.min(local / 0.015, 1) * Math.exp(-7 * local) * Math.min((0.5 - local) / 0.03, 1);
    const tone = Math.sin(2 * Math.PI * hz(note) * local) + 0.2 * Math.sin(4 * Math.PI * hz(note) * local);
    const bassTime = t % 4;
    const bassEnvelope = Math.min(bassTime / 0.08, 1) * Math.min((4 - bassTime) / 0.08, 1);
    const sample = 0.22 * tone * envelope + 0.07 * Math.sin(2 * Math.PI * hz(chord[0]! - 12) * bassTime) * bassEnvelope;
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return wav;
}

export function replacementAudioFilter(duration: number, music: boolean): string {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid soundtrack duration');
  const voice = `[1:a]adelay=350|350,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=duration=${duration}`;
  if (!music) return `${voice}[aout]`;
  return `${voice}[voice];[2:a]volume=0.16,atrim=duration=${duration},afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, duration - 0.7)}:d=0.7[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`;
}
